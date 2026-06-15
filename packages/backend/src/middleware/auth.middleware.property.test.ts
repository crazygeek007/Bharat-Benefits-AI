/**
 * Property-based tests for the authentication guard middleware.
 *
 * **Property 24: Authentication Guard**
 * **Validates: Requirements 16.1**
 *
 * Property statement (from design.md):
 * "For any request to a personalized feature endpoint (User_Profile,
 * Benefits_Dashboard, saved Schemes) without a valid authentication token,
 * the system SHALL deny access and redirect to the login page."
 *
 * Backend APIs returning 401/403 satisfy "deny access". The redirect to
 * `/login` is performed client-side by the frontend, so we verify the deny
 * response here. The accompanying acceptance property confirms that valid
 * tokens are honoured (i.e. the guard does not over-deny).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import { authPlugin } from './auth.middleware';
import { signAuthToken } from '../lib/auth/jwt';

const TEST_SECRET = 'test-secret-please-change-in-production-1234';
const PROTECTED_PATHS = [
  '/api/profile',
  '/api/dashboard',
  '/api/saved-schemes',
] as const;
const PUBLIC_PATH = '/api/health';
const DENY_STATUSES = new Set([401, 403]);

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** A randomly generated, almost-certainly invalid bearer token. */
const arbGarbageBearer = fc
  .string({ minLength: 1, maxLength: 64 })
  .map((s) => `Bearer ${s}`);

/** A non-Bearer auth scheme (Basic, Token, random word) with a payload. */
const arbNonBearerScheme = fc
  .tuple(
    fc.constantFrom('Basic', 'Token', 'Digest', 'OAuth', 'Custom', 'NotBearer'),
    fc.string({ minLength: 1, maxLength: 32 }),
  )
  .map(([scheme, payload]) => `${scheme} ${payload}`);

/** A random non-empty string with no scheme prefix. */
const arbRawGarbage = fc.string({ minLength: 1, maxLength: 64 });

/** A JWT-shaped string (3 dot-separated base64-ish segments) with bad signature. */
const arbJwtShapedInvalid = fc
  .tuple(
    fc.string({ minLength: 4, maxLength: 16 }),
    fc.string({ minLength: 4, maxLength: 32 }),
    fc.string({ minLength: 4, maxLength: 32 }),
  )
  .map(([h, p, s]) => `Bearer ${h}.${p}.${s}`);

/** A real JWT with a valid signature but an `exp` already in the past. */
const arbExpiredBearer = fc
  .record({
    sub: fc.string({ minLength: 1, maxLength: 24 }),
    email: fc.string({ minLength: 3, maxLength: 32 }).map((s) => `${s}@example.in`),
    /** Seconds in the past; bounded so the token is unambiguously expired. */
    expiredBySeconds: fc.integer({ min: 1, max: 60 * 60 * 24 * 30 }),
  })
  .map(({ sub, email, expiredBySeconds }) => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      { sub, email, iat: now - expiredBySeconds - 1, exp: now - expiredBySeconds },
      TEST_SECRET,
      { algorithm: 'HS256' },
    );
    return `Bearer ${token}`;
  });

/** A JWT signed with the WRONG secret (looks valid, fails signature check). */
const arbWrongSecretBearer = fc
  .record({
    sub: fc.string({ minLength: 1, maxLength: 24 }),
    email: fc.string({ minLength: 3, maxLength: 32 }).map((s) => `${s}@example.in`),
  })
  .map(({ sub, email }) => {
    const token = jwt.sign(
      { sub, email },
      `${TEST_SECRET}-but-different-and-wrong`,
      { algorithm: 'HS256', expiresIn: 600 },
    );
    return `Bearer ${token}`;
  });

/**
 * Composite arbitrary: an invalid auth-header configuration. We model the
 * absence of the header by yielding `undefined`; callers convert that into
 * "do not send the header at all".
 */
type HeaderInjection = string | undefined;

const arbInvalidAuthHeader: fc.Arbitrary<HeaderInjection> = fc.oneof(
  fc.constant(undefined), // missing
  fc.constant(''), // empty
  arbNonBearerScheme,
  arbRawGarbage,
  arbGarbageBearer,
  arbJwtShapedInvalid,
  arbExpiredBearer,
  arbWrongSecretBearer,
);

const arbProtectedPath = fc.constantFrom(...PROTECTED_PATHS);

// ─── App fixture ─────────────────────────────────────────────────────────────

let app: FastifyInstance;
let originalSecret: string | undefined;

beforeAll(async () => {
  originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = TEST_SECRET;

  app = Fastify({ logger: false });
  await app.register(authPlugin);

  // Public sanity route — no `preHandler`.
  app.get(PUBLIC_PATH, async () => ({ ok: true }));

  // Three personalized-feature routes, each guarded by `app.authenticate`.
  for (const path of PROTECTED_PATHS) {
    app.get(path, { preHandler: app.authenticate }, async (req) => ({
      path,
      sub: req.user?.sub,
      email: req.user?.email,
    }));
  }

  await app.ready();
});

afterAll(async () => {
  await app?.close();
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 24: Authentication Guard', () => {
  // ── Deny property ──────────────────────────────────────────────────────────
  it('denies any request to a protected route without a valid auth token', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbProtectedPath,
        arbInvalidAuthHeader,
        async (path, headerValue) => {
          const headers: Record<string, string> =
            headerValue === undefined ? {} : { authorization: headerValue };

          const res = await app.inject({ method: 'GET', url: path, headers });

          // The response MUST be a deny (401 or 403), never a 2xx success.
          expect(DENY_STATUSES.has(res.statusCode)).toBe(true);
          // Belt-and-braces: explicitly forbid any 2xx from leaking through.
          expect(Math.floor(res.statusCode / 100)).not.toBe(2);

          // Response body MUST NOT echo claims that imply the request was
          // authenticated.
          const body = res.body ? safeParse(res.body) : null;
          if (body && typeof body === 'object') {
            expect((body as Record<string, unknown>).sub).toBeUndefined();
            expect((body as Record<string, unknown>).email).toBeUndefined();
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  // ── Public route sanity ────────────────────────────────────────────────────
  it('allows unauthenticated requests to the public route (sanity check)', async () => {
    const res = await app.inject({ method: 'GET', url: PUBLIC_PATH });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  // ── Acceptance property ────────────────────────────────────────────────────
  it('accepts requests bearing a valid JWT on every protected route', async () => {
    const arbValidClaims = fc.record({
      sub: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
      email: fc
        .string({ minLength: 3, maxLength: 32 })
        .map((s) => `${s.replace(/\s+/g, '_')}@example.in`),
    });

    await fc.assert(
      fc.asyncProperty(arbProtectedPath, arbValidClaims, async (path, claims) => {
        const token = signAuthToken(claims);
        const res = await app.inject({
          method: 'GET',
          url: path,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as Record<string, unknown>;
        expect(body.path).toBe(path);
        expect(body.sub).toBe(claims.sub);
        expect(body.email).toBe(claims.email);
      }),
      { numRuns: 50 },
    );
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
