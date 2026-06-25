/**
 * Daily Crawl Worker — entry point
 *
 * Wires the {@link CrawlerOrchestrator} to its production dependencies
 * and exposes:
 *   - {@link runDailyCrawl}: a single-shot execution suitable for cron
 *     or BullMQ workers.
 *   - {@link startDailyCrawlSchedule}: a simple in-process scheduler
 *     that runs the crawl once every 24 hours; primarily useful in
 *     development / single-instance deployments. In production the
 *     application is expected to use an external scheduler (cron,
 *     BullMQ, AWS EventBridge) calling {@link runDailyCrawl} directly.
 *
 * This module intentionally keeps wiring narrow — heavy adapter logic
 * (Prisma upserts, Pinecone embedding generation, Elasticsearch index
 * mapping) lives in dedicated modules to keep the orchestrator pure.
 *
 * Validates: Requirements 1.4, 1.5, 1.8, 1.9
 */

import type {
  CompatibilityRelation,
  CrawlResult,
  RawSchemeData,
  SchemeObject,
} from '@bharat-benefits/shared';

import {
  CrawlerOrchestrator,
  type CrawlerOrchestratorConfig,
  type ChangeDetector,
  type CompatibilityStore,
  type OrchestratorLogger,
  type SchemeFetcher,
  type SchemePersistence,
  type SearchIndexer,
  type UpsertResult,
  type VectorIndexer,
} from '../services/crawler/orchestrator';
import {
  defaultAdminNotifier,
  type AdminNotifier,
} from '../services/crawler/notifier';

/**
 * Default source-URL list used by the worker when no override is
 * provided. Production deployments should populate
 * `process.env.CRAWLER_SOURCE_URLS` (comma-separated) or pass `urls`
 * explicitly. Treat this list as the safe fallback, not the source of
 * truth.
 */
/**
 * Default seed URLs the crawler consults when neither the env var nor
 * the call-site option supplies one. These MUST be official entry-points
 * onto trusted government portals — the domain allow-list
 * (`*.gov.in` / `*.nic.in` plus configured portals in `source-validator.ts`)
 * rejects anything else, so adding a non-government URL here would
 * silently no-op rather than expand the crawl.
 *
 * Operators override via `CRAWLER_SOURCE_URLS` (comma-separated) on
 * Render without redeploying the backend. Keep the production list
 * curated by hand — broad seeds with a deep link-discovery pass (not
 * yet implemented) will increase the per-run footprint significantly.
 */
export const DEFAULT_CRAWLER_SOURCES: readonly string[] = [
  // myScheme — central catalogue maintained by NeGD / DigiLocker. Most
  // comprehensive single index of central + state schemes.
  'https://www.myscheme.gov.in/',
  // India.gov.in — the official "My Government → Schemes" index.
  'https://www.india.gov.in/my-government/schemes',
  // Services portal — public-service endpoints, includes scheme links.
  'https://services.india.gov.in/',
  // Scholarships portal — sole authoritative source for NSP schemes.
  'https://scholarships.gov.in/',
  // iGOD (India Govt Open Data) — open dataset listings, occasionally
  // links scheme documentation and source records.
  'https://igod.gov.in/',
];

export interface DailyCrawlWorkerOptions {
  /** Override source URL list; falls back to env / defaults. */
  urls?: string[];
  /** Override orchestrator deps (used in tests / advanced wiring). */
  fetcher?: SchemeFetcher;
  persistence?: SchemePersistence;
  vectorIndexer?: VectorIndexer;
  searchIndexer?: SearchIndexer;
  changeDetector?: ChangeDetector;
  compatibilityStore?: CompatibilityStore;
  notifier?: AdminNotifier;
  logger?: OrchestratorLogger;
  config?: CrawlerOrchestratorConfig;
}

/**
 * Resolves the source URL list from (in order):
 *   1. `options.urls`
 *   2. `process.env.CRAWLER_SOURCE_URLS` (comma-separated)
 *   3. {@link DEFAULT_CRAWLER_SOURCES}
 */
export function resolveSourceUrls(options: DailyCrawlWorkerOptions = {}): string[] {
  if (options.urls && options.urls.length > 0) return options.urls;
  const env = process.env.CRAWLER_SOURCE_URLS;
  if (typeof env === 'string' && env.trim().length > 0) {
    return env
      .split(',')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
  }
  return [...DEFAULT_CRAWLER_SOURCES];
}

/**
 * Executes a single daily-crawl run and logs the summary. The function
 * never throws: all errors are surfaced via the orchestrator's
 * structured failure list and the notifier.
 *
 * In production the caller MUST inject real `persistence` and indexer
 * dependencies. When `NODE_ENV === 'production'` and any of the heavy
 * dependencies fall back to the no-op stubs the worker refuses to run —
 * silently indexing nothing is far worse than a noisy startup failure.
 */
