/**
 * Fastify hook that records the response time of every handled request
 * into an {@link ApiMetricsTracker}. The admin dashboard uses the
 * tracker's average to surface "average API response time over last 24
 * hours" per Requirement 17.1.
 *
 * Skips the `/health` probe so healthcheck traffic doesn't drown out the
 * real signal during quiet periods.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  apiMetricsTracker as defaultTracker,
  type ApiMetricsTracker,
} from '../services/admin/api-metrics-tracker';

/** Symbol used to attach the request start time without polluting types. */
const START_TIME_KEY = Symbol.for('@bharat-benefits/admin/start-time-ns');

/**
 * Registers `onRequest` and `onResponse` hooks that compute the response
 * time using `process.hrtime.bigint()` (sub-microsecond precision) and
 * push the value into the supplied tracker.
 *
 * Health probes (`/health`) are excluded so synthetic monitoring doesn't
 * skew the average — the admin dashboard cares about real traffic.
 */
export function registerApiMetricsMiddleware(
  app: FastifyInstance,
  tracker: ApiMetricsTracker = defaultTracker,
): void {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    (request as unknown as Record<symbol, unknown>)[START_TIME_KEY] =
      process.hrtime.bigint();
  });

  app.addHook(
    'onResponse',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Don't record healthcheck noise.
      const url = request.url.split('?')[0];
      if (url === '/health') return;

      const start = (request as unknown as Record<symbol, unknown>)[
        START_TIME_KEY
      ];
      if (typeof start !== 'bigint') {
        // Fall back to Fastify's getResponseTime, which is in ms but only
        // exposed once the response is sent.
        const ms = reply.getResponseTime();
        if (Number.isFinite(ms)) tracker.record(ms);
        return;
      }
      const elapsedNs = process.hrtime.bigint() - start;
      // Convert nanoseconds → milliseconds with float precision.
      const ms = Number(elapsedNs) / 1_000_000;
      tracker.record(ms);
    },
  );
}
