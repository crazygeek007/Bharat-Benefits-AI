/**
 * HTTP routes for citizen notification history (Requirement 10).
 *
 * Exposes:
 *   - `GET  /api/notifications`              — paginated notification list
 *     for the authenticated citizen, ordered newest first.
 *   - `POST /api/notifications/:id/read`     — mark a notification as read
 *     (delivered → read transition).
 *
 * The Notification service is a delivery pipeline (send + retry); the
 * persistence model is owned directly by Prisma. These routes therefore
 * read from / write to the `notifications` table directly rather than
 * going through the service. That keeps the service focused on outbound
 * delivery and avoids growing it into a CRUD layer.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  NotificationIdParamsSchema,
  NotificationsListQuerySchema,
} from '../schemas/notifications.schemas';
import { parseOrReply } from '../lib/validation';

/**
 * Builds a preHandler that resolves the `authenticate` decorator at
 * request time rather than at route-registration time. See
 * `profile.routes.ts` for the full rationale — Fastify's `register` is
 * asynchronous and the decorator isn't visible until `ready()` has run.
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

export function registerNotificationsRoutes(app: FastifyInstance): void {
  const requireAuth = { preHandler: buildAuthPreHandler(app) };

  app.get(
    '/api/notifications',
    requireAuth,
    async (request, reply) => {
      const userId = request.user?.sub;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const parsed = parseOrReply(
        NotificationsListQuerySchema,
        request.query,
        reply,
      );
      if (!parsed) return reply;
      const { page, pageSize } = parsed.data;

      const { default: prisma } = await import('../lib/prisma');

      // Run the page fetch, total count, and unread count in parallel —
      // they hit the same table but Postgres can serve them concurrently
      // through the connection pool.
      const [rows, total, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where: { userId },
          orderBy: { sentAt: 'desc' },
          take: pageSize,
          skip: (page - 1) * pageSize,
        }),
        prisma.notification.count({ where: { userId } }),
        // The schema doesn't have an explicit `read_at` column; treat
        // anything other than `status = 'read'` as unread for display
        // purposes. When the schema gains a dedicated read marker, swap
        // this filter accordingly.
        prisma.notification.count({
          where: { userId, status: { not: 'read' } },
        }),
      ]);

      return reply.code(200).send({
        notifications: rows.map((n) => ({
          id: n.id,
          type: n.type,
          channel: n.channel,
          status: n.status,
          payload: n.payload ?? {},
          sentAt: n.sentAt?.toISOString() ?? null,
          deliveredAt: n.deliveredAt?.toISOString() ?? null,
        })),
        total,
        unreadCount,
        page,
        pageSize,
      });
    },
  );

  app.post(
    '/api/notifications/:id/read',
    requireAuth,
    async (request, reply) => {
      const userId = request.user?.sub;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const parsed = parseOrReply(
        NotificationIdParamsSchema,
        request.params,
        reply,
      );
      if (!parsed) return reply;
      const { id } = parsed.data;

      const { default: prisma } = await import('../lib/prisma');

      // Scope the update to the requesting user so a citizen cannot mark
      // someone else's notifications as read by guessing IDs.
      const result = await prisma.notification.updateMany({
        where: { id, userId },
        data: { status: 'read' },
      });

      if (result.count === 0) {
        return reply.code(404).send({ error: 'NotFound', message: 'notification not found' });
      }

      return reply.code(204).send();
    },
  );
}
