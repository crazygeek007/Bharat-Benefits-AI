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

  // ── Step 1: Classify the seed URLs themselves ──────────────────────────
  // Seed URLs are typically portal homepages (myscheme.gov.in/,
  // india.gov.in/, ...) which are entry points for discovery — NOT scheme
  // detail pages. Sending them straight to the orchestrator means the
  // scheme parser sees a marketing-copy homepage, rejects it for
  // missing mandatory fields, and pollutes logs with confusing errors.
  //
  // Bucket seeds by their URL-pattern verdict so we know which ones we
  // can safely hand to the orchestrator (`scheme` confidence ≥ 0.7) vs
  // which ones are crawl-frontier entry points (`listing` / `ministry`).
  const { UrlPatternClassifier } = await import(
    '../services/crawler/page-classifier'
  );
  const seedClassifier = new UrlPatternClassifier();
  const seedBuckets = {
    scheme: [] as string[],
    listing: [] as string[],
    ministry: [] as string[],
    ignore: [] as string[],
    unknown: [] as string[],
  };
  for (const url of urls) {
    const verdict = seedClassifier.classify(url);
    if (verdict.type === 'scheme' && verdict.confidence >= 0.7) {
      seedBuckets.scheme.push(url);
    } else if (verdict.type === 'listing') {
      seedBuckets.listing.push(url);
    } else if (verdict.type === 'ministry') {
      seedBuckets.ministry.push(url);
    } else if (verdict.type === 'ignore') {
      seedBuckets.ignore.push(url);
    } else {
      seedBuckets.unknown.push(url);
    }
  }
  logger.info('Classified seed URLs', {
    total: urls.length,
    scheme: seedBuckets.scheme.length,
    listing: seedBuckets.listing.length,
    ministry: seedBuckets.ministry.length,
    ignore: seedBuckets.ignore.length,
    unknown: seedBuckets.unknown.length,
  });

  // ── Step 2: Sitemap discovery (if enabled) ─────────────────────────────
  let sitemapSchemeUrls: string[] = [];
  let sitemapListingUrls: string[] = [];
  if (process.env.CRAWLER_SITEMAP_DISCOVERY === 'true') {
    const sitemapResult = await expandSeedsViaSitemaps(urls, logger);
    sitemapSchemeUrls = sitemapResult.schemeUrls;
    sitemapListingUrls = sitemapResult.listingUrls;
  }

  // ── Step 3: Link-graph discovery (if enabled) ──────────────────────────
  // Feed entry points harvested by sitemap discovery PLUS the original
  // listing/ministry/unknown seeds into the link-discovery layer. We do
  // NOT include `scheme`-classified seeds — those bypass discovery and
  // go straight to the orchestrator (next step).
  let linkSchemeUrls: string[] = [];
  if (process.env.CRAWLER_LINK_DISCOVERY === 'true') {
    const linkSeeds = Array.from(
      new Set([
        ...seedBuckets.listing,
        ...seedBuckets.ministry,
        ...seedBuckets.unknown,
        ...sitemapListingUrls,
      ]),
    );
    if (linkSeeds.length > 0) {
      linkSchemeUrls = await expandSeedsViaDiscovery(linkSeeds, logger);
    } else {
      logger.info('Link discovery skipped: no listing/ministry seeds available');
    }
  }

  // ── Step 4: Union of confirmed-scheme URLs from all discovery layers ──
  // ONLY these enter the extraction pipeline. Homepages, listings, and
  // unknown URLs are never handed to the scheme parser — they served
  // their purpose as discovery entry points and stop here.
  const schemeUrls = Array.from(
    new Set([
      ...seedBuckets.scheme,
      ...sitemapSchemeUrls,
      ...linkSchemeUrls,
    ]),
  );

  if (schemeUrls.length === 0) {
    logger.warn(
      'No scheme URLs discovered this run — skipping ingest pass to avoid parsing homepages',
      {
        sitemapDiscoveryEnabled:
          process.env.CRAWLER_SITEMAP_DISCOVERY === 'true',
        linkDiscoveryEnabled:
          process.env.CRAWLER_LINK_DISCOVERY === 'true',
        seedBuckets: {
          scheme: seedBuckets.scheme.length,
          listing: seedBuckets.listing.length,
          ministry: seedBuckets.ministry.length,
          ignore: seedBuckets.ignore.length,
          unknown: seedBuckets.unknown.length,
        },
      },
    );
    const emptyResult: CrawlResult = {
      newSchemes: 0,
      updatedSchemes: 0,
      failedSources: [],
      duration: 0,
      completedAt: new Date(),
    };
    logCompletion(logger, urls, emptyResult);
    return emptyResult;
  }

  logger.info('Starting daily crawl', {
    schemeUrlCount: schemeUrls.length,
    fromSeeds: seedBuckets.scheme.length,
    fromSitemap: sitemapSchemeUrls.length,
    fromLinkDiscovery: linkSchemeUrls.length,
  });
  const result = await orchestrator.executeDailyCrawl(schemeUrls);
  logCompletion(logger, schemeUrls, result);
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
/**
 * Run the sitemap-discovery layer against the supplied seed URLs and
 * return BOTH scheme-classified URLs and listing/ministry URLs.
 *
 *   - `schemeUrls`  : URLs the classifier confidently labels as scheme
 *                     detail pages. These go straight to the
 *                     orchestrator's extraction pipeline.
 *   - `listingUrls` : URLs the classifier labels as listing / ministry
 *                     pages. These are entry points for the link-
 *                     discovery layer to crawl deeper from.
 *
 * Best-effort — a sitemap fetch failure on one portal does not stop
 * the others, and a total failure returns empty arrays (the caller
 * gracefully falls back to other discovery paths or skips ingest).
 *
 * Sitemap XML endpoints often get CDN special-case treatment so
 * search engines can index the site, which is why this path can
 * sometimes work from datacenter IPs that the HTML scrape layer
 * can't reach.
 */
