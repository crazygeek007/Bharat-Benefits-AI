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
import { startDailyCrawlSchedule } from './workers/daily-crawl.worker';
import { ChangeDetectorService } from './services/change-detector/change-detector';
import {
  InMemorySourceFailureStore,
  createChangeDetectorAdapter,
} from './services/crawler/crawler-pipeline-integration';
import { buildProductionCrawlerAdapters } from './services/crawler/prisma-adapters';
import { createSchemeIndexer } from './services/crawler/scheme-indexer';

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
 * Lazy handle to the daily crawl scheduler — populated only when
 * `ENABLE_DAILY_CRAWL=true` so the gracefulShutdown hook can stop it
 * cleanly without referencing it when the worker never started.
 */
let stopDailyCrawl: (() => void) | null = null;

/**
 * Construct the daily crawler with its production dependency graph
 * wired in: Prisma persistence + compatibility store, Pinecone-backed
 * vector indexer, Elasticsearch/Postgres-FTS search indexer, and a
 * change detector that fans out citizen notifications when scheme
 * fields drift.
 *
 * Returns a `stop()` function. The caller decides whether to start —
 * see the `ENABLE_DAILY_CRAWL` env gate below. Off by default because
 * the crawler writes to the catalogue; flipping the flag must be a
 * conscious operations decision, not the side-effect of a deploy.
 */
function startCrawler(): () => void {
  const schemeIndexer = createSchemeIndexer();
  const changeDetectorService = new ChangeDetectorService({
    prisma: prisma as unknown as ConstructorParameters<
      typeof ChangeDetectorService
    >[0]['prisma'],
  });
  const adapters = buildProductionCrawlerAdapters({
    // The Prisma generated client is a wider type than the focused
    // adapter interfaces; the adapter constructors cast internally.
    prisma: prisma as unknown as Parameters<
      typeof buildProductionCrawlerAdapters
    >[0]['prisma'],
    schemeIndexer,
  });
  const changeDetector = createChangeDetectorAdapter({ changeDetectorService });
  // Single-instance source-failure tracking. Backed by Prisma when we
  // eventually horizontally-scale the crawler; in-memory is correct as
  // long as `DISABLE_SCHEDULER` keeps the cron on a single replica.
  const sourceFailureStore = new InMemorySourceFailureStore();
  void sourceFailureStore;

  return startDailyCrawlSchedule({
    persistence: adapters.persistence,
    vectorIndexer: adapters.vectorIndexer,
    searchIndexer: adapters.searchIndexer,
    compatibilityStore: adapters.compatibilityStore,
    changeDetector,
  });
}

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
  if (stopDailyCrawl) {
    stopDailyCrawl();
    stopDailyCrawl = null;
  }

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

    // The daily crawler is opt-in (env-gated) because it writes to the
    // catalogue and orchestrates Pinecone / Postgres updates. Operators
    // flip ENABLE_DAILY_CRAWL=true after they've curated the source URL
    // list and verified admin review tooling is in place.
    if (process.env.ENABLE_DAILY_CRAWL === 'true') {
      try {
        stopDailyCrawl = startCrawler();
        fastify.log.info('Daily crawler scheduled (24h interval, opt-in via ENABLE_DAILY_CRAWL)');
      } catch (err) {
        // Don't crash the API just because the crawler wiring tripped —
        // surface the error and continue serving traffic.
        fastify.log.error({ err }, 'Failed to start daily crawler');
      }
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();

export { fastify, gracefulShutdown };
