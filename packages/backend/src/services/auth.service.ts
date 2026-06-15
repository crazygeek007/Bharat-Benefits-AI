/**
 * AuthService — central entry point for credential-based authentication.
 *
 * Responsibilities:
 *   - Register new users with password policy enforcement (Req 16.2).
 *   - Authenticate users with bcrypt verification.
 *   - Coordinate the account lockout policy: 5 consecutive failures lock the
 *     account for 15 minutes (Req 16.8).
 *   - Issue JWT access tokens scoped to a 30-minute inactivity window so the
 *     frontend session can slide forward on activity (Req 16.5).
 *   - Verify access tokens for protected backend routes (Req 16.1).
 *
 * Encryption at rest for profile data (Req 16.3) is handled by
 * `lib/auth/encryption.ts` and is consumed by the profile service. TLS 1.2+
 * enforcement in transit (Req 16.4) lives in `app.ts` via security headers
 * and a TLS pre-handler.
 */

import {
  validatePassword as validatePasswordPolicy,
  type PasswordValidationResult,
} from '@bharat-benefits/shared';
import prisma from '../lib/prisma';
import {
  hashPassword,
  verifyPassword,
  signAuthToken,
  verifyAuthToken,
  type AuthTokenClaims,
  AccountLockout,
  DEFAULT_LOCKOUT_CONFIG,
  InMemoryLockoutStore,
  createRedisLockoutStore,
  type LockoutStore,
} from '../lib/auth';
import { getRedisClient } from '../lib/redis';

/** Input required to register a new user via the credentials provider. */
export interface RegisterInput {
  email: string;
  password: string;
  authProvider?: string;
}

/** Result returned to callers after a successful registration or login. */
export interface AuthResult {
  user: {
    id: string;
    email: string;
    authProvider: string;
    emailVerified: boolean;
  };
  token: string;
  /** Token lifetime in seconds (matches the inactivity timeout). */
  expiresInSeconds: number;
}

/** Thrown when a request fails password policy validation. */
export class WeakPasswordError extends Error {
  constructor(public readonly result: PasswordValidationResult) {
    super('Password does not meet policy requirements');
    this.name = 'WeakPasswordError';
  }
}

/** Thrown when an email is already registered. */
export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super('An account with this email already exists');
    this.name = 'EmailAlreadyRegisteredError';
  }
}

/** Thrown when login credentials don't match. Intentionally generic. */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

/** Thrown when an account is currently locked due to repeated failures. */
export class AccountLockedError extends Error {
  constructor(public readonly remainingSeconds: number) {
    super(`Account is locked for ${remainingSeconds} more seconds`);
    this.name = 'AccountLockedError';
  }
}

/**
 * Normalises an email for lookups and key derivation. We treat emails as
 * case-insensitive and trim surrounding whitespace.
 */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthService {
  private readonly lockout: AccountLockout;

  constructor(
    private readonly db = prisma,
    lockoutStore?: LockoutStore,
  ) {
    const store = lockoutStore ?? this.defaultLockoutStore();
    this.lockout = new AccountLockout(store, DEFAULT_LOCKOUT_CONFIG);
  }

  /**
   * Resolves a default lockout store. Prefers Redis when reachable, falls back
   * to an in-memory store when Redis is unavailable (e.g. local dev without
   * Redis running, unit tests). The fallback is logged via console.warn.
   */
  private defaultLockoutStore(): LockoutStore {
    try {
      return createRedisLockoutStore(getRedisClient());
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      console.warn(
        `AuthService: falling back to in-memory lockout store (Redis unavailable: ${reason})`,
      );
      return new InMemoryLockoutStore();
    }
  }

  /**
   * Registers a new user with email/password credentials. Enforces the
   * platform password policy (Req 16.2) and rejects duplicate emails.
   */
  async registerUser(input: RegisterInput): Promise<AuthResult> {
    const email = normaliseEmail(input.email);
    if (!EMAIL_REGEX.test(email)) {
      throw new TypeError('A valid email address is required');
    }

    const validation = this.validatePassword(input.password);
    if (!validation.valid) {
      throw new WeakPasswordError(validation);
    }

    const existing = await this.db.user.findUnique({ where: { email } });
    if (existing) {
      throw new EmailAlreadyRegisteredError();
    }

    const passwordHash = await hashPassword(input.password);
    const created = await this.db.user.create({
      data: {
        email,
        passwordHash,
        authProvider: input.authProvider ?? 'credentials',
      },
    });

    return this.issueResult(created);
  }

  /**
   * Authenticates a user by email + password. Increments the lockout counter
   * on failure and resets it on success. Throws `AccountLockedError` while a
   * lock is active (Req 16.8).
   */
  async loginUser(email: string, password: string): Promise<AuthResult> {
    const normalisedEmail = normaliseEmail(email);

    const lockStatus = await this.lockout.checkLock(normalisedEmail);
    if (lockStatus.locked) {
      throw new AccountLockedError(lockStatus.remainingSeconds);
    }

    const user = await this.db.user.findUnique({ where: { email: normalisedEmail } });

    // Always perform a constant-time comparison to avoid leaking whether the
    // email exists. We hash a dummy value when the user is missing.
    const hash = user?.passwordHash ?? '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidu';
    const ok = user ? await verifyPassword(password, hash) : false;
    // Force a verifyPassword call even for missing users to equalise timing.
    if (!user) await verifyPassword(password, hash);

    if (!ok || !user) {
      const failure = await this.lockout.recordFailure(normalisedEmail);
      if (failure.locked) {
        throw new AccountLockedError(failure.lockTtlSeconds);
      }
      throw new InvalidCredentialsError();
    }

    await this.lockout.recordSuccess(normalisedEmail);

    await this.db.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    return this.issueResult(user);
  }

  /** Hashes a password using the configured bcrypt rounds. */
  hashPassword(plaintext: string): Promise<string> {
    return hashPassword(plaintext);
  }

  /** Validates a candidate password against the platform policy. */
  validatePassword(password: unknown): PasswordValidationResult {
    return validatePasswordPolicy(password);
  }

  /** Verifies a JWT and returns its claims. Throws `InvalidTokenError` on failure. */
  verifyJWT(token: string): AuthTokenClaims {
    return verifyAuthToken(token);
  }

  /**
   * Returns the underlying lockout coordinator. Exposed to allow ops/admin
   * tooling (e.g. an admin "unlock account" action) to interact with the
   * tracker without re-implementing the contract.
   */
  getLockout(): AccountLockout {
    return this.lockout;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private issueResult(user: {
    id: string;
    email: string;
    authProvider: string;
    emailVerified: boolean;
  }): AuthResult {
    const token = signAuthToken({
      sub: user.id,
      email: user.email,
      authProvider: user.authProvider,
    });
    return {
      user: {
        id: user.id,
        email: user.email,
        authProvider: user.authProvider,
        emailVerified: user.emailVerified,
      },
      token,
      expiresInSeconds: 30 * 60,
    };
  }
}

/** Default singleton suitable for HTTP handlers. */
export const authService = new AuthService();