async function expandSeedsViaSitemaps(
  seedUrls: string[],
  logger: OrchestratorLogger,
): Promise<{ schemeUrls: string[]; listingUrls: string[] }> {
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
    // scheme pages. Bucket through the URL-pattern classifier so the
    // caller can decide which URLs are extraction-targets vs which are
    // crawl-frontier entry points.
    const classifier = new UrlPatternClassifier();
    const schemeUrls: string[] = [];
    const listingUrls: string[] = [];
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
      if (verdict.type === 'scheme' && verdict.confidence >= 0.7) {
        schemeUrls.push(entry.url);
      } else if (verdict.type === 'listing' || verdict.type === 'ministry') {
        listingUrls.push(entry.url);
      }
    }

    logger.info('Sitemap discovery complete', {
      sitemapSeeds: sitemapSeeds.length,
      sitemapsParsed: result.sitemapsParsed,
      sitemapFailures: result.sitemapFailures,
      urlsFound: result.urls.length,
      schemeUrls: schemeUrls.length,
      listingUrls: listingUrls.length,
      classificationBuckets,
      rejectedByDomain: result.rejectedByDomain,
      perHost: result.perHost,
    });
    return { schemeUrls, listingUrls };
  } catch (err) {
    logger.error('Sitemap discovery layer failed; falling back to other paths', {
      err: err instanceof Error ? err.message : String(err),
    });
    return { schemeUrls: [], listingUrls: [] };
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
 *
 * Also emits a `perPortal` aggregation grouped by hostname so the
 * operations team can see at a glance which sources are healthy,
 * which are rate-limiting us, and which are returning unparseable
 * HTML. The aggregation derives:
 *   - `attempted`  : count of input URLs on that host
 *   - `failed`     : count of FailedSource entries on that host
 *   - `successful` : attempted - failed (best-effort; the orchestrator
 *                    doesn't return per-URL success metadata so we
 *                    rely on absence-of-failure)
 *   - `failureReasons` : top-3 most-common reason strings on that
 *                    host so admins can spot a pattern (e.g.
 *                    "all 200 failures are 403 Forbidden").
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

  const perPortal = buildPerPortalStats(urls, result);

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
    perPortal,
  });
}

interface PerPortalStats {
  attempted: number;
  failed: number;
  successful: number;
  /** Most-common failure reasons on this portal (max 3, with counts). */
  failureReasons: Array<{ reason: string; count: number }>;
}

/**
 * Group the run's attempted URLs and failed sources by hostname and
 * produce a flat per-portal map suitable for direct inclusion in the
 * structured log payload.
 */
