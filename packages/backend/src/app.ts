/**
 * Fastify application factory.
 *
 * Wires up cross-cutting concerns:
 *   - CORS for the configured frontend origin
 *   - Helmet security headers (CSP, X-Frame-Options, etc.)
 *   - TLS 1.2+ enforcement via HSTS + a pre-handler that redirects/rejects
 *     plain-HTTP traffic in production (Requirement 16.4)
 *   - JWT authentication plugin used by protected routes (Requirement 16.1)
 *   - Audit logging hook for profile-related routes (Requirement 16.6)
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { registerAuthMiddleware } from './middleware/auth.middleware';
import { registerAuditMiddleware } from './middleware/audit.middleware';
import { registerApiMetricsMiddleware } from './middleware/api-metrics.middleware';
import { registerAuthRoutes } from './routes/auth.routes';
import { registerSchemesRoutes } from './routes/schemes.routes';
import { registerVoiceRoutes } from './routes/voice.routes';
import { registerAdminRoutes } from './routes/admin.routes';
import { registerObservabilityRoutes } from './routes/observability.routes';
import { registerProfileRoutes } from './routes/profile.routes';
import { registerDashboardRoutes } from './routes/dashboard.routes';
import { registerNotificationsRoutes } from './routes/notifications.routes';
import { registerAssistantRoutes } from './routes/assistant.routes';
import type { ObservabilityService } from './services/ai-observability';
import type { VoiceAssistantService } from './services/voice-assistant/voice-assistant';

/**
 * Determines whether the incoming request was delivered over TLS.
 * Trusts `X-Forwarded-Proto` when running behind a load balancer; otherwise
 * relies on the underlying socket.
 */
function isRequestSecure(request: FastifyRequest): boolean {
  const forwarded = request.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof proto === 'string' && proto.length > 0) {
    return proto.split(',')[0].trim().toLowerCase() === 'https';
  }
  // Fastify exposes the protocol from the Node socket.
  return request.protocol === 'https';
}

/**
 * Pre-handler that rejects non-TLS traffic in production. Returns 403
 * with an explanatory error body. Health checks are exempt to keep load
 * balancer probes simple.
 */
async function requireTls(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;
  if (request.url === '/health' || request.url.startsWith('/health?')) return;
  if (isRequestSecure(request)) return;
  reply.code(403).send({
    error: 'Forbidden',
    message: 'TLS 1.2 or higher is required for all API requests',
  });
}

export interface BuildAppOptions {
  /** Disable auth/audit/TLS plugins when running plain unit tests on `buildApp`. */
  enableSecurityPlugins?: boolean;
  /**
   * Optional voice assistant service factory. When supplied the
   * `/api/voice/query` route is registered (Requirement 13). Tests pass
   * a stub; production wiring resolves the Azure-backed service from
   * the assistant module.
   */
  voiceAssistantService?: VoiceAssistantService | (() => VoiceAssistantService);
  /**
   * Optional observability service. When supplied the
   * `/api/assistant/feedback` and `/api/admin/observability/*` routes
   * are registered (Requirement 21).
   */
  observabilityService?: ObservabilityService;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const enableSecurityPlugins = options.enableSecurityPlugins ?? true;
  const fastify = Fastify({ logger: true });

  fastify.register(cors, {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  });

  // Helmet adds a strong default Content-Security-Policy. HSTS is enabled
  // in production only — sending Strict-Transport-Security over a
  // non-TLS dev origin (http://localhost) makes browsers refuse to load
  // that origin over HTTP for the configured maxAge, breaking local dev
  // for an entire year.
  const isProduction = process.env.NODE_ENV === 'production';
  fastify.register(helmet, {
    hsts: isProduction
      ? {
          maxAge: 60 * 60 * 24 * 365,
          includeSubDomains: true,
          preload: true,
        }
      : false,
  });

