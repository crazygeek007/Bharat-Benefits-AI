/**
 * Unit tests for the JWT auth middleware.
 *
 * Validates: Requirement 16.1 — protected endpoints reject requests without
 * a valid token.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { authPlugin } from './auth.middleware';
import { signAuthToken } from '../lib/auth/jwt';

const TEST_SECRET = 'test-secret-please-change-in-production-1234';

describe('auth middleware', () => {
  let originalSecret: string | undefined;
  let app: FastifyInstance;

  beforeAll(() => {
    originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
  });
  afterAll(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    app.get('/protected', { preHandler: app.authenticate }, async (req) => ({
      sub: req.user?.sub,
      email: req.user?.email,
    }));
    app.get('/public', async () => ({ ok: true }));
    await app.ready();
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for malformed Authorization header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'NotBearer abc' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for invalid tokens', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer not.a.real.token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for expired tokens', async () => {
    const expired = signAuthToken({ sub: 'user-1', email: 'a@b.in' }, -1);
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows access with a valid token and exposes claims on request.user', async () => {
    const token = signAuthToken({ sub: 'user-42', email: 'asha@example.in' });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sub: 'user-42', email: 'asha@example.in' });
  });

  it('does not affect public routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/public' });
    expect(res.statusCode).toBe(200);
  });

  it('accepts a NextAuth session-token cookie', async () => {
    const token = signAuthToken({ sub: 'user-99', email: 'b@c.in' });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: `next-auth.session-token=${encodeURIComponent(token)}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
