/**
 * HTTP routes for the Benefits Dashboard (Requirement 11).
 *
 * Exposes:
 *   - `GET    /api/dashboard`            — eligible / applied / saved / expired
 *     buckets plus estimated total benefit value (Req 11.1, 11.2, 11.4, 11.5).
 *   - `POST   /api/dashboard/save`       — save a scheme to the dashboard,
 *     enforcing the 100-scheme cap (Req 10.1).
 *   - `POST   /api/dashboard/applied`    — mark a saved scheme as applied
 *     (Req 11.3).
 *
 * Each route requires authentication. The Benefits Dashboard service owns
 * the business rules; the route layer is a thin translation between HTTP
 * semantics and the service contract.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Dashboard, SchemeWithStatus } from '@bharat-benefits/shared';
import {
  BenefitsDashboardService,
  benefitsDashboardService as defaultDashboardService,
  SavedSchemeLimitExceededError,
  SavedSchemeNotFoundError,
  SchemeNotFoundError,
} from '../services/benefits-dashboard';
import { SchemeIdBodySchema } from '../schemas/dashboard.schemas';
import { parseOrReply } from '../lib/validation';

export interface RegisterDashboardRoutesOptions {
  /** Override the dashboard service — primarily used by tests. */
  service?: BenefitsDashboardService;
}

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

export function registerDashboardRoutes(
  app: FastifyInstance,
  options: RegisterDashboardRoutesOptions = {},
): void {
  const service = options.service ?? defaultDashboardService;
  const requireAuth = { preHandler: buildAuthPreHandler(app) };

  app.get('/api/dashboard', requireAuth, async (request, reply) => {
    const userId = request.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const dashboard = await service.getDashboard(userId);
      return reply.code(200).send(toDashboardResponse(dashboard));
    } catch (err) {
      request.log.error({ err, userId }, 'failed to load dashboard');
      return reply
        .code(503)
        .send({ error: 'ServiceUnavailable', message: 'Unable to load dashboard right now' });
    }
  });

  app.post(
    '/api/dashboard/save',
    requireAuth,
    async (request, reply) => {
      const userId = request.user?.sub;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const parsed = parseOrReply(SchemeIdBodySchema, request.body, reply);
      if (!parsed) return reply;

      try {
        await service.saveScheme(userId, parsed.data.schemeId);
        return reply.code(201).send({ saved: true, schemeId: parsed.data.schemeId });
      } catch (err) {
        return mapDashboardError(reply, err);
      }
    },
  );

  app.post(
    '/api/dashboard/applied',
    requireAuth,
    async (request, reply) => {
      const userId = request.user?.sub;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const parsed = parseOrReply(SchemeIdBodySchema, request.body, reply);
      if (!parsed) return reply;

      try {
        await service.markAsApplied(userId, parsed.data.schemeId);
        return reply.code(200).send({ applied: true, schemeId: parsed.data.schemeId });
      } catch (err) {
        return mapDashboardError(reply, err);
      }
    },
  );
}

/**
 * Flatten a service-side `Dashboard` into the wire shape consumed by the
 * frontend's typed `DashboardResponse`. The service returns each bucket as
 * `SchemeWithStatus[]` (with the full scheme nested under `scheme`), but
 * the frontend renders directly off flat per-row fields — `id`, `name`,
 * `category`, etc. — so we collapse the nesting here at the HTTP boundary
 * rather than threading two shapes through the codebase.
 */
function toDashboardResponse(dashboard: Dashboard) {
  return {
    eligible: dashboard.eligible.map(toDashboardScheme),
    applied: dashboard.applied.map(toDashboardScheme),
    saved: dashboard.saved.map(toDashboardScheme),
    expired: dashboard.expired.map(toDashboardScheme),
    estimatedTotalBenefitValue: dashboard.estimatedTotalBenefitValue,
    missedBenefitsSummary: {
      count: dashboard.missedBenefitsSummary.totalCount,
      totalMonetaryValue: dashboard.missedBenefitsSummary.totalMonetaryValue,
    },
    counts: dashboard.counts,
  };
}

function toDashboardScheme(entry: SchemeWithStatus) {
  return {
    id: entry.scheme.id,
    name: entry.scheme.name,
    category: entry.scheme.category,
    status: entry.status,
    benefitType: entry.scheme.benefitType,
    benefitAmount: entry.scheme.benefitAmount,
    deadline: entry.scheme.deadline ? entry.scheme.deadline.toISOString() : null,
    savedAt: entry.savedAt.toISOString(),
    appliedAt: entry.appliedAt ? entry.appliedAt.toISOString() : null,
  };
}

function mapDashboardError(reply: FastifyReply, err: unknown) {
  if (err instanceof SavedSchemeLimitExceededError) {
    return reply
      .code(409)
      .send({ error: 'Conflict', code: 'LIMIT_EXCEEDED', message: err.message });
  }
  if (err instanceof SchemeNotFoundError) {
    return reply.code(404).send({ error: 'NotFound', message: err.message });
  }
  if (err instanceof SavedSchemeNotFoundError) {
    return reply.code(404).send({ error: 'NotFound', message: err.message });
  }
  if (err instanceof TypeError) {
    return reply.code(400).send({ error: 'BadRequest', message: err.message });
  }
  throw err;
}