  // Global request rate limiting — 100 requests/minute per IP. Per-route
  // tighter limits are applied at registration time (see route configs).
  // The plugin is registered globally so 429 responses include the proper
  // Retry-After header on every endpoint, not just rate-limited ones.
  fastify.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX) || 100,
    timeWindow: process.env.RATE_LIMIT_WINDOW || '1 minute',
    cache: 10_000,
    skipOnError: true, // never crash a request because the limiter blew up
    keyGenerator: (req: FastifyRequest) => {
      // Prefer X-Forwarded-For when behind a trusted proxy, otherwise the
      // socket IP. We do NOT trust `req.ip` blindly — production wiring
      // should set Fastify's `trustProxy` accordingly.
      const fwd = req.headers['x-forwarded-for'];
      const fwdHeader = Array.isArray(fwd) ? fwd[0] : fwd;
      return (fwdHeader?.split(',')[0]?.trim() || req.ip) ?? 'unknown';
    },
  });

  if (enableSecurityPlugins) {
    fastify.addHook('onRequest', requireTls);
    registerAuthMiddleware(fastify);
    registerAuditMiddleware(fastify);
    registerApiMetricsMiddleware(fastify);
    registerAuthRoutes(fastify);
    registerAdminRoutes(fastify);
    // Profile / dashboard / notifications routes all require the auth
    // plugin to be registered first — they 401 unauthenticated callers
    // via the `authenticate` decorator.
    registerProfileRoutes(fastify);
    registerDashboardRoutes(fastify);
    registerNotificationsRoutes(fastify);
    registerAssistantRoutes(fastify);
  }

  // Public scheme browsing routes (Requirement 2). Registered regardless of
  // the security-plugin toggle so plain unit tests of `buildApp` can hit
  // them without standing up the full auth stack.
  registerSchemesRoutes(fastify);

  // Voice assistant route (Requirement 13). Registered only when a
  // service factory is supplied — the route is otherwise inert so test
  // builds don't have to construct an Azure client.
  if (options.voiceAssistantService) {
    registerVoiceRoutes(fastify, { service: options.voiceAssistantService });
  }

  // AI observability routes (Requirement 21). Registered only when the
  // observability service is supplied — keeps test builds lightweight.
  if (options.observabilityService) {
    registerObservabilityRoutes(fastify, { service: options.observabilityService });
  }

  // ── Health probes ──────────────────────────────────────────────────────
  //
  // `/health` is kept as the legacy "is the process alive" probe so
  // existing load balancer configs don't break. `/healthz` is the new
  // canonical liveness probe (always cheap, never touches dependencies)
  // and `/readyz` is the readiness probe — the load balancer should pull
  // a pod out of rotation when readiness reports a hard dependency
  // failure (DB offline, Redis offline, etc.).
  fastify.get(
    '/health',
    { config: { rateLimit: false } as Record<string, unknown> },
    async () => ({ status: 'ok', timestamp: new Date().toISOString() }),
  );

  fastify.get(
    '/healthz',
    { config: { rateLimit: false } as Record<string, unknown> },
    async () => ({ status: 'ok', timestamp: new Date().toISOString() }),
  );

  fastify.get(
    '/readyz',
    { config: { rateLimit: false } as Record<string, unknown> },
    async (_request, reply) => {
      // Elasticsearch is OPTIONAL — Postgres FTS replaces it for keyword
      // search (see services/scheme-search/postgres-searcher.ts). Only
      // probe ES when it's actually configured; otherwise the absence is
      // a healthy state, not a failure.
      const elasticsearchConfigured = !!process.env.ELASTICSEARCH_NODE;

      // Lazy-import the health checks so test builds without these
      // dependencies don't pay the cost of loading the clients.
      const [{ checkRedisHealth }, { checkVectorDBHealth }, esModule] =
        await Promise.all([
          import('./lib/redis'),
          import('./lib/vectordb'),
          elasticsearchConfigured
            ? import('./lib/elasticsearch')
            : Promise.resolve(null),
        ]);
      const { default: prisma } = await import('./lib/prisma');

      // Run every check in parallel and bound each individually with a
      // 2 s timeout — readiness must never block longer than the load
      // balancer's own timeout.
      const withTimeout = async <T>(p: Promise<T>, name: string): Promise<T | { error: string }> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            p,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${name} probe exceeded 2s`)), 2000);
              if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
                (timer as unknown as { unref: () => void }).unref();
              }
            }),
          ]);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      const esCheckPromise: Promise<unknown> = esModule
        ? withTimeout(esModule.checkElasticsearchHealth(), 'elasticsearch')
        : Promise.resolve({ healthy: true, disabled: true });

      const [db, redis, vectordb, elasticsearch] = await Promise.all([
        withTimeout(prisma.$queryRaw`SELECT 1`, 'postgres')
          .then(() => ({ healthy: true }))
          .catch((err: unknown) => ({
            healthy: false,
            error: err instanceof Error ? err.message : String(err),
          })),
        withTimeout(checkRedisHealth(), 'redis'),
        withTimeout(checkVectorDBHealth(), 'pinecone'),
        esCheckPromise,
      ]);

      const ready =
        (db as { healthy: boolean }).healthy &&
        (redis as { healthy?: boolean }).healthy === true &&
        (vectordb as { healthy?: boolean }).healthy === true &&
        (elasticsearch as { healthy?: boolean }).healthy === true;

      return reply.code(ready ? 200 : 503).send({
        ready,
        timestamp: new Date().toISOString(),
        checks: { db, redis, vectordb, elasticsearch },
      });
    },
  );

  // ── Global error handler ──────────────────────────────────────────────
  //
  // Fastify's default handler dumps stack traces in dev and bare 500s
  // in production. We want a uniform `{ error, message, traceId }`
  // envelope across every route so the frontend can handle errors
  // consistently. Stack traces are only included when NODE_ENV !== 'production'.
  fastify.setErrorHandler((err, request, reply) => {
    const isProd = process.env.NODE_ENV === 'production';
    // Honour any status code already set on the error (Fastify routes
    // attach `statusCode` for client errors). Default to 500 for
    // anything else.
    const statusCode =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? ((err as { statusCode: number }).statusCode as number)
        : 500;

    // Always log the full error server-side so ops has the stack even
    // when the response body hides it from the client.
    if (statusCode >= 500) {
      request.log.error({ err, reqId: request.id }, 'unhandled error');
    } else {
      request.log.warn({ err, reqId: request.id, statusCode }, 'request error');
    }

    // Pass-through for already-shaped error responses (e.g. zod
    // validation envelope) so we don't double-wrap them.
    const existingBody = (err as { validation?: unknown; code?: unknown });
    if (
      statusCode === 400 &&
      Array.isArray(existingBody.validation) &&
      typeof existingBody.code === 'string'
    ) {
      reply.code(400).send({
        error: 'BadRequest',
        message: err.message,
        code: existingBody.code,
      });
      return;
    }

    reply.code(statusCode).send({
      error: err.name || 'Error',
      message: isProd && statusCode >= 500 ? 'Internal Server Error' : err.message,
      traceId: request.id,
      ...(isProd ? {} : { stack: err.stack }),
    });
  });

  return fastify;
}

export { isRequestSecure, requireTls };
