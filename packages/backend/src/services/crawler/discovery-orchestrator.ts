/**
 * Discovery orchestrator — drives the seed → frontier → classifier →
 * extraction loop introduced by the discovery feature.
 *
 *   Seed URLs → CrawlFrontier → fetch → PageClassifier
 *                                          ├── scheme   → schemeProcessor (existing pipeline)
 *                                          ├── listing  → extractLinks → enqueue children
 *                                          ├── ministry → extractLinks → enqueue children
 *                                          ├── ignore   → drop, log
 *                                          └── unknown  → drop (conservative)
 *
 * This module is I/O-light and dependency-injected:
 *   - `fetcher`           pulls HTML for a URL. Tests pass a stub.
 *   - `classifier`        runs URL-pattern + HTML-signal classification.
 *   - `validateDomain`    re-runs the source-validator's allow-list on
 *                         every discovered URL before it enters the
 *                         frontier. The frontier itself doesn't enforce
 *                         the domain gate — it's the orchestrator's job
 *                         so the policy stays in one place.
 *   - `schemeProcessor`   the callback that hands a scheme-classified
 *                         URL to the existing CrawlerOrchestrator's
 *                         processScheme pipeline. The discovery layer
 *                         doesn't reach into orchestrator internals;
 *                         it just hands over confirmed scheme URLs.
 *   - `logger`            structured logger (optional, defaults to silent).
 *
 * Concurrency / politeness wiring lives one layer up (in the runDailyCrawl
 * wiring, commit 3/3). This module is single-threaded and synchronous
 * across the loop body so the unit tests stay deterministic.
 */

import type { PageClassifier, ClassificationResult, PageType } from './page-classifier';
import { CrawlFrontier, type CrawlFrontierOptions, type FrontierStats } from './crawl-frontier';
import { extractLinks } from './link-extractor';

/**
 * Minimal fetcher abstraction. Returns the URL's HTML body as a UTF-8
 * string. Implementations layer HTTP politeness (rate limiting,
 * user-agent, robots.txt) on top — the discovery orchestrator itself
 * is transport-agnostic.
 */
export interface DiscoveryFetcher {
  fetch(url: string): Promise<{ html: string; finalUrl: string }>;
}

/**
 * Callback invoked when the discovery loop classifies a URL as a
 * scheme. The implementation forwards to the existing crawler's
 * `processScheme` (which handles fetch + parse + persist + index +
 * change detection). Returns void — errors are surfaced via the
 * orchestrator's logger so a single scheme failure doesn't abort the
 * discovery loop.
 */
export type SchemeUrlHandler = (url: string) => Promise<void>;

/**
 * Domain-allow-list check. Wired to `validateSource` in production so
 * the discovery layer never re-implements the allow-list policy.
 */
export type DomainValidator = (url: string) => boolean;

export interface DiscoveryLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: DiscoveryLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface DiscoveryOrchestratorOptions extends CrawlFrontierOptions {
  /** Frontier settings — falls back to CrawlFrontier defaults. */
  /**
   * Global hard cap on URLs processed per run. Defaults to
   * `maxPagesPerHost * (number-of-seed-hosts + 5)` at runtime. Stop
   * after this many to prevent runaway discovery loops.
   */
  globalPageCap?: number;
}

export interface DiscoveryOrchestratorDeps {
  fetcher: DiscoveryFetcher;
  classifier: PageClassifier;
  validateDomain: DomainValidator;
  schemeProcessor: SchemeUrlHandler;
  logger?: DiscoveryLogger;
}

/**
 * Aggregate result of a discovery run. The numbers are the metrics
 * the user asked us to log in the crawler refactor brief: pages
 * crawled, schemes discovered, rejected URLs, parsing failures,
 * duplicates, updates.
 */
export interface DiscoveryResult {
  /** Pages successfully fetched + classified. */
  pagesCrawled: number;
  /** URLs we handed to `schemeProcessor`. */
  schemesDiscovered: number;
  /** URLs classified as listing/ministry and used to harvest links. */
  listingsTraversed: number;
  /** URLs classified as ignore (boilerplate, asset, etc.). */
  ignored: number;
  /** URLs the chained classifier couldn't confidently bucket. */
  unknownPages: number;
  /** URLs the domain validator rejected when discovered as outbound links. */
  rejectedByDomain: number;
  /** Underlying frontier stats — depth / dedup / host-budget rejections. */
  frontier: FrontierStats;
  /** Fetch / classify / process failures encountered. */
  failures: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

export class DiscoveryOrchestrator {
  private readonly fetcher: DiscoveryFetcher;
  private readonly classifier: PageClassifier;
  private readonly validateDomain: DomainValidator;
  private readonly schemeProcessor: SchemeUrlHandler;
  private readonly logger: DiscoveryLogger;
  private readonly frontier: CrawlFrontier;
  private readonly globalPageCap: number;

  constructor(deps: DiscoveryOrchestratorDeps, options: DiscoveryOrchestratorOptions = {}) {
    this.fetcher = deps.fetcher;
    this.classifier = deps.classifier;
    this.validateDomain = deps.validateDomain;
    this.schemeProcessor = deps.schemeProcessor;
    this.logger = deps.logger ?? noopLogger;
    this.frontier = new CrawlFrontier(options);
    // Conservative default: per-host cap * 10 hosts. Adjust at the
    // call-site if you're crawling many seeds.
    this.globalPageCap = options.globalPageCap ?? (options.maxPagesPerHost ?? 500) * 10;
  }

