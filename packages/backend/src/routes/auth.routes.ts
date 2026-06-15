/**
 * HTTP routes for credential-based authentication.
 *
 * Registers `/auth/register` and `/auth/login` against the supplied Fastify
 * instance. Both routes delegate to `AuthService`. Errors are mapped to
 * appropriate status codes:
 *   - 400: request payload missing / malformed
 *   - 401: invalid credentials
 *   - 409: email already registered
 *   - 422: weak password (with policy errors in the body)
 *   - 423: account locked, with `retryAfterSeconds` in the body
 *
 * These routes are consumed by NextAuth.js (frontend) when authenticating via
 * the credentials provider.
 */

import type { FastifyInstance } from 'fastify';
import {
  AccountLockedError,
  AuthService,
  authService as defaultService,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  WeakPasswordError,
} from '../services/auth.service';
import { CredentialsSchema } from '../schemas/auth.schemas';
import { parseOrReply } from '../lib/validation';

export interface RegisterAuthRoutesOptions {
  /** Override the AuthService instance — useful for tests. */
  authService?: AuthService;
}

/**
 * Per-route rate-limit overrides for credential endpoints.
 *
 * Login/register are the prime targets for credential stuffing and account
 * enumeration. Account-level lockout (5 failures → 15 min) protects a
 * specific account, but does nothing against an attacker hammering many
 * accounts from one IP. These per-IP rate limits add the missing
 * dimension. Numbers are conservative — legitimate users only hit the
 * endpoint a handful of times even on a bad day.
 *
 * The values are read by `@fastify/rate-limit` via the `config.rateLimit`
 * route option. When the plugin isn't registered (e.g. narrow unit tests)
 * the option is harmlessly ignored.
 */
const LOGIN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;
const REGISTER_RATE_LIMIT = { max: 5, timeWindow: '1 minute' } as const;

export function registerAuthRoutes(
  app: FastifyInstance,
  options: RegisterAuthRoutesOptions = {},
): void {
  const service = options.authService ?? defaultService;

  app.post(
    '/auth/register',
    { config: { rateLimit: REGISTER_RATE_LIMIT } },
    async (request, reply) => {
    const parsed = parseOrReply(CredentialsSchema, request.body, reply);
    if (!parsed) return reply;
    const creds = parsed.data;
    try {
      const result = await service.registerUser(creds);
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof WeakPasswordError) {
        return reply.code(422).send({
          error: 'WeakPassword',
          message: err.message,
          violations: err.result.errors,
        });
      }
      if (err instanceof EmailAlreadyRegisteredError) {
        return reply.code(409).send({ error: 'EmailAlreadyRegistered', message: err.message });
      }
      if (err instanceof TypeError) {
        return reply.code(400).send({ error: 'BadRequest', message: err.message });
      }
      throw err;
    }
  });

  app.post(
    '/auth/login',
    { config: { rateLimit: LOGIN_RATE_LIMIT } },
    async (request, reply) => {
    const parsed = parseOrReply(CredentialsSchema, request.body, reply);
    if (!parsed) return reply;
    const creds = parsed.data;
    try {
      const result = await service.loginUser(creds.email, creds.password);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        return reply.code(401).send({ error: 'InvalidCredentials', message: err.message });
      }
      if (err instanceof AccountLockedError) {
        return reply
          .code(423)
          .send({
            error: 'AccountLocked',
            message: err.message,
            retryAfterSeconds: err.remainingSeconds,
          });
      }
      throw err;
    }
  });
}
