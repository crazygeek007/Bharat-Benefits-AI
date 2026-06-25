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

  // Discovery mode (sitemap): when CRAWLER_SITEMAP_DISCOVERY=true,
  // expand seeds by walking each portal's sitemap.xml graph. Sitemap
  // XML files often get CDN special-case treatment from the same
  // portals that 403 regular HTML scrapes, so this can yield URL
  // discovery even from datacenter IPs that the HTML discovery layer
  // can't reach. Independent of the link-discovery flag — they can
  // run together (sitemap first, then any URLs the classifier sends
  // through the HTML pipeline).
  if (process.env.CRAWLER_SITEMAP_DISCOVERY === 'true') {
    const sitemapUrls = await expandSeedsViaSitemaps(urls, logger);
    if (sitemapUrls.length > 0) {
      logger.info('Sitemap discovery yielded scheme URLs', {
        seedCount: urls.length,
        schemeUrlCount: sitemapUrls.length,
      });
      const merged = Array.from(new Set([...urls, ...sitemapUrls]));
      logger.info('Starting daily crawl', { sourceCount: merged.length });
      const result = await orchestrator.executeDailyCrawl(merged);
      logCompletion(logger, merged, result);
      return result;
    }
    logger.warn('Sitemap discovery returned no URLs; trying other paths');
  }

  // Discovery mode (link-graph): when CRAWLER_LINK_DISCOVERY=true, expand seed URLs
  // by crawling each as an entry point. The discovery orchestrator
  // walks the link graph (depth 3, per-host budget 500), classifies
  // each page, and hands confirmed scheme URLs back to the main
  // CrawlerOrchestrator via processScheme. The opt-in flag exists so
  // operators can verify the new code path independently of the
  // existing direct-URL crawler.
  if (process.env.CRAWLER_LINK_DISCOVERY === 'true') {
    const discoveryUrls = await expandSeedsViaDiscovery(urls, logger);
    if (discoveryUrls.length > 0) {
      logger.info('Discovery yielded scheme URLs', {
        seedCount: urls.length,
        schemeUrlCount: discoveryUrls.length,
      });
      // Hand the harvested scheme URLs to the existing orchestrator
      // for the full ingest pipeline. The orchestrator's URL list is
      // the union of the seed URLs (so single-page portals still work)
      // and the discovery-harvested scheme URLs.
      const merged = Array.from(new Set([...urls, ...discoveryUrls]));
      logger.info('Starting daily crawl', { sourceCount: merged.length });
      const result = await orchestrator.executeDailyCrawl(merged);
      logCompletion(logger, merged, result);
      return result;
    }
    logger.warn('Discovery returned no scheme URLs; falling back to seed-only crawl');
  }

  logger.info('Starting daily crawl', { sourceCount: urls.length });
  const result = await orchestrator.executeDailyCrawl(urls);
  logCompletion(logger, urls, result);
  return result;
}

/**
 * Run the sitemap-discovery layer against the supplied seed URLs and
 * return the list of URLs declared in the portals' sitemap.xml files.
 * Best-effort — a sitemap fetch failure on one portal does not stop
 * the others, and a total failure returns an empty list (the caller
 * then falls through to other discovery paths or the seed-only crawl).
 *
 * Sitemap XML endpoints often get CDN special-case treatment so
 * search engines can index the site, which is why this path can
 * sometimes work from datacenter IPs that the HTML scrape layer
 * can't reach. There's no guarantee — we'll see in production whether
 * a given portal's sitemap is reachable from Render's IP range.
 */
