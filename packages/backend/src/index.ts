import 'dotenv/config';
import { buildApp } from './app';
import { startDailyScheduler, stopDailyScheduler } from './workers/daily-scheduler';
import prisma from './lib/prisma';
import {
  HelpfulnessMonitor,
  ObservabilityService,
  PrismaAIQueryLogStore,
  PrismaEvaluationRunStore,
  PrismaFeedbackStore,
} from './services/ai-observability';

/**
 * Construct the AI observability service from production Prisma stores
 * so the citizen feedback endpoint and admin observability dashboards
 * have a real backing service. Returning a singleton here keeps the
 * helpfulness monitor / tracer state coherent across HTTP requests.
 *
 * The query-log store is currently only written-to once the assistant
 * is instrumented (follow-up work) — the feedback endpoint, the
 * helpfulness rollup, and the evaluation-run listing already work end
 * to end against the existing Prisma tables.
 */
function buildObservabilityService(): ObservabilityService {
  // The Prisma client surface is wider than the dedicated store
  // interfaces; the Prisma-backed store classes only consume the
  // narrow subset they need, so a plain cast is sound here.
  const queryLogStore = new PrismaAIQueryLogStore(
    prisma as unknown as ConstructorParameters<typeof PrismaAIQueryLogStore>[0],
  );
  const feedbackStore = new PrismaFeedbackStore(
    prisma as unknown as ConstructorParameters<typeof PrismaFeedbackStore>[0],
  );
  const evaluationRunStore = new PrismaEvaluationRunStore(
    prisma as unknown as ConstructorParameters<typeof PrismaEvaluationRunStore>[0],
  );
  const helpfulnessMonitor = new HelpfulnessMonitor(feedbackStore);
  return new ObservabilityService({
    queryLogStore,
    feedbackStore,
    helpfulnessMonitor,
    evaluationRunStore,
  });
}

const observabilityService = buildObservabilityService();

const fastify = buildApp({ observabilityService });

/**
 * Drain in-flight requests, close the HTTP server, then disconnect every
 * external client. The orchestration is best-effort: each disconnect runs
 * regardless of whether prior ones succeeded so a single misbehaving
 * dependency cannot block the process from exiting.
 *
 * Triggered by SIGTERM / SIGINT (Kubernetes pod termination, Ctrl-C, etc.).
 */
async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  fastify.log.info({ signal }, 'shutdown signal received — draining server');

  // Stop background jobs first so they don't fire mid-shutdown.
  stopDailyScheduler();

  // 1. Stop accepting new connections, wait for in-flight requests.
  await fastify.close().catch((err) => {
    fastify.log.error({ err }, 'fastify.close() threw during shutdown');
  });

  // 2. Disconnect external clients in parallel — order doesn't matter
  //    because no requests are in flight by this point.
  const drains = await Promise.allSettled([
    (async () => {
      const { default: prisma } = await import('./lib/prisma');
      await prisma.$disconnect();
    })(),
    (async () => {
      const { disconnectRedis } = await import('./lib/redis');
      await disconnectRedis();
    })(),
    (async () => {
      const { disconnectElasticsearch } = await import('./lib/elasticsearch');
      await disconnectElasticsearch();
    })(),
    (async () => {
      const { disconnectVectorDB } = await import('./lib/vectordb');
      disconnectVectorDB();
    })(),
  ]);
  for (const drain of drains) {
    if (drain.status === 'rejected') {
      fastify.log.error({ err: drain.reason }, 'shutdown disconnect failed');
    }
  }

  process.exit(0);
}

async function start(): Promise<void> {
  const port = Number(process.env.PORT) || 4000;
  const host = process.env.HOST || '0.0.0.0';

  // Surface unhandled async failures rather than letting Node print a
  // deprecation warning and continue with leaked state.
  process.on('unhandledRejection', (reason) => {
    fastify.log.error({ reason }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    fastify.log.fatal({ err }, 'uncaughtException — shutting down');
    void gracefulShutdown('SIGTERM');
  });

  // Register shutdown handlers BEFORE `listen` so a failed startup still
  // hits the disconnect logic. `once` so a double-Ctrl-C still terminates
  // the process even if the first shutdown hangs.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void gracefulShutdown(signal);
    });
  }

  try {
    await fastify.listen({ port, host });
    fastify.log.info(`Server running at http://${host}:${port}`);

    // Start scheduled background jobs (daily verification @ 02:00 IST,
    // deadline scans every 30 minutes). Set DISABLE_SCHEDULER=true in
    // the env to skip — useful when running multiple backend replicas
    // and you want only one to host the scheduler.
    if (process.env.DISABLE_SCHEDULER !== 'true') {
      startDailyScheduler();
    } else {
      fastify.log.info('Daily scheduler disabled by DISABLE_SCHEDULER env var');
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();

export { fastify, gracefulShutdown };
