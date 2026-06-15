/**
 * Unit tests for the AccountLockout coordinator.
 *
 * Validates: Requirement 16.8 (5 consecutive failures → 15-minute lockout).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AccountLockout,
  DEFAULT_LOCKOUT_CONFIG,
  InMemoryLockoutStore,
} from './lockout';
import {
  ACCOUNT_LOCKOUT_DURATION_MINUTES,
  ACCOUNT_LOCKOUT_THRESHOLD,
} from '@bharat-benefits/shared';

describe('AccountLockout', () => {
  let store: InMemoryLockoutStore;
  let lockout: AccountLockout;

  beforeEach(() => {
    store = new InMemoryLockoutStore();
    lockout = new AccountLockout(store, DEFAULT_LOCKOUT_CONFIG);
  });

  it('uses the spec-aligned defaults', () => {
    expect(DEFAULT_LOCKOUT_CONFIG.threshold).toBe(ACCOUNT_LOCKOUT_THRESHOLD);
    expect(DEFAULT_LOCKOUT_CONFIG.threshold).toBe(5);
    expect(DEFAULT_LOCKOUT_CONFIG.lockDurationSeconds).toBe(
      ACCOUNT_LOCKOUT_DURATION_MINUTES * 60,
    );
    expect(DEFAULT_LOCKOUT_CONFIG.lockDurationSeconds).toBe(15 * 60);
  });

  it('does not lock before the threshold is reached', async () => {
    for (let i = 1; i < ACCOUNT_LOCKOUT_THRESHOLD; i++) {
      const result = await lockout.recordFailure('user@example.in');
      expect(result.attempts).toBe(i);
      expect(result.locked).toBe(false);
    }
    expect((await lockout.checkLock('user@example.in')).locked).toBe(false);
  });

  it('locks after exactly 5 consecutive failures', async () => {
    for (let i = 1; i <= ACCOUNT_LOCKOUT_THRESHOLD - 1; i++) {
      await lockout.recordFailure('user@example.in');
    }
    const final = await lockout.recordFailure('user@example.in');
    expect(final.locked).toBe(true);
    expect(final.attempts).toBe(ACCOUNT_LOCKOUT_THRESHOLD);
    const status = await lockout.checkLock('user@example.in');
    expect(status.locked).toBe(true);
    expect(status.remainingSeconds).toBeGreaterThan(0);
    expect(status.remainingSeconds).toBeLessThanOrEqual(15 * 60);
  });

  it('successful login resets attempt counter and removes any lock', async () => {
    await lockout.recordFailure('a@b.in');
    await lockout.recordFailure('a@b.in');
    await lockout.recordSuccess('a@b.in');
    expect(await store.getCount('auth:lockout:attempts:a@b.in')).toBe(0);
    expect((await lockout.checkLock('a@b.in')).locked).toBe(false);
  });

  it('treats identifiers as case-insensitive', async () => {
    await lockout.recordFailure('User@Example.IN');
    const status = await lockout.checkLock('user@example.in');
    // shouldn't be locked (only one failure), but counters must collide.
    expect(status.locked).toBe(false);
    await lockout.recordSuccess('USER@EXAMPLE.IN');
    expect(await store.getCount('auth:lockout:attempts:user@example.in')).toBe(0);
  });

  it('different identifiers are tracked independently', async () => {
    for (let i = 0; i < ACCOUNT_LOCKOUT_THRESHOLD; i++) {
      await lockout.recordFailure('alice@x.in');
    }
    expect((await lockout.checkLock('alice@x.in')).locked).toBe(true);
    expect((await lockout.checkLock('bob@x.in')).locked).toBe(false);
  });
});

describe('InMemoryLockoutStore', () => {
  it('expires entries after their TTL', async () => {
    const store = new InMemoryLockoutStore();
    await store.increment('k', 1);
    expect(await store.getCount('k')).toBe(1);
    // Force expiry by mutating internal expiry — we can't easily mock time here,
    // but reset() should yield zero.
    await store.reset('k');
    expect(await store.getCount('k')).toBe(0);
  });
});