async function expandSeedsViaSitemaps(
  seedUrls: string[],
  logger: OrchestratorLogger,
): Promise<string[]> {
  try {
    const { discoverFromSitemaps, resolveSitemapSeeds } = await import(
      '../services/crawler/sitemap-discovery'
    );
    const { PoliteHttpFetcher } = await import(
      '../services/crawler/polite-http-fetcher'
    );
    const { validateSource } = await import(
      '../services/crawler/source-validator'
    );
    const { UrlPatternClassifier } = await import(
      '../services/crawler/page-classifier'
    );

    const sitemapSeeds = resolveSitemapSeeds(seedUrls);
    const httpFetcher = new PoliteHttpFetcher({ delayPerHostMs: 1500 });
    const sitemapFetcher = {
      async fetch(url: string) {
        const response = await httpFetcher.fetch(url);
        return { body: response.html, finalUrl: response.finalUrl };
      },
    };

    const discoveryLogger = {
      info: logger.info,
      warn: logger.warn,
    };

    const result = await discoverFromSitemaps(sitemapSeeds, sitemapFetcher, {
      maxSitemapsPerHost: 50,
      maxUrls: 5000,
      maxDepth: 5,
      validateDomain: validateSource,
      logger: discoveryLogger,
    });

    // Sitemap entries include every URL the portal publishes — disclaimer,
    // FAQs, tourism index, etc. Sending all of those into the extraction
    // pipeline wastes the Gemini embedding budget AND floods the failure
    // log because the mandatory-field enforcer correctly rejects non-
    // scheme pages. Filter through the URL-pattern classifier first so
    // only URLs likely to be scheme pages reach the orchestrator.
    const classifier = new UrlPatternClassifier();
    const filtered: string[] = [];
    const classificationBuckets = {
      scheme: 0,
      listing: 0,
      ministry: 0,
      ignore: 0,
      unknown: 0,
    };
    for (const entry of result.urls) {
      const verdict = classifier.classify(entry.url);
      classificationBuckets[verdict.type]++;
      // Only forward URLs the URL-pattern classifier confidently
      // identified as scheme pages. `unknown` could be either way; the
      // current cost (Gemini embeddings + Pinecone writes) of running
      // each through the full pipeline is high enough that we
      // deliberately bias conservative. Once we have data on what the
      // `unknown` bucket actually contains we can extend
      // URL_PATTERN_RULES.
      if (verdict.type === 'scheme' && verdict.confidence >= 0.7) {
        filtered.push(entry.url);
      }
    }

    logger.info('Sitemap discovery complete', {
      sitemapSeeds: sitemapSeeds.length,
      sitemapsParsed: result.sitemapsParsed,
      sitemapFailures: result.sitemapFailures,
      urlsFound: result.urls.length,
      urlsAfterClassifier: filtered.length,
      classificationBuckets,
      rejectedByDomain: result.rejectedByDomain,
      perHost: result.perHost,
    });
    return filtered;
  } catch (err) {
    logger.error('Sitemap discovery layer failed; falling back to other paths', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Run the discovery layer against the supplied seed URLs and return
 * the set of URLs the page classifier identified as scheme pages. Best
 * effort — a discovery failure is logged but does NOT abort the run;
 * we fall through to the seed-only crawl.
 */
async function expandSeedsViaDiscovery(
  seedUrls: string[],
  logger: OrchestratorLogger,
): Promise<string[]> {
  try {
    const { DiscoveryOrchestrator } = await import('../services/crawler/discovery-orchestrator');
    const { createDefaultClassifier } = await import('../services/crawler/page-classifier');
    const { PoliteHttpFetcher } = await import('../services/crawler/polite-http-fetcher');
    const { validateSource } = await import('../services/crawler/source-validator');

    const schemeUrls: string[] = [];
    const fetcher = new PoliteHttpFetcher({ delayPerHostMs: 1500 });

    const discoveryLogger = {
      info: logger.info,
      warn: logger.warn,
      error: logger.error,
    };

    const orchestrator = new DiscoveryOrchestrator(
      {
        fetcher,
        classifier: createDefaultClassifier(),
        validateDomain: validateSource,
        schemeProcessor: async (url) => {
          schemeUrls.push(url);
        },
        logger: discoveryLogger,
      },
      {
        maxPagesPerHost: 500,
        maxDepth: 3,
      },
    );

    const result = await orchestrator.run(seedUrls);
    logger.info('Discovery run complete', {
      pagesCrawled: result.pagesCrawled,
      schemesDiscovered: result.schemesDiscovered,
      listingsTraversed: result.listingsTraversed,
      ignored: result.ignored,
      unknownPages: result.unknownPages,
      rejectedByDomain: result.rejectedByDomain,
      failures: result.failures,
      durationMs: result.durationMs,
    });
    return schemeUrls;
  } catch (err) {
    logger.error('Discovery layer failed; continuing with seed-only crawl', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Shared completion logger used by both the seed-only and the
 * discovery-augmented paths so the operations team sees the same
 * structured fields regardless of which flow ran.
 *
 * Classifies `FailedSource.reason` into rejectedUrls (domain
 * validation), parsingFailures (mandatory-field enforcement), and
 * fetchOrOther (transport / unknown) so admins can triage a run at a
 * glance without grepping the per-failure list.
 */
function logCompletion(
  logger: OrchestratorLogger,
  urls: string[],
  result: CrawlResult,
): void {
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
