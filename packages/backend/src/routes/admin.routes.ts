/**
 * HTTP routes for the Admin Dashboard (Requirement 17).
 *
 * Exposes:
 *   - `GET    /api/admin/health`              — Crawler / DB / API metrics (Req 17.1)
 *   - `GET    /api/admin/analytics`           — KPI rollup (Req 17.4)
 *   - `GET    /api/admin/flags`               — Flagged schemes sorted by date (Req 17.3)
 *   - `POST   /api/admin/flags/:id/approve`   — Approve flag (Req 17.5)
 *   - `POST   /api/admin/flags/:id/reject`    — Reject flag with reason (Req 17.6)
 *   - `POST   /api/admin/schemes/:id/verify`  — Manually verify (Req 17.2)
 *   - `PATCH  /api/admin/schemes/:id`         — Edit scheme (Req 17.2)
 *   - `DELETE /api/admin/schemes/:id`         — Remove scheme (Req 17.2)
 *
 * All routes are guarded by the `authenticate` pre-handler followed by
 * `requireAdmin` so only authenticated administrators reach the
 * handlers. Unauthenticated requests get 401; non-admin requests get
 * 403.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin } from '../middleware/admin-auth.middleware';
import {
  analyticsService as defaultAnalyticsService,
  type AnalyticsService,
} from '../services/admin/analytics-service';
import {
  FlagAlreadyResolvedError,
  FlagNotFoundError,
  MissingRejectionReasonError,
  schemeFlagsService as defaultSchemeFlagsService,
  type FlagStatus,
  type SchemeFlagsService,
} from '../services/admin/scheme-flags-service';
import {
  InvalidEditPatchError,
  MissingRemovalReasonError,
  SchemeNotFoundError,
  schemeManagementService as defaultSchemeManagementService,
  type SchemeEditPatch,
  type SchemeManagementService,
} from '../services/admin/scheme-management-service';

export interface RegisterAdminRoutesOptions {
  analyticsService?: AnalyticsService;
  schemeFlagsService?: SchemeFlagsService;
  schemeManagementService?: SchemeManagementService;
  /** Override the requireAdmin pre-handler — primarily used by tests. */
  requireAdminPreHandler?: ReturnType<typeof requireAdmin>;
}

/**
 * Registers the admin dashboard routes on the supplied Fastify
 * instance. Tests can supply per-route overrides to avoid the Prisma
 * surface; production callers pass nothing and get the singleton
 * services.
 */
