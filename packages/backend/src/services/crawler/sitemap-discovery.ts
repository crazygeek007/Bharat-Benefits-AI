/**
 * Sitemap-driven URL discovery for the crawler.
 *
 * Drives the recursion through a portal's sitemap graph:
 *
 *   seed sitemap URL
 *     → fetch + parse
 *     → if urlset:      emit URLs
 *     → if sitemapindex: enqueue each child, repeat
 *
 * Caps:
 *   - maxSitemapsPerPortal: hard stop on how many sitemap files we
 *     load per host per run. Prevents runaway sitemap indexes from
 *     blowing through the crawl budget.
 *   - maxUrls: total URL cap across all portals so a single
 *     unexpectedly large sitemap can't pin memory.
 *   - maxDepth: number of nested sitemap indices we'll follow.
 *
 * Errors are best-effort: a failed sitemap fetch is logged and the
 * loop continues. A single 403 / parse error doesn't abort the run.
 */

import { parseSitemapXml, type SitemapEntry } from './sitemap-fetcher';

export interface SitemapDiscoveryFetcher {
  fetch(url: string): Promise<{ body: string; finalUrl: string }>;
}

export interface SitemapDiscoveryLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: SitemapDiscoveryLogger = {
  info: () => undefined,
  warn: () => undefined,
};

export interface SitemapDiscoveryOptions {
  /** Max sitemap files to load per host per run. Default 50. */
  maxSitemapsPerHost?: number;
  /** Total cap on URLs returned across all portals. Default 10000. */
  maxUrls?: number;
  /** Max nested sitemap depth. Default 5. */
  maxDepth?: number;
  /** Optional URL-allow-list — invalid URLs dropped silently. */
  validateDomain?: (url: string) => boolean;
  logger?: SitemapDiscoveryLogger;
}

export interface SitemapDiscoveryResult {
  /** Deduped URL list, sorted by lastModified descending then alpha. */
  urls: SitemapEntry[];
  /** Number of sitemap documents successfully parsed. */
  sitemapsParsed: number;
  /** Number of sitemap fetch / parse failures. */
  sitemapFailures: number;
  /** Number of URLs rejected by `validateDomain`. */
  rejectedByDomain: number;
  /** Per-host stats — useful for logs. */
  perHost: Record<string, { sitemapsParsed: number; urls: number }>;
}

/**
 * Discover scheme URLs by walking the sitemap graph rooted at each
 * supplied seed sitemap URL.
 *
 * The seed list is typically obtained by auto-deriving sitemap URLs
 * from each portal seed (e.g. `https://www.myscheme.gov.in/sitemap.xml`)
 * — see `resolveSitemapSeeds` for the convenience helper.
 */
export async function discoverFromSitemaps(
  seedSitemapUrls: readonly string[],
  fetcher: SitemapDiscoveryFetcher,
  options: SitemapDiscoveryOptions = {},
): Promise<SitemapDiscoveryResult> {
  const maxSitemapsPerHost = options.maxSitemapsPerHost ?? 50;
  const maxUrls = options.maxUrls ?? 10_000;
  const maxDepth = options.maxDepth ?? 5;
  const validateDomain = options.validateDomain ?? (() => true);
  const logger = options.logger ?? noopLogger;

  const seen = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [];
  for (const seed of seedSitemapUrls) {
    if (seen.has(seed)) continue;
    seen.add(seed);
    queue.push({ url: seed, depth: 0 });
  }

  const perHostSitemaps = new Map<string, number>();
  const perHostUrls = new Map<string, number>();
  const urlsByCanonical = new Map<string, SitemapEntry>();
  let sitemapsParsed = 0;
  let sitemapFailures = 0;
  let rejectedByDomain = 0;

  while (queue.length > 0 && urlsByCanonical.size < maxUrls) {
    const entry = queue.shift();
    if (!entry) break;
    if (entry.depth > maxDepth) continue;

    let host = '';
    try {
      host = new URL(entry.url).hostname.toLowerCase();
    } catch {
      logger.warn('sitemap: skipping invalid URL', { url: entry.url });
      continue;
    }
    const hostCount = perHostSitemaps.get(host) ?? 0;
    if (hostCount >= maxSitemapsPerHost) {
      logger.warn('sitemap: per-host cap hit', { host });
      continue;
    }
    perHostSitemaps.set(host, hostCount + 1);

    let body: string;
    try {
      const response = await fetcher.fetch(entry.url);
      body = response.body;
    } catch (err) {
      sitemapFailures++;
      logger.warn('sitemap: fetch failed', {
        url: entry.url,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const parsed = parseSitemapXml(body);
    sitemapsParsed++;

    if (parsed.kind === 'sitemapindex') {
      for (const child of parsed.sitemaps) {
        if (seen.has(child.url)) continue;
        seen.add(child.url);
        queue.push({ url: child.url, depth: entry.depth + 1 });
      }
      continue;
    }

    // kind === 'urlset'
    for (const u of parsed.urls) {
      if (urlsByCanonical.size >= maxUrls) break;
      if (!validateDomain(u.url)) {
        rejectedByDomain++;
        continue;
      }
      if (urlsByCanonical.has(u.url)) continue;
      urlsByCanonical.set(u.url, u);
      perHostUrls.set(host, (perHostUrls.get(host) ?? 0) + 1);
    }
  }

  // Sort by lastModified desc then URL alpha so newer schemes flow
  // through the downstream extraction pipeline first. This makes a
  // partial-run (e.g. due to a downstream rate limit) at least bring
  // in the freshest catalogue entries.
  const urls = Array.from(urlsByCanonical.values()).sort((a, b) => {
    const at = a.lastModified?.getTime() ?? 0;
    const bt = b.lastModified?.getTime() ?? 0;
    if (at !== bt) return bt - at;
    return a.url.localeCompare(b.url);
  });

  const perHost: Record<string, { sitemapsParsed: number; urls: number }> = {};
  for (const [host, sitemaps] of perHostSitemaps.entries()) {
    perHost[host] = { sitemapsParsed: sitemaps, urls: perHostUrls.get(host) ?? 0 };
  }

  return {
    urls,
    sitemapsParsed,
    sitemapFailures,
    rejectedByDomain,
    perHost,
  };
}

/**
 * Convenience: given a list of portal seed URLs (e.g. the seed list
 * used by the existing crawler), derive the candidate sitemap URLs to
 * probe. We try the canonical `/sitemap.xml` location at the portal
 * origin — most portals expose it there, and the discovery loop
 * tolerates 404s.
 *
 * Returns DEDUPLICATED sitemap URLs so multiple seeds on the same
 * portal don't trigger duplicate sitemap fetches.
 */
export function resolveSitemapSeeds(seedUrls: readonly string[]): string[] {
  const out = new Set<string>();
  for (const seed of seedUrls) {
    try {
      const u = new URL(seed);
      out.add(`${u.origin}/sitemap.xml`);
    } catch {
      // Skip malformed seeds — they'll already be flagged by the
      // domain validator elsewhere.
    }
  }
  return Array.from(out);
}
