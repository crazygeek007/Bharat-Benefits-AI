/**
 * Fastify pre-handler enforcing administrator authorization (Requirement
 * 17.6). Composes with the existing `authenticate` hook — any route that
 * requires admin access should chain
 *   `[app.authenticate, requireAdmin(...)]`
 * so a missing/invalid token is rejected with 401 before the role check
 * runs, and an authenticated-but-unprivileged user is rejected with 403.
 *
 * The role lookup is performed against the `users` table by default so
 * tokens can't be forged to claim admin status. Lookups are cached in
 * Redis for {@link ADMIN_ROLE_CACHE_TTL_SECONDS} (30s) to keep the hot
 * admin-dashboard path off the database — short TTL means a role change
 * propagates quickly and a Redis outage harmlessly falls through to the
 * uncached path. Tests inject a custom resolver to bypass both layers.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

/** Fixed string identifying the admin role (matches the User.role column). */
export const ADMIN_ROLE = 'admin';

/**
 * TTL for the cached role lookup. 30 seconds is a sweet spot:
 *   - Short enough that role changes (promote / demote) propagate before
 *     the next call.
 *   - Long enough that a busy admin dashboard avoids paying the round
 *     trip on every request.
 */
export const ADMIN_ROLE_CACHE_TTL_SECONDS = 30;

const ADMIN_ROLE_CACHE_KEY_PREFIX = 'admin-role:';

/** Resolves the role of a user from their id. */
export type AdminRoleResolver = (userId: string) => Promise<string | null>;

/** Default resolver — looks up the user's role via Prisma. */
async function defaultAdminRoleResolver(userId: string): Promise<string | null> {
  const { default: prisma } = await import('../lib/prisma');
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  return user?.role ?? null;
}

/**
 * Cache wrapper: tries Redis first, falls back to `inner(userId)` on miss
 * or any Redis error. Misses are negative-cached as the empty string `""`
 * so a request flood for an unknown user-id can't grind the DB.
 */
function makeCachedResolver(inner: AdminRoleResolver): AdminRoleResolver {
  return async (userId) => {
    let redis: import('ioredis').default | null = null;
    try {
      const { getRedisClient } = await import('../lib/redis');
      redis = getRedisClient();
      const cached = await redis.get(ADMIN_ROLE_CACHE_KEY_PREFIX + userId);
      if (cached !== null) {
        return cached === '' ? null : cached;
      }
    } catch {
      // Redis unavailable — fall through to the uncached path. We never
      // fail the auth check because the cache is down.
      redis = null;
    }

    const role = await inner(userId);

    if (redis !== null) {
      try {
        // Negative-cache `null` as the empty string. Redis treats them
        // distinctly from `key not present`.
        await redis.set(
          ADMIN_ROLE_CACHE_KEY_PREFIX + userId,
          role ?? '',
          'EX',
          ADMIN_ROLE_CACHE_TTL_SECONDS,
        );
      } catch {
        // Best effort — don't fail the request because the cache write
        // failed.
      }
    }

    return role;
  };
}

export interface RequireAdminOptions {
  /**
   * Override the role resolver — primarily used by tests. When provided,
   * the Redis cache layer is bypassed entirely so test resolvers run
   * exactly as supplied.
   */
  resolveRole?: AdminRoleResolver;
}

/**
 * Returns a Fastify pre-handler that admits the request only when the
 * authenticated user has `role = "admin"`. Sends 401 when the request is
 * not authenticated, 403 when authenticated but unprivileged.
 */
export function requireAdmin(options: RequireAdminOptions = {}) {
  const resolveRole = options.resolveRole
    ? options.resolveRole
    : makeCachedResolver(defaultAdminRoleResolver);
  return async function adminPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const userId = request.user?.sub;
    if (!userId) {
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    let role: string | null;
    try {
      role = await resolveRole(userId);
    } catch (err) {
      request.log.error(
        { err, userId },
        'Failed to resolve user role for admin auth',
      );
      reply.code(503).send({
        error: 'ServiceUnavailable',
        message: 'Unable to verify administrator access right now',
      });
      return;
    }

    if (role !== ADMIN_ROLE) {
      reply.code(403).send({
        error: 'Forbidden',
        message: 'Administrator access required',
      });
      return;
    }
  };
}

/**
 * Invalidates the cached role for a user. Call this from any code path
 * that mutates `users.role` (e.g. an admin promoting / demoting another
 * user) so the change is visible without waiting for the cache TTL.
 */
export async function invalidateAdminRoleCache(userId: string): Promise<void> {
  try {
    const { getRedisClient } = await import('../lib/redis');
    const redis = getRedisClient();
    await redis.del(ADMIN_ROLE_CACHE_KEY_PREFIX + userId);
  } catch {
    // Best effort — the next request will simply see the stale value
    // for up to ADMIN_ROLE_CACHE_TTL_SECONDS, which is acceptable.
  }
}
