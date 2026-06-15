/**
 * Account lockout tracker.
 *
 * Counts consecutive authentication failures per account identifier (email,
 * user id, etc.) and locks the account once the configured threshold is
 * reached. While locked, all login attempts are rejected without checking
 * credentials.
 *
 * Backed by a pluggable key/value store so the same logic can run against
 * Redis in production and against an in-memory fake in unit tests.
 *
 * Validates: Requirement 16.8 — 5 consecutive failed attempts → 15 minute lock.
 */

import {
  ACCOUNT_LOCKOUT_DURATION_MINUTES,
  ACCOUNT_LOCKOUT_THRESHOLD,
} from '@bharat-benefits/shared';

/** Minimal key/value store used by the lockout tracker. */
export interface LockoutStore {
  /** Returns the current attempt count, or 0 if no entry exists. */
  getCount(key: string): Promise<number>;
  /** Atomically increments the counter and returns the new value. */
  increment(key: string, ttlSeconds: number): Promise<number>;
  /** Removes the counter (typically on successful login). */
  reset(key: string): Promise<void>;
  /** Returns true if the lock entry exists. */
  isLocked(key: string): Promise<boolean>;
  /** Sets the lock entry with the configured TTL. */
  setLocked(key: string, ttlSeconds: number): Promise<void>;
  /** Returns remaining TTL in seconds for the lock entry, or 0 if not locked. */
  getLockTtl(key: string): Promise<number>;
}

/** In-memory implementation of LockoutStore. Suitable for tests. */
export class InMemoryLockoutStore implements LockoutStore {
  private readonly entries = new Map<string, { value: number; expiresAt: number }>();

  private now(): number {
    return Date.now();
  }

  private prune(key: string): void {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
    }
  }

  async getCount(key: string): Promise<number> {
    this.prune(key);
    return this.entries.get(key)?.value ?? 0;
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    this.prune(key);
    const existing = this.entries.get(key);
    const value = (existing?.value ?? 0) + 1;
    const expiresAt = existing?.expiresAt ?? this.now() + ttlSeconds * 1000;
    this.entries.set(key, { value, expiresAt });
    return value;
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async isLocked(key: string): Promise<boolean> {
    this.prune(key);
    return this.entries.has(key + ':lock');
  }

  async setLocked(key: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key + ':lock', {
      value: 1,
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }

  async getLockTtl(key: string): Promise<number> {
    this.prune(key + ':lock');
    const entry = this.entries.get(key + ':lock');
    if (!entry) return 0;
    return Math.max(0, Math.ceil((entry.expiresAt - this.now()) / 1000));
  }

  /** Removes all stored data — for test isolation. */
  clear(): void {
    this.entries.clear();
  }
}

/** Configuration for the lockout tracker. */
export interface LockoutConfig {
  /** Maximum number of consecutive failures before locking. */
  threshold: number;
  /** Lock duration in seconds. */
  lockDurationSeconds: number;
  /** Window during which failed attempts accumulate, in seconds. */
  attemptWindowSeconds: number;
  /** Optional namespace prefix for store keys. */
  keyPrefix?: string;
}

export const DEFAULT_LOCKOUT_CONFIG: LockoutConfig = {
  threshold: ACCOUNT_LOCKOUT_THRESHOLD,
  lockDurationSeconds: ACCOUNT_LOCKOUT_DURATION_MINUTES * 60,
  attemptWindowSeconds: ACCOUNT_LOCKOUT_DURATION_MINUTES * 60,
  keyPrefix: 'auth:lockout',
};

/** Result of attempting to record a failed login. */
export interface FailureResult {
  attempts: number;
  locked: boolean;
  lockTtlSeconds: number;
}

/** Result of checking lock status for an account. */
export interface LockStatus {
  locked: boolean;
  remainingSeconds: number;
}

/** Coordinates lockout state across attempts and locks. */
export class AccountLockout {
  constructor(
    private readonly store: LockoutStore,
    private readonly config: LockoutConfig = DEFAULT_LOCKOUT_CONFIG,
  ) {}

  private attemptKey(identifier: string): string {
    return `${this.config.keyPrefix ?? 'auth:lockout'}:attempts:${identifier.toLowerCase()}`;
  }

  private lockKey(identifier: string): string {
    return `${this.config.keyPrefix ?? 'auth:lockout'}:locked:${identifier.toLowerCase()}`;
  }

  /**
   * Returns the current lock status for an account without modifying state.
   * Use this before checking credentials to short-circuit when locked.
   */
  async checkLock(identifier: string): Promise<LockStatus> {
    const lockKey = this.lockKey(identifier);
    const locked = await this.store.isLocked(lockKey);
    if (!locked) return { locked: false, remainingSeconds: 0 };
    const remaining = await this.store.getLockTtl(lockKey);
    return { locked: true, remainingSeconds: remaining };
  }

  /**
   * Records a failed authentication attempt. Locks the account if the
   * threshold has been reached and returns the resulting state.
   */
  async recordFailure(identifier: string): Promise<FailureResult> {
    const attemptKey = this.attemptKey(identifier);
    const attempts = await this.store.increment(attemptKey, this.config.attemptWindowSeconds);

    if (attempts >= this.config.threshold) {
      const lockKey = this.lockKey(identifier);
      await this.store.setLocked(lockKey, this.config.lockDurationSeconds);
      // Reset the attempt counter so a new window starts after the lock expires.
      await this.store.reset(attemptKey);
      return {
        attempts,
        locked: true,
        lockTtlSeconds: this.config.lockDurationSeconds,
      };
    }

    return { attempts, locked: false, lockTtlSeconds: 0 };
  }

  /**
   * Records a successful authentication. Clears any existing failure counter
   * and lock. Should be invoked after credentials have been verified.
   */
  async recordSuccess(identifier: string): Promise<void> {
    await this.store.reset(this.attemptKey(identifier));
    await this.store.reset(this.lockKey(identifier));
  }
}

/**
 * Creates a `LockoutStore` backed by `ioredis`. Imported lazily so tests do not
 * require a Redis connection.
 */
export function createRedisLockoutStore(redis: import('ioredis').Redis): LockoutStore {
  return {
    async getCount(key) {
      const value = await redis.get(key);
      return value ? Number(value) : 0;
    },
    async increment(key, ttlSeconds) {
      const value = await redis.incr(key);
      if (value === 1) {
        await redis.expire(key, ttlSeconds);
      }
      return value;
    },
    async reset(key) {
      await redis.del(key);
    },
    async isLocked(key) {
      const exists = await redis.exists(key);
      return exists === 1;
    },
    async setLocked(key, ttlSeconds) {
      await redis.set(key, '1', 'EX', ttlSeconds);
    },
    async getLockTtl(key) {
      const ttl = await redis.ttl(key);
      return ttl > 0 ? ttl : 0;
    },
  };
}
