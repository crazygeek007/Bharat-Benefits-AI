/**
 * Zod schemas for benefits-dashboard routes.
 *
 * Both `POST /api/dashboard/save` and `POST /api/dashboard/applied` accept
 * a single `schemeId`. The id is a UUID emitted by Postgres; we accept
 * either the canonical string form or any non-empty string so callers
 * coming from non-uuid id sources (tests, fixtures) keep working.
 */

import { z } from 'zod';

export const SchemeIdBodySchema = z.object({
  schemeId: z.string().trim().min(1, 'schemeId is required').max(128),
});

export type SchemeIdBody = z.infer<typeof SchemeIdBodySchema>;