export function registerAdminRoutes(
  app: FastifyInstance,
  options: RegisterAdminRoutesOptions = {},
): void {
  const analytics = options.analyticsService ?? defaultAnalyticsService;
  const flags = options.schemeFlagsService ?? defaultSchemeFlagsService;
  const management =
    options.schemeManagementService ?? defaultSchemeManagementService;
  const adminGuard = options.requireAdminPreHandler ?? requireAdmin();
  const authenticatePreHandler =
    typeof (app as unknown as { authenticate?: unknown }).authenticate ===
    'function'
      ? (app as FastifyInstance & {
          authenticate: (...args: unknown[]) => unknown;
        }).authenticate
      : undefined;

  // Always run the admin guard last so its 403 is the actual outcome on
  // a successfully-authenticated-but-unprivileged request.
  const preHandlers = authenticatePreHandler
    ? [authenticatePreHandler, adminGuard]
    : [adminGuard];

  // ── System health ─────────────────────────────────────────────────────────
  app.get(
    '/api/admin/health',
    { preHandler: preHandlers },
    async (_request, reply) => {
      const snapshot = await analytics.getSystemHealth();
      return reply.code(200).send(snapshot);
    },
  );

  // ── Analytics ─────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/analytics',
    { preHandler: preHandlers },
    async (_request, reply) => {
      const snapshot = await analytics.getAnalytics();
      return reply.code(200).send(snapshot);
    },
  );

  // ── Flags listing ─────────────────────────────────────────────────────────
  app.get(
    '/api/admin/flags',
    { preHandler: preHandlers },
    async (request, reply) => {
      const query = (request.query ?? {}) as {
        status?: unknown;
        limit?: unknown;
        offset?: unknown;
      };
      const status = parseFlagStatus(query.status);
      const limit = parseInteger(query.limit);
      const offset = parseInteger(query.offset);
      const result = await flags.listFlags({
        status: status ?? 'pending',
        limit: limit ?? undefined,
        offset: offset ?? undefined,
      });
      return reply.code(200).send(result);
    },
  );

  // ── Approve flag ──────────────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { note?: unknown };
  }>(
    '/api/admin/flags/:id/approve',
    { preHandler: preHandlers },
    async (request, reply) => {
      const adminId = readAdminId(request, reply);
      if (!adminId) return reply;
      try {
        const flag = await flags.approveFlag({
          flagId: request.params.id,
          adminId,
          note: parseOptionalString(request.body?.note),
        });
        return reply.code(200).send({ flag });
      } catch (err) {
        return mapFlagError(reply, err);
      }
    },
  );

  // ── Reject flag ───────────────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { reason?: unknown };
  }>(
    '/api/admin/flags/:id/reject',
    { preHandler: preHandlers },
    async (request, reply) => {
      const adminId = readAdminId(request, reply);
      if (!adminId) return reply;
      const reason = parseOptionalString(request.body?.reason);
      if (!reason) {
        return reply.code(400).send({
          error: 'BadRequest',
          message: 'Rejection reason is required',
        });
      }
      try {
        const flag = await flags.rejectFlag({
          flagId: request.params.id,
          adminId,
          reason,
        });
        return reply.code(200).send({ flag });
      } catch (err) {
        return mapFlagError(reply, err);
      }
    },
  );

  // ── Verify scheme ─────────────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { note?: unknown };
  }>(
    '/api/admin/schemes/:id/verify',
    { preHandler: preHandlers },
    async (request, reply) => {
      const adminId = readAdminId(request, reply);
      if (!adminId) return reply;
      try {
        const scheme = await management.verifyScheme({
          schemeId: request.params.id,
          adminId,
          note: parseOptionalString(request.body?.note),
        });
        return reply.code(200).send({ scheme });
      } catch (err) {
        return mapManagementError(reply, err);
      }
    },
  );

  // ── Edit scheme ───────────────────────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: { patch?: unknown; note?: unknown };
  }>(
    '/api/admin/schemes/:id',
    { preHandler: preHandlers },
    async (request, reply) => {
      const adminId = readAdminId(request, reply);
      if (!adminId) return reply;
      const body = (request.body ?? {}) as { patch?: unknown; note?: unknown };
      if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
        return reply.code(400).send({
          error: 'BadRequest',
          message: 'patch object is required',
        });
      }
      try {
        const scheme = await management.editScheme({
          schemeId: request.params.id,
          adminId,
          patch: body.patch as SchemeEditPatch,
          note: parseOptionalString(body.note),
        });
        return reply.code(200).send({ scheme });
      } catch (err) {
        return mapManagementError(reply, err);
      }
    },
  );

  // ── Remove scheme ─────────────────────────────────────────────────────────
  app.delete<{
    Params: { id: string };
    Body: { reason?: unknown };
  }>(
    '/api/admin/schemes/:id',
    { preHandler: preHandlers },
    async (request, reply) => {
      const adminId = readAdminId(request, reply);
      if (!adminId) return reply;
      const reason = parseOptionalString(request.body?.reason);
      if (!reason) {
        return reply.code(400).send({
          error: 'BadRequest',
          message: 'Removal reason is required',
        });
      }
      try {
        await management.removeScheme({
          schemeId: request.params.id,
          adminId,
          reason,
        });
        return reply.code(200).send({ removed: true, schemeId: request.params.id });
      } catch (err) {
        return mapManagementError(reply, err);
      }
    },
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readAdminId(
  request: FastifyRequest,
  reply: FastifyReply,
): string | null {
  const sub = request.user?.sub;
  if (typeof sub === 'string' && sub.length > 0) return sub;
  // The authenticate hook should have populated request.user before we
  // got here — but guard against direct mounts that skip it.
  reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
  return null;
}

function parseFlagStatus(raw: unknown): FlagStatus | 'all' | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (
    value === 'pending' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'all'
  ) {
    return value as FlagStatus | 'all';
  }
  return undefined;
}

function parseInteger(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === 'string' ? Number(raw) : Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

function parseOptionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function mapFlagError(reply: FastifyReply, err: unknown) {
  if (err instanceof FlagNotFoundError) {
    return reply.code(404).send({
      error: 'NotFound',
      message: err.message,
      flagId: err.flagId,
    });
  }
  if (err instanceof FlagAlreadyResolvedError) {
    return reply.code(409).send({
      error: 'Conflict',
      message: err.message,
      flagId: err.flagId,
      status: err.status,
    });
  }
  if (err instanceof MissingRejectionReasonError) {
    return reply.code(400).send({
      error: 'BadRequest',
      message: err.message,
    });
  }
  throw err;
}

function mapManagementError(reply: FastifyReply, err: unknown) {
  if (err instanceof SchemeNotFoundError) {
    return reply.code(404).send({
      error: 'NotFound',
      message: err.message,
      schemeId: err.schemeId,
    });
  }
  if (err instanceof InvalidEditPatchError) {
    return reply.code(400).send({
      error: 'BadRequest',
      message: err.message,
      field: err.field,
    });
  }
  if (err instanceof MissingRemovalReasonError) {
    return reply.code(400).send({
      error: 'BadRequest',
      message: err.message,
    });
  }
  throw err;
}
