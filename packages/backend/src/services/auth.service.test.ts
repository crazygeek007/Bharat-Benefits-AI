/**
 * Unit tests for AuthService.
 *
 * Uses an in-memory fake Prisma client and the InMemoryLockoutStore to
 * exercise the full register/login flow without requiring a database.
 *
 * Validates: Requirements 16.1, 16.2, 16.5, 16.8.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import {
  AuthService,
  AccountLockedError,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  WeakPasswordError,
} from './auth.service';
import { InMemoryLockoutStore, hashPassword, verifyAuthToken } from '../lib/auth';

interface FakeUser {
  id: string;
  email: string;
  passwordHash: string | null;
  authProvider: string;
  emailVerified: boolean;
  lastLogin: Date | null;
  sessionExpiresAt: Date | null;
  createdAt: Date;
}

/**
 * A minimal in-memory stand-in for `PrismaClient` exposing only the methods
 * AuthService consumes. Fields are kept loose to avoid pulling in the
 * generated Prisma types.
 */
function createFakeDb() {
  const users = new Map<string, FakeUser>();
  let counter = 0;
  return {
    user: {
      async findUnique({ where }: { where: { email?: string; id?: string } }): Promise<FakeUser | null> {
        if (where.email) {
          for (const u of users.values()) if (u.email === where.email) return u;
          return null;
        }
        if (where.id) return users.get(where.id) ?? null;
        return null;
      },
      async create({ data }: { data: Partial<FakeUser> & { email: string; passwordHash: string } }): Promise<FakeUser> {
        const id = `user-${++counter}`;
        const user: FakeUser = {
          id,
          email: data.email,
          passwordHash: data.passwordHash,
          authProvider: data.authProvider ?? 'credentials',
          emailVerified: false,
          lastLogin: null,
          sessionExpiresAt: null,
          createdAt: new Date(),
        };
        users.set(id, user);
        return user;
      },
      async update({ where, data }: { where: { id: string }; data: Partial<FakeUser> }): Promise<FakeUser> {
        const u = users.get(where.id);
        if (!u) throw new Error('not found');
        Object.assign(u, data);
        return u;
      },
    },
    _users: users,
  };
}

const VALID_PASSWORD = 'Str0ng!Pass';
const TEST_SECRET = 'test-secret-please-change-in-production-1234';

describe('AuthService', () => {
  let originalSecret: string | undefined;

  beforeAll(() => {
    originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
  });
  afterAll(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  let db: ReturnType<typeof createFakeDb>;
  let lockoutStore: InMemoryLockoutStore;
  let service: AuthService;

  beforeEach(() => {
    db = createFakeDb();
    lockoutStore = new InMemoryLockoutStore();
    service = new AuthService(db as never, lockoutStore);
  });

  describe('registerUser', () => {
    it('creates a user and returns a verifiable JWT', async () => {
      const result = await service.registerUser({
        email: 'Asha@Example.IN',
        password: VALID_PASSWORD,
      });
      expect(result.user.email).toBe('asha@example.in');
      expect(result.expiresInSeconds).toBe(30 * 60);
      const claims = verifyAuthToken(result.token);
      expect(claims.sub).toBe(result.user.id);
      expect(claims.email).toBe('asha@example.in');
    });

    it('rejects weak passwords with WeakPasswordError', async () => {
      await expect(
        service.registerUser({ email: 'a@b.in', password: 'weak' }),
      ).rejects.toBeInstanceOf(WeakPasswordError);
    });

    it('rejects duplicate emails', async () => {
      await service.registerUser({ email: 'a@b.in', password: VALID_PASSWORD });
      await expect(
        service.registerUser({ email: 'A@B.IN', password: VALID_PASSWORD }),
      ).rejects.toBeInstanceOf(EmailAlreadyRegisteredError);
    });

    it('rejects malformed emails', async () => {
      await expect(
        service.registerUser({ email: 'not-an-email', password: VALID_PASSWORD }),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });

  describe('loginUser', () => {
    beforeEach(async () => {
      await service.registerUser({ email: 'asha@example.in', password: VALID_PASSWORD });
    });

    it('issues a JWT for valid credentials', async () => {
      const result = await service.loginUser('asha@example.in', VALID_PASSWORD);
      expect(result.token).toBeTypeOf('string');
      const claims = verifyAuthToken(result.token);
      expect(claims.email).toBe('asha@example.in');
    });

    it('rejects invalid passwords with InvalidCredentialsError', async () => {
      await expect(service.loginUser('asha@example.in', 'Wrong!Pass1')).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    });

    it('rejects unknown emails with InvalidCredentialsError (no user enumeration)', async () => {
      await expect(service.loginUser('nobody@example.in', VALID_PASSWORD)).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    });

    it('locks the account after 5 consecutive failures and rejects further attempts', async () => {
      for (let i = 0; i < 4; i++) {
        await expect(service.loginUser('asha@example.in', 'Wrong!Pass1')).rejects.toBeInstanceOf(
          InvalidCredentialsError,
        );
      }
      // 5th failure should lock.
      await expect(service.loginUser('asha@example.in', 'Wrong!Pass1')).rejects.toBeInstanceOf(
        AccountLockedError,
      );
      // Even valid credentials are rejected while locked.
      await expect(service.loginUser('asha@example.in', VALID_PASSWORD)).rejects.toBeInstanceOf(
        AccountLockedError,
      );
    }, 30000);

    it('resets the failure counter on successful login', async () => {
      for (let i = 0; i < 3; i++) {
        await expect(service.loginUser('asha@example.in', 'Wrong!Pass1')).rejects.toBeInstanceOf(
          InvalidCredentialsError,
        );
      }
      await service.loginUser('asha@example.in', VALID_PASSWORD);
      // After success the counter is reset; another 4 failures should not lock.
      for (let i = 0; i < 4; i++) {
        await expect(service.loginUser('asha@example.in', 'Wrong!Pass1')).rejects.toBeInstanceOf(
          InvalidCredentialsError,
        );
      }
      const status = await service.getLockout().checkLock('asha@example.in');
      expect(status.locked).toBe(false);
    }, 30000);
  });

  describe('hashPassword', () => {
    it('produces hashes verifiable via bcrypt', async () => {
      const hash = await hashPassword(VALID_PASSWORD, 4);
      expect(hash.startsWith('$2')).toBe(true);
    });
  });

  describe('verifyJWT', () => {
    it('verifies a token issued by registerUser', async () => {
      const { token, user } = await service.registerUser({
        email: 'mehul@example.in',
        password: VALID_PASSWORD,
      });
      const claims = service.verifyJWT(token);
      expect(claims.sub).toBe(user.id);
    });

    it('rejects tampered tokens', async () => {
      const { token } = await service.registerUser({
        email: 'mehul@example.in',
        password: VALID_PASSWORD,
      });
      // Flip the last character of the signature.
      const tampered = token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a');
      expect(() => service.verifyJWT(tampered)).toThrow();
    });
  });
});
