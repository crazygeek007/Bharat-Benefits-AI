/**
 * Unit tests for password hashing helpers.
 */

import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, DEFAULT_BCRYPT_ROUNDS } from './password';

describe('hashPassword / verifyPassword', () => {
  it('produces a verifiable hash for a valid password', async () => {
    const hash = await hashPassword('Str0ng!Pass', 4); // low rounds for fast tests
    expect(hash).toBeTypeOf('string');
    expect(hash).not.toBe('Str0ng!Pass');
    expect(await verifyPassword('Str0ng!Pass', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('Str0ng!Pass', 4);
    expect(await verifyPassword('Str0ng!Pas', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('returns false for malformed hashes', async () => {
    expect(await verifyPassword('whatever', '')).toBe(false);
    expect(await verifyPassword('whatever', 'not-a-bcrypt-hash')).toBe(false);
  });

  it('rejects non-string inputs to hashPassword', async () => {
    await expect(hashPassword('', 4)).rejects.toBeInstanceOf(TypeError);
    // @ts-expect-error verifying runtime guard
    await expect(hashPassword(undefined, 4)).rejects.toBeInstanceOf(TypeError);
  });

  it('default cost factor is at least 10', () => {
    expect(DEFAULT_BCRYPT_ROUNDS).toBeGreaterThanOrEqual(10);
  });
});