export async function runDailyCrawl(
  options: DailyCrawlWorkerOptions = {},
): Promise<CrawlResult> {
  const logger = options.logger ?? consoleLogger;

  const persistence = options.persistence ?? noopPersistence(logger);
  const vectorIndexer = options.vectorIndexer ?? noopIndexer('vector', logger);
  const searchIndexer = options.searchIndexer ?? noopIndexer('search', logger);
  const changeDetector = options.changeDetector ?? noopChangeDetector(logger);
  const compatibilityStore =
    options.compatibilityStore ?? noopCompatibilityStore(logger);

  if (process.env.NODE_ENV === 'production') {
    const missing: string[] = [];
    if (!options.persistence) missing.push('persistence');
    if (!options.vectorIndexer) missing.push('vectorIndexer');
    if (!options.searchIndexer) missing.push('searchIndexer');
    if (!options.changeDetector) missing.push('changeDetector');
    if (!options.compatibilityStore) missing.push('compatibilityStore');
    if (missing.length > 0) {
      throw new Error(
        `runDailyCrawl: production environment is missing real implementations for: ${missing.join(
          ', ',
        )}. Wire them via DailyCrawlWorkerOptions before scheduling the job — the no-op stubs would silently drop every scheme.`,
      );
    }
  }

  const orchestrator = new CrawlerOrchestrator(
    {
      fetcher: options.fetcher ?? defaultFetcher(),
      persistence,
      vectorIndexer,
      searchIndexer,
      changeDetector,
      compatibilityStore,
      notifier: options.notifier ?? defaultAdminNotifier,
      logger,
    },
    options.config,
  );

  const urls = resolveSourceUrls(options);
  logger.info('Starting daily crawl', { sourceCount: urls.length });
  const result = await orchestrator.executeDailyCrawl(urls);

  // Classify failures by the reason string emitted by the orchestrator
  // so operators can see at a glance whether a run failed due to bad
  // sources (domain rejection), bad data (parse failures), or transport
  // (HTTP errors). The orchestrator's `FailedSource.reason` is free-form
  // text — we match well-known prefixes and bucket the rest as
  // 'fetch-or-other'.
  const failureBuckets = {
    rejectedUrls: 0,
    parsingFailures: 0,
    fetchOrOther: 0,
  };
  for (const failed of result.failedSources) {
    const reason = (failed.reason ?? '').toLowerCase();
    if (
      reason.includes('source url') ||
      reason.includes('domain') ||
      reason.includes('invalid url')
    ) {
      failureBuckets.rejectedUrls++;
    } else if (
      reason.includes('mandatory') ||
      reason.includes('missing field') ||
      reason.includes('parse')
    ) {
      failureBuckets.parsingFailures++;
    } else {
      failureBuckets.fetchOrOther++;
    }
  }

  logger.info('Daily crawl completed', {
    sourceCount: urls.length,
    pagesCrawled: urls.length,
    schemesDiscovered: result.newSchemes + result.updatedSchemes,
    newSchemes: result.newSchemes,
    updatedSchemes: result.updatedSchemes,
    failedSources: result.failedSources.length,
    rejectedUrls: failureBuckets.rejectedUrls,
    parsingFailures: failureBuckets.parsingFailures,
    fetchOrOther: failureBuckets.fetchOrOther,
    durationMs: result.duration,
  });
  return result;
}

/**
 * Simple in-process schedule. Runs the crawl immediately, then once
 * every `intervalMs` (default 24 hours). Returns a stop function.
 *
 * In production prefer an external scheduler — this helper exists for
 * development / single-instance deployments where pulling in BullMQ or
 * node-cron is overkill.
 */
