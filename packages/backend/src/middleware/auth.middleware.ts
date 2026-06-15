/**
 * Fastify authentication middleware.
 *
 * Provides:
 *   - `authenticate` — a `preHandler` that requires a valid JWT, attaching
 *     decoded claims to `request.user`. Returns HTTP 401 with no body for
 *     missing/invalid tokens (the frontend redirects to `/login`).
 *   - `requireAuth` plugin — registers the hook and a typed `request.user`
 *     declaration so route handlers can access claims with full typing.
 *
 * Validates: Requirement 16.1 (Authentication Guard).
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import fp from 'fastify-plugin';
import {
  extractBearerToken,
  InvalidTokenError,
  type AuthTokenClaims,
  verifyAuthToken,
} from '../lib/auth/jwt';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Decoded auth claims, populated by `authenticate`. `undefined` for
     * unauthenticated requests on routes that don't require auth.
     */
    user?: AuthTokenClaims;
  }
}

/**
 * Standard 401 response body. The frontend interprets this as "redirect to
 * /login". Message intentionally generic to avoid leaking auth state.
 */
const UNAUTHORIZED_BODY = {
  error: 'Unauthorized',
  message: 'Authentication required',
} as const;

function readTokenFromRequest(request: FastifyRequest): string | null {
  const headerValue = request.headers.authorization;
  if (typeof headerValue === 'string') {
    const bearer = extractBearerToken(headerValue);
    if (bearer) return bearer;
  }
  // Allow NextAuth-style cookie session tokens to be forwarded verbatim
  // (NextAuth signs JWTs with the same secret when sessions.strategy === 'jwt').
  const cookie = request.headers.cookie;
  if (typeof cookie === 'string') {
    const match = /(?:^|;\s*)(?:next-auth\.session-token|__Secure-next-auth\.session-token)=([^;]+)/.exec(
      cookie,
    );
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

/**
 * Fastify `preHandler` that requires a valid JWT. Sends 401 and short-circuits
 * the request when the token is missing or invalid.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = readTokenFromRequest(request);
  if (!token) {
    reply.code(401).send(UNAUTHORIZED_BODY);
    return;
  }
  try {
    const claims = verifyAuthToken(token);
    request.user = claims;
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      reply.code(401).send(UNAUTHORIZED_BODY);
      return;
    }
    throw err;
  }
}

/**
 * Fastify plugin that decorates the instance with `authenticate`. Register
 * this once at application startup, then mark protected routes by adding
 * `{ preHandler: app.authenticate }` to their options.
 *
 * Wrapped with `fastify-plugin` so the decorator escapes the plugin scope and
 * is available on the parent app instance.
 */
const authPluginCallback: FastifyPluginCallback = (app, _opts, done) => {
  if (!app.hasDecorator('authenticate')) {
    app.decorate('authenticate', authenticate);
  }
  done();
};

export const authPlugin = fp(authPluginCallback, {
  name: 'auth-plugin',
  fastify: '4.x',
});

declare module 'fastify' {
  interface FastifyInstance {
    /** Registered by `authPlugin`; convenience for protected route handlers. */
    authenticate: typeof authenticate;
  }
}

/** Convenience helper to register the plugin on an app instance. */
export function registerAuthMiddleware(app: FastifyInstance): void {
  if (!app.hasDecorator('authenticate')) {
    app.register(authPlugin);
  }
}
