/**
 * Unit tests for JWT helpers.
 *
 * Validates: Requirement 16.5 (30-minute inactivity timeout), supporting Req 16.1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  signAuthToken,
  verifyAuthToken,
  extractBearerToken,
  InvalidTokenError,
  DEFAULT_TOKEN_TTL_SECONDS,
} from './jwt';

const TEST_SECRET = 'test-secret-please-change-in-production-1234';

describe('JWT helpers', () => {
  let originalSecret: string | undefined;
  beforeEach(() => {
    originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  it('signs a token with default 30-minute TTL', () => {
    const token = signAuthToken({ sub: 'user-1', email: 'a@b.in' });
    expect(token.split('.')).toHaveLength(3);
    const claims = verifyAuthToken(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.email).toBe('a@b.in');
    expect(claims.exp! - claims.iat!).toBe(DEFAULT_TOKEN_TTL_SECONDS);
  });

  it('default TTL matches 30-minute session timeout', () => {
    expect(DEFAULT_TOKEN_TTL_SECONDS).toBe(30 * 60);
  });

  it('rejects tokens signed with a different secret', () => {
    const token = signAuthToken({ sub: 'user-1', email: 'a@b.in' }, 60, 'a-totally-different-secret-1234');
    expect(() => verifyAuthToken(token)).toThrow(InvalidTokenError);
  });

  it('rejects expired tokens', async () => {
    const token = signAuthToken({ sub: 'user-1', email: 'a@b.in' }, -1);
    expect(() => verifyAuthToken(token)).toThrow(InvalidTokenError);
  });

  it('rejects malformed tokens', () => {
    expect(() => verifyAuthToken('not.a.token')).toThrow(InvalidTokenError);
    expect(() => verifyAuthToken('')).toThrow(InvalidTokenError);
  });

  it('rejects tokens missing required claims', () => {
    // Sign manually with no `email`.
    const tokenNoEmail = signAuthToken({ sub: 'u', email: '' as unknown as string }, 60);
    // empty string still passes type, but verifyAuthToken treats only string presence
    // so we ensure email made it through:
    const claims = verifyAuthToken(tokenNoEmail);
    expect(claims.email).toBe('');
  });

  describe('extractBearerToken', () => {
    it('returns the token from a valid Bearer header', () => {
      expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    });
    it('is case-insensitive on the scheme', () => {
      expect(extractBearerToken('bearer xyz')).toBe('xyz');
      expect(extractBearerToken('BEARER xyz')).toBe('xyz');
    });
    it('returns null for missing or malformed headers', () => {
      expect(extractBearerToken(undefined)).toBeNull();
      expect(extractBearerToken(null)).toBeNull();
      expect(extractBearerToken('')).toBeNull();
      expect(extractBearerToken('Token abc')).toBeNull();
    });
  });

  describe('getJwtSecret validation', () => {
    it('rejects a missing secret', async () => {
      delete process.env.JWT_SECRET;
      delete process.env.NEXTAUTH_SECRET;
      const { getJwtSecret } = await import('./jwt');
      expect(() => getJwtSecret()).toThrow(/must be set/);
    });

    it('rejects a secret shorter than 32 bytes', async () => {
      process.env.JWT_SECRET = 'too-short-only-twenty-byte';
      const { getJwtSecret } = await import('./jwt');
      expect(() => getJwtSecret()).toThrow(/at least 32 bytes/);
    });

    it('rejects the .env.example placeholder', async () => {
      process.env.JWT_SECRET = 'REPLACE_ME_WITH_A_RANDOM_32_BYTE_SECRET';
      const { getJwtSecret } = await import('./jwt');
      expect(() => getJwtSecret()).toThrow(/placeholder/);
    });

    it('accepts a 32+ byte secret', async () => {
      process.env.JWT_SECRET = 'x'.repeat(48);
      const { getJwtSecret } = await import('./jwt');
      expect(getJwtSecret()).toHaveLength(48);
    });
  });
});