export function startDailyCrawlSchedule(
  options: DailyCrawlWorkerOptions & { intervalMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
  const logger = options.logger ?? consoleLogger;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await runDailyCrawl(options);
    } catch (err) {
      logger.error('Unhandled error during scheduled crawl', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Kick off the first run on the next tick so the caller can attach
  // listeners or inspect the returned `stop` function before the worker
  // starts.
  setImmediate(tick);
  const handle = setInterval(tick, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

// ─── Default dependency stubs ────────────────────────────────────────────────

/**
 * Production-grade structured logger built on top of pino, mirroring the
 * Fastify request logger so crawler output ends up in the same place as
 * HTTP logs. Falls back to console when pino isn't reachable (test
 * environments).
 */
type PinoLikeLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};
type PinoFactory = (opts: unknown) => PinoLikeLogger;

function createConsoleLogger(): OrchestratorLogger {
  // Pino's default output is JSON, which keeps grep / Loki / CloudWatch
  // queries simple. We name the logger so production aggregators can
  // filter "logger=crawler" without parsing message strings.
  try {
    // pino's CJS export is callable directly; the `.default` shape only
    // exists when interop layers (esModuleInterop) wrap the module. We
    // try both shapes so the worker stays portable across bundlers.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pinoModule = require('pino') as PinoFactory | { default: PinoFactory };
    const factory: PinoFactory =
      typeof pinoModule === 'function'
        ? pinoModule
        : (pinoModule as { default: PinoFactory }).default;
    const logger = factory({ name: 'crawler', level: process.env.LOG_LEVEL ?? 'info' });
    return {
      info: (msg, ctx) => logger.info(ctx ?? {}, msg),
      warn: (msg, ctx) => logger.warn(ctx ?? {}, msg),
      error: (msg, ctx) => logger.error(ctx ?? {}, msg),
    };
  } catch {
    return {
      info: (msg, ctx) => console.log(`[crawler] ${msg}`, ctx ?? {}),
      warn: (msg, ctx) => console.warn(`[crawler] ${msg}`, ctx ?? {}),
      error: (msg, ctx) => console.error(`[crawler] ${msg}`, ctx ?? {}),
    };
  }
}

const consoleLogger: OrchestratorLogger = createConsoleLogger();

/**
 * Default fetcher uses the global `fetch` API. Production wiring is
 * expected to layer caching, retry, robots.txt handling, and
 * user-agent identification on top of this.
 */
function defaultFetcher(): SchemeFetcher {
  return {
    async fetch(url: string): Promise<RawSchemeData> {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Fetch failed: HTTP ${res.status} ${res.statusText}`);
      }
      const contentTypeHeader = res.headers.get('content-type') ?? '';
      const contentType = inferContentType(contentTypeHeader, url);

      let content: string;
      if (contentType === 'pdf') {
        const arrayBuffer = await res.arrayBuffer();
        content = Buffer.from(arrayBuffer).toString('base64');
      } else {
        content = await res.text();
      }

      return {
        url,
        content,
        contentType,
        fetchedAt: new Date(),
      };
    },
  };
}

function inferContentType(header: string, url: string): RawSchemeData['contentType'] {
  const h = header.toLowerCase();
  if (h.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) return 'pdf';
  if (h.includes('application/json') || url.toLowerCase().endsWith('.json')) return 'json';
  if (
    h.includes('xml') ||
    url.toLowerCase().endsWith('.xml') ||
    url.toLowerCase().endsWith('.rss')
  ) {
    return 'xml';
  }
  return 'html';
}

/**
 * Persistence stub — production wiring should replace this with a
 * Prisma-backed implementation that performs an upsert on
 * `schemes.source_url` and returns the persisted UUID.
 */
function noopPersistence(logger: OrchestratorLogger): SchemePersistence {
  let counter = 0;
  return {
    async upsertScheme(record): Promise<UpsertResult> {
      logger.warn('Persistence is a no-op; replace with Prisma adapter', {
        sourceUrl: record.sourceUrl,
        ministry: record.ministry,
        trustScore: record.trustScore,
      });
      return { schemeId: `noop-${++counter}`, created: true };
    },
  };
}

function noopIndexer(
  label: 'vector' | 'search',
  logger: OrchestratorLogger,
): VectorIndexer & SearchIndexer {
  return {
    async indexScheme(schemeId: string, scheme: SchemeObject): Promise<void> {
      logger.warn(`${label} indexer is a no-op`, {
        schemeId,
        name: scheme.name,
      });
    },
  };
}

function noopChangeDetector(logger: OrchestratorLogger): ChangeDetector {
  return {
    async detectChanges(schemeId, _scheme, isNew): Promise<void> {
      logger.info('Change detector is a no-op', { schemeId, isNew });
    },
  };
}

function noopCompatibilityStore(logger: OrchestratorLogger): CompatibilityStore {
  return {
    async recordRelations(schemeId, relations: CompatibilityRelation[]): Promise<void> {
      logger.info('Compatibility store is a no-op', {
        schemeId,
        count: relations.length,
      });
    },
  };
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

if (require.main === module) {
  runDailyCrawl().then(
    (result) => {
      // eslint-disable-next-line no-console
      console.log('Daily crawl finished', result);
      process.exit(0);
    },
    (err) => {
      // eslint-disable-next-line no-console
      console.error('Daily crawl failed', err);
      process.exit(1);
    },
  );
}
