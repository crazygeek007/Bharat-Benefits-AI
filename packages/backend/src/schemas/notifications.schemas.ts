/**
 * Zod schemas for the notifications routes.
 *
 * `GET /api/notifications` accepts pagination query params; the limits
 * mirror the constants in `notifications.routes.ts`.
 */

import { z } from 'zod';

export const NotificationsListQuerySchema = z.object({
  page: z
    .union([z.number().int().min(1), z.string().regex(/^\d+$/)])
    .transform((v) => (typeof v === 'number' ? v : Number.parseInt(v, 10)))
    .default(1),
  pageSize: z
    .union([
      z.number().int().min(1).max(100),
      z.string().regex(/^\d+$/),
    ])
    .transform((v) => {
      const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
      return Math.min(Math.max(n, 1), 100);
    })
    .default(20),
});

export const NotificationIdParamsSchema = z.object({
  id: z.string().trim().min(1).max(128),
});