function buildPerPortalStats(
  urls: string[],
  result: CrawlResult,
): Record<string, PerPortalStats> {
  const attempted: Record<string, number> = {};
  for (const url of urls) {
    const host = extractHost(url);
    attempted[host] = (attempted[host] ?? 0) + 1;
  }

  // Per-host failure count + reason distribution.
  const failed: Record<string, number> = {};
  const reasonsByHost: Record<string, Map<string, number>> = {};
  for (const fs of result.failedSources) {
    const host = extractHost(fs.url);
    failed[host] = (failed[host] ?? 0) + 1;
    const reason = compactReason(fs.reason);
    const map = reasonsByHost[host] ?? new Map<string, number>();
    map.set(reason, (map.get(reason) ?? 0) + 1);
    reasonsByHost[host] = map;
  }

  const hosts = new Set<string>([
    ...Object.keys(attempted),
    ...Object.keys(failed),
  ]);
  const out: Record<string, PerPortalStats> = {};
  for (const host of hosts) {
    const a = attempted[host] ?? 0;
    const f = failed[host] ?? 0;
    const reasonMap = reasonsByHost[host];
    const failureReasons = reasonMap
      ? Array.from(reasonMap.entries())
          .sort((x, y) => y[1] - x[1])
          .slice(0, 3)
          .map(([reason, count]) => ({ reason, count }))
      : [];
    out[host] = {
      attempted: a,
      failed: f,
      // Successful is best-effort: the orchestrator doesn't return
      // per-URL success metadata, so we report attempted-minus-failed.
      // For a host that was discovered via sitemap but produced 0
      // results, attempted will be 0 — those rows naturally drop out.
      successful: Math.max(0, a - f),
      failureReasons,
    };
  }
  return out;
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '(invalid-url)';
  }
}

/**
 * Compact a failure reason into a short tag suitable for histogram-
 * style aggregation. Keeps the first ~80 chars so we don't blow up
 * the log payload, and strips per-URL ids so the same root cause
 * collapses to the same bucket.
 */
function compactReason(reason: string): string {
  if (typeof reason !== 'string' || reason.length === 0) return '(unknown)';
  const lower = reason.toLowerCase();
  if (lower.includes('mandatory')) return 'mandatory-fields-missing';
  if (lower.includes('403') || lower.includes('forbidden')) return 'http-403';
  if (lower.includes('404')) return 'http-404';
  if (lower.includes('429')) return 'http-429';
  if (lower.includes('timeout')) return 'timeout';
  if (lower.includes('fetch failed')) return 'fetch-failed';
  if (lower.includes('domain') || lower.includes('source url')) {
    return 'domain-rejected';
  }
  if (lower.includes('parse')) return 'parser-error';
  return reason.slice(0, 80);
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
  //
  // Synchronous destination is used because the crawler is a batch
  // process. Async pino buffers log writes through sonic-boom; on a
  // short-lived script (GitHub Actions one-shot run, in particular)
  // the process exits before the buffer flushes and the completion
  // logs go missing — we saw exactly that symptom on June 27. Sync
  // mode adds a few hundred microseconds per log, which is irrelevant
  // for a once-a-day crawl, and guarantees every line lands in the
  // workflow log.
  try {
    // pino's CJS export is callable directly; the `.default` shape only
    // exists when interop layers (esModuleInterop) wrap the module. We
    // try both shapes so the worker stays portable across bundlers.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pinoModule = require('pino') as
      | (PinoFactory & { destination?: (opts: unknown) => unknown })
      | { default: PinoFactory & { destination?: (opts: unknown) => unknown } };
    const factory: PinoFactory =
      typeof pinoModule === 'function'
        ? pinoModule
        : (pinoModule as { default: PinoFactory }).default;
    const destination =
      typeof pinoModule === 'function'
        ? (pinoModule as { destination?: (opts: unknown) => unknown }).destination
        : (
            pinoModule as {
              default: { destination?: (opts: unknown) => unknown };
            }
          ).default?.destination;
    const sink =
      typeof destination === 'function'
        ? destination({ sync: true })
        : undefined;
    // pino's overloads include `(opts, destination)` but our minimal
    // PinoFactory type only declares the single-arg form, so the cast
    // below threads the destination through without dragging pino's
    // full type definitions into this module.
    const factoryWithSink = factory as unknown as (
      opts: unknown,
      dest?: unknown,
    ) => PinoLikeLogger;
    const logger = sink
      ? factoryWithSink({ name: 'crawler', level: process.env.LOG_LEVEL ?? 'info' }, sink)
      : factory({ name: 'crawler', level: process.env.LOG_LEVEL ?? 'info' });
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
