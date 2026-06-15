/**
 * Audit Logging Middleware for Fastify
 *
 * Automatically logs profile data access and modifications for relevant routes.
 * Intercepts requests to profile-related endpoints and records audit entries.
 *
 * Retention: Logs are retained for a minimum of 365 days (no auto-deletion).
 *
 * Validates: Requirement 16.6
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logAction } from '../services/audit.service';

/** Route patterns that trigger audit logging for profile data */
const PROFILE_ROUTE_PATTERNS = [
  '/api/profile',
  '/api/profiles',
  '/api/user/profile',
  '/api/users/profile',
];

/** HTTP methods mapped to audit action descriptions */
const METHOD_ACTION_MAP: Record<string, string> = {
  GET: 'profile.read',
  POST: 'profile.create',
  PUT: 'profile.update',
  PATCH: 'profile.update',
  DELETE: 'profile.delete',
};

/**
 * Determines whether a request URL targets a profile-related endpoint.
 */
function isProfileRoute(url: string): boolean {
  const path = url.split('?')[0].toLowerCase();
  return PROFILE_ROUTE_PATTERNS.some(
    (pattern) => path === pattern || path.startsWith(pattern + '/')
  );
}

/**
 * Extracts the user ID from the request. Looks at common auth patterns.
 */
function extractUserId(request: FastifyRequest): string | null {
  // Check request user object (set by auth middleware)
  const user = (request as unknown as { user?: { id?: string; userId?: string; sub?: string } })
    .user;
  if (user?.id) return user.id;
  if (user?.userId) return user.userId;
  if (user?.sub) return user.sub;

  // Check headers for user identity
  const userIdHeader = request.headers['x-user-id'];
  if (typeof userIdHeader === 'string') return userIdHeader;

  return null;
}

/**
 * Extracts actor identity (who performed the action).
 * This could be the user themselves, an admin, or a system process.
 */
function extractActorIdentity(request: FastifyRequest): string {
  // Check for admin identity
  const adminHeader = request.headers['x-admin-identity'];
  if (typeof adminHeader === 'string') return adminHeader;

  // Check for service identity
  const serviceHeader = request.headers['x-service-identity'];
  if (typeof serviceHeader === 'string') return serviceHeader;

  // Default to user identity
  const userId = extractUserId(request);
  if (userId) return `user:${userId}`;

  return `anonymous:${request.ip}`;
}

/**
 * Extracts resource ID from the request URL path.
 * Handles patterns like /api/profile/:id or /api/users/:userId/profile
 */
function extractResourceId(url: string): string | null {
  const path = url.split('?')[0];
  const segments = path.split('/').filter(Boolean);

  // Look for UUID-like segments after "profile" or "profiles"
  const profileIndex = segments.findIndex((s) => s === 'profile' || s === 'profiles');
  if (profileIndex >= 0 && profileIndex < segments.length - 1) {
    return segments[profileIndex + 1];
  }

  // Look for UUID in users/:id/profile pattern
  const usersIndex = segments.findIndex((s) => s === 'users' || s === 'user');
  if (usersIndex >= 0 && usersIndex < segments.length - 1) {
    return segments[usersIndex + 1];
  }

  return null;
}

/**
 * Registers the audit logging middleware as a Fastify hook.
 * Uses onResponse hook to log after the request completes (capturing status).
 */
export function registerAuditMiddleware(app: FastifyInstance): void {
  app.addHook(
    'onResponse',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Only audit profile-related routes
      if (!isProfileRoute(request.url)) {
        return;
      }

      // Only audit successful operations (2xx and 3xx)
      const statusCode = reply.statusCode;
      if (statusCode >= 400) {
        return;
      }

      const method = request.method.toUpperCase();
      const action = METHOD_ACTION_MAP[method];

      // Skip methods we don't audit (e.g., OPTIONS, HEAD)
      if (!action) {
        return;
      }

      const userId = extractUserId(request);
      const actorIdentity = extractActorIdentity(request);
      const resourceId = extractResourceId(request.url);

      try {
        await logAction({
          userId,
          action,
          resourceType: 'user_profile',
          resourceId,
          details: {
            method,
            path: request.url.split('?')[0],
            statusCode,
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          },
          actorIdentity,
        });
      } catch (error) {
        // Log errors but don't fail the response — audit logging is non-blocking
        request.log.error({ error }, 'Failed to write audit log entry');
      }
    }
  );
}

// Re-export for testing
export { isProfileRoute, extractUserId, extractActorIdentity, extractResourceId };
