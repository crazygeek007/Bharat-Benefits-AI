/**
 * HTTP routes for citizen profile management (Requirement 3).
 *
 * Exposes:
 *   - `GET    /api/profile` — fetch the authenticated citizen's profile.
 *     Returns `{ profile: null }` (200) when the citizen has not yet created
 *     a profile so the frontend can render the onboarding flow without
 *     special-casing 404 (Req 3.1, 3.7).
 *   - `POST   /api/profile` — create the profile on first save (Req 3.1).
 *   - `PUT    /api/profile` — partial-update the profile (Req 3.4).
 *   - `DELETE /api/profile` — schedule a 30-day deletion (Req 3.6). Returns
 *     the scheduled deletion date so the UI can surface a confirmation.
 *   - `POST   /api/profile/deletion/confirm` — citizen-confirmed deletion
 *     within the 30-day window (Req 3.7).
 *   - `POST   /api/profile/deletion/cancel`  — cancel a pending deletion.
 *
 * All routes require authentication via the `authenticate` pre-handler.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DeletionWindowExpiredError,
  ProfileConflictError,
  ProfileNotFoundError,
  ProfileValidationError,
  UserProfileService,
  userProfileService as defaultUserProfileService,
} from '../services/user-profile-service';
import {
  ConfirmDeletionSchema,
  CreateProfileSchema,
  UpdateProfileSchema,
} from '../schemas/profile.schemas';
import { parseOrReply } from '../lib/validation';

export interface RegisterProfileRoutesOptions {
  /** Override the UserProfileService — primarily used by tests. */
  service?: UserProfileService;
}

/**
 * Builds a preHandler that resolves the `authenticate` decorator at
 * request time rather than at route-registration time.
 *
 * This matters because Fastify's `register(plugin)` is asynchronous — the
 * `authenticate` decorator added by the auth plugin is not visible
 * synchronously after `app.register(authPlugin)` returns. By the time a
 * request fires, `await app.ready()` has run and the decorator IS
 * available, so a lazy lookup works correctly. Any other ordering means
 * the route was wired before the auth plugin was loaded — that's a
 * developer error and we 503 with a clear message instead of silently
 * skipping authentication.
 */
function buildAuthPreHandler(app: FastifyInstance) {
  return async function authenticatePreHandler(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const fn = (app as FastifyInstance & {
      authenticate?: (
        r: FastifyRequest,
        rep: FastifyReply,
      ) => Promise<void>;
    }).authenticate;
    if (typeof fn !== 'function') {
      reply.code(503).send({
        error: 'AuthMisconfigured',
        message: 'authenticate decorator is unavailable on this server',
      });
      return;
    }
    await fn(req, reply);
  };
}

export function registerProfileRoutes(
  app: FastifyInstance,
  options: RegisterProfileRoutesOptions = {},
): void {
  const service = options.service ?? defaultUserProfileService;
  const requireAuth = { preHandler: buildAuthPreHandler(app) };

  app.get('/api/profile', requireAuth, async (request, reply) => {
    const userId = request.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    // The service does not currently expose a `getProfile` method — the
    // canonical lookup goes through Prisma directly. Use a lazy import so
    // narrow tests can stub the service without standing up Prisma.
    const { default: prisma } = await import('../lib/prisma');
    const row = await prisma.userProfile.findUnique({ where: { userId } });
    if (!row) return reply.code(200).send({ profile: null });

    return reply.code(200).send({ profile: row });
  });

  app.post(
    '/api/profile',
    requireAuth,
    async (request, reply) => {
      const userId = request.user?.sub;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const parsed = parseOrReply(CreateProfileSchema, request.body, reply);
      if (!parsed) return reply;

      try {
        // Service-level types are still the ground truth — pass the
        // parsed object straight through. zod has already coerced /
        // narrowed the shape so the cast is sound.
        const profile = await service.createProfile(
          userId,
          parsed.data as Parameters<typeof service.createProfile>[1],
        );
        return reply.code(201).send({ profile });
      } catch (err) {
        return mapProfileError(reply, err);
      }
    },
  );

  app.put(
    '/api/profile',
    requireAuth,
    async (request, reply) => {
      const userId = request.user?.sub;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const parsed = parseOrReply(UpdateProfileSchema, request.body, reply);
      if (!parsed) return reply;

      try {
        const profile = await service.updateProfile(
          userId,
          parsed.data as Parameters<typeof service.updateProfile>[1],
        );
        return reply.code(200).send({ profile });
      } catch (err) {
        return mapProfileError(reply, err);
      }
    },
  );

  app.delete('/api/profile', requireAuth, async (request, reply) => {
    const userId = request.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const schedule = await service.deleteProfile(userId);
      return reply.code(202).send({ scheduledDeletion: schedule });
    } catch (err) {
      return mapProfileError(reply, err);
    }
  });

  app.post(
    '/api/profile/deletion/confirm',
    requireAuth,
    async (request, reply) => {
      const userId = request.user?.sub;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const parsed = parseOrReply(ConfirmDeletionSchema, request.body, reply);
      if (!parsed) return reply;

      try {
        await service.confirmDeletion(userId, parsed.data.confirm);
        return reply.code(204).send();
      } catch (err) {
        return mapProfileError(reply, err);
      }
    },
  );

  app.post('/api/profile/deletion/cancel', requireAuth, async (request, reply) => {
    const userId = request.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      await service.cancelDeletion(userId);
      return reply.code(204).send();
    } catch (err) {
      return mapProfileError(reply, err);
    }
  });
}

function mapProfileError(reply: FastifyReply, err: unknown) {
  if (err instanceof ProfileValidationError) {
    return reply.code(422).send({
      error: 'ValidationError',
      message: err.message,
      errors: err.errors,
    });
  }
  if (err instanceof ProfileConflictError) {
    return reply.code(409).send({ error: 'Conflict', message: err.message });
  }
  if (err instanceof ProfileNotFoundError) {
    return reply.code(404).send({ error: 'NotFound', message: err.message });
  }
  if (err instanceof DeletionWindowExpiredError) {
    return reply.code(410).send({ error: 'Gone', message: err.message });
  }
  if (err instanceof TypeError) {
    return reply.code(400).send({ error: 'BadRequest', message: err.message });
  }
  throw err;
}