  /**
   * Run discovery against `seedUrls`. Seeds are validated through the
   * domain gate before entering the frontier — a misconfigured seed
   * URL silently drops rather than escaping into the crawler.
   *
   * Resolves with a {@link DiscoveryResult} once the frontier is
   * drained or the global cap is hit. Never rejects: every per-URL
   * error is captured in the failures counter so a single bad page
   * can't terminate the whole run.
   */
  async run(seedUrls: readonly string[]): Promise<DiscoveryResult> {
    const start = Date.now();
    let pagesCrawled = 0;
    let schemesDiscovered = 0;
    let listingsTraversed = 0;
    let ignored = 0;
    let unknownPages = 0;
    let rejectedByDomain = 0;
    let failures = 0;

    // Push seeds onto the frontier first; depth 0.
    for (const seed of seedUrls) {
      if (!this.validateDomain(seed)) {
        rejectedByDomain++;
        this.logger.warn('discovery: seed rejected by domain gate', { url: seed });
        continue;
      }
      const result = this.frontier.add(seed, 0);
      if (!result.ok) {
        this.logger.warn('discovery: seed not enqueued', {
          url: seed,
          reason: result.reason,
        });
      }
    }

    while (!this.frontier.isEmpty() && pagesCrawled < this.globalPageCap) {
      const entry = this.frontier.next();
      if (!entry) break;

      // Cheap URL-pattern classification — no fetch needed if the
      // result is unambiguous (scheme / listing / ignore at high
      // confidence). For unknown we fall through to HTML signals.
      const urlVerdict = this.classifier.classify(entry.url);

      if (urlVerdict.type === 'ignore') {
        ignored++;
        this.logger.info('discovery: ignored by URL pattern', {
          url: entry.url,
          reason: urlVerdict.reason,
        });
        continue;
      }

      // Pure-scheme verdict from URL stage: send straight to the
      // scheme processor and skip the HTML stage / link harvest.
      if (urlVerdict.type === 'scheme' && urlVerdict.confidence >= 0.7) {
        try {
          await this.schemeProcessor(entry.url);
          schemesDiscovered++;
          pagesCrawled++;
        } catch (err) {
          failures++;
          this.logger.warn('discovery: scheme processor threw', {
            url: entry.url,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }

      // For listing / ministry / unknown / low-confidence scheme:
      // fetch the page, then make the final decision with HTML
      // signals available.
      let html: string;
      let finalUrl: string;
      try {
        const response = await this.fetcher.fetch(entry.url);
        html = response.html;
        finalUrl = response.finalUrl;
        pagesCrawled++;
      } catch (err) {
        failures++;
        this.logger.warn('discovery: fetch failed', {
          url: entry.url,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const finalVerdict = this.classifier.classify(finalUrl, html);
      switch (this.collapse(urlVerdict, finalVerdict)) {
        case 'scheme': {
          try {
            await this.schemeProcessor(finalUrl);
            schemesDiscovered++;
          } catch (err) {
            failures++;
            this.logger.warn('discovery: scheme processor threw (post-fetch)', {
              url: finalUrl,
              err: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
        case 'listing':
        case 'ministry': {
          listingsTraversed++;
          const childLinks = extractLinks(finalUrl, html);
          for (const child of childLinks) {
            if (!this.validateDomain(child)) {
              rejectedByDomain++;
              continue;
            }
            this.frontier.add(child, entry.depth + 1, finalUrl);
          }
          break;
        }
        case 'ignore':
          ignored++;
          break;
        case 'unknown':
        default:
          unknownPages++;
          this.logger.info('discovery: unable to classify after HTML signals', {
            url: finalUrl,
            urlReason: urlVerdict.reason,
            htmlReason: finalVerdict.reason,
          });
          break;
      }
    }

    const result: DiscoveryResult = {
      pagesCrawled,
      schemesDiscovered,
      listingsTraversed,
      ignored,
      unknownPages,
      rejectedByDomain,
      frontier: this.frontier.stats(),
      failures,
      durationMs: Date.now() - start,
    };
    this.logger.info('discovery: run complete', { ...result });
    return result;
  }

  /**
   * Reconcile the URL-pattern verdict and the HTML-signal verdict into
   * a single PageType. Strategy: trust whichever is more confident,
   * but bias toward the URL stage when both are mid-confidence
   * because URL patterns are anchored to known portal conventions
   * and unlikely to drift.
   */
  private collapse(
    urlVerdict: ClassificationResult,
    htmlVerdict: ClassificationResult,
  ): PageType {
    // URL-stage 'unknown' means fall through to HTML.
    if (urlVerdict.type === 'unknown') return htmlVerdict.type;
    // HTML 'unknown' / low-confidence — keep URL verdict.
    if (htmlVerdict.type === 'unknown') return urlVerdict.type;
    // Both agree — easy.
    if (urlVerdict.type === htmlVerdict.type) return urlVerdict.type;
    // Disagreement — prefer the higher-confidence verdict.
    return urlVerdict.confidence >= htmlVerdict.confidence
      ? urlVerdict.type
      : htmlVerdict.type;
  }
}
