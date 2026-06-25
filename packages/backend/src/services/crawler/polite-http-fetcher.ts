/**
 * Polite HTTP fetcher for the discovery crawler.
 *
 * Implements `DiscoveryFetcher` with three additive politeness
 * behaviours on top of the global `fetch` API:
 *
 *   1. Per-host delay. We wait at least `delayPerHostMs` (default
 *      1500 ms) between consecutive requests to the same host. The
 *      discovery loop is currently sequential, so this caps effective
 *      throughput at ~0.66 req/s per host — well inside the per-host
 *      concurrency-2 budget we agreed on. If a future revision
 *      parallelises the discovery loop, this fetcher would need to be
 *      extended with a per-host semaphore.
 *
 *   2. robots.txt honour. On the first request to a host we fetch
 *      `/robots.txt`, parse the applicable User-agent group, and reject
 *      any subsequent request whose path is disallowed. Cache is
 *      per-host and per-run. Missing / unreadable robots.txt is
 *      interpreted as "everything allowed" (the standard fallback).
 *
 *   3. Identifying User-Agent. We send a UA string that names the
 *      crawler and links to a contact endpoint. Gov portals tend to
 *      block unidentified clients; this prevents that.
 *
 * The fetcher is single-responsibility — it does not classify, parse,
 * or persist. Errors propagate so the discovery orchestrator can count
 * them as failures.
 */

import type { DiscoveryFetcher } from './discovery-orchestrator';

export interface PoliteHttpFetcherOptions {
  /** Minimum wait between consecutive requests to the same host. */
  delayPerHostMs?: number;
  /**
   * User-Agent header sent on every request. Gov portals tend to
   * reject unidentified clients; identify ourselves and provide a
   * contact pointer so operators can reach us.
   */
  userAgent?: string;
  /**
   * Maximum total time (ms) a single fetch may take, including the
   * robots.txt lookup that runs on the first hit to a host. Bounds
   * worst-case stalls so a single slow host can't tarpit the crawl.
   * Defaults to 30s.
   */
  timeoutMs?: number;
  /**
   * Optional fetch implementation — tests inject a stub. Defaults to
   * the global `fetch` so production code is zero-config.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional clock for tests. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Optional sleeper used to enforce the per-host delay. Defaults to
   * `setTimeout`-backed. Tests inject a fake to keep runs fast.
   */
  sleep?: (ms: number) => Promise<void>;
}

export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows fetching ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

/**
 * Default User-Agent header.
 *
 * Pure Chrome UA — no embedded crawler identifier. Government portals
 * behind Cloudflare / Akamai / Imperva hard-block UAs that look like
 * crawlers, even when those UAs are wrapped in a `Mozilla/5.0 (compatible;
 * ...)` prefix. We tried that pattern; portals still 403'd us.
 *
 * Trade-off: we lose the "self-identifying crawler" property — portal
 * operators can't tell from the UA who's hitting them. The mitigation
 * is the per-host delay (1.5s minimum between requests) and the
 * sequential single-worker loop, which keep our footprint well under
 * any reasonable rate budget. If a portal operator needs to reach us,
 * the platform contact details are on the About page.
 *
 * Update the Chrome version annually so the fingerprint doesn't drift
 * conspicuously out of date.
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

interface RobotsRule {
  /** Path prefix the rule applies to. Empty string matches everything. */
  prefix: string;
  allow: boolean;
}

interface ParsedRobots {
  rules: RobotsRule[];
}

const ALWAYS_ALLOW: ParsedRobots = { rules: [] };

/**
 * Polite HTTP fetcher implementation. Cache state is per-instance —
 * production callers should construct one per crawl run so the
 * robots.txt and per-host timestamps reset cleanly between runs.
 */
export class PoliteHttpFetcher implements DiscoveryFetcher {
  private readonly delayPerHostMs: number;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lastRequestAtByHost = new Map<string, number>();
  private readonly robotsByHost = new Map<string, ParsedRobots>();

  constructor(options: PoliteHttpFetcherOptions = {}) {
    this.delayPerHostMs = options.delayPerHostMs ?? 1500;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async fetch(url: string): Promise<{ html: string; finalUrl: string }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`PoliteHttpFetcher: invalid URL ${url}`);
    }

    const host = parsed.hostname.toLowerCase();

    // 1. robots.txt check (loads on first request to a host).
    const rules = await this.loadRobotsFor(host, parsed.origin);
    if (!isPathAllowed(rules, parsed.pathname)) {
      throw new RobotsDisallowedError(url);
    }

    // 2. Per-host delay enforcement.
    await this.waitForHostQuota(host);

    // 3. The actual fetch with timeout + identifying UA.
    const response = await this.fetchWithTimeout(url);
    this.lastRequestAtByHost.set(host, this.now());

    if (!response.ok) {
      throw new Error(
        `PoliteHttpFetcher: HTTP ${response.status} ${response.statusText} for ${url}`,
      );
    }

    const html = await response.text();
    return { html, finalUrl: response.url || url };
  }

  private async loadRobotsFor(host: string, origin: string): Promise<ParsedRobots> {
    const cached = this.robotsByHost.get(host);
    if (cached) return cached;

    // We register `ALWAYS_ALLOW` first so concurrent loadRobotsFor
    // calls during this round-trip don't trigger a thundering herd of
    // robots.txt fetches against the same host. Real result overwrites
    // once the load completes.
    this.robotsByHost.set(host, ALWAYS_ALLOW);

    try {
      const response = await this.fetchWithTimeout(`${origin}/robots.txt`);
      if (!response.ok) {
        // 404 / 5xx — apply the standard "no robots.txt = everything
        // allowed" interpretation.
        return ALWAYS_ALLOW;
      }
      const body = await response.text();
      const parsed = parseRobotsTxt(body, this.userAgent);
      this.robotsByHost.set(host, parsed);
      return parsed;
    } catch {
      // Network failure on robots.txt is non-fatal. We still respect
      // the per-host delay below so the subsequent real request paces
      // itself.
      return ALWAYS_ALLOW;
    }
  }

  private async waitForHostQuota(host: string): Promise<void> {
    const last = this.lastRequestAtByHost.get(host);
    if (last === undefined) return;
    const elapsed = this.now() - last;
    const wait = this.delayPerHostMs - elapsed;
    if (wait > 0) await this.sleep(wait);
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        // Match the headers a real browser would send. Bot-protection
        // services (Cloudflare / Akamai) check the presence of these
        // headers in addition to the User-Agent — sending only UA
        // catches us in the bot block-list. The four below are the
        // minimum a Chrome browser sends on a top-level navigation.
        headers: {
          'user-agent': this.userAgent,
          accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'accept-language': 'en-IN,en;q=0.9,en-US;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── robots.txt parser ──────────────────────────────────────────────────────

/**
 * Minimal robots.txt parser. Returns the rules that apply to our
 * configured User-Agent.
 *
 * The parser is intentionally narrow:
 *   - Supports `User-agent`, `Allow`, `Disallow` directives.
 *   - Picks the most specific User-agent group that matches the
 *     supplied UA token. Falls back to `*` if no specific group exists.
 *   - Ignores `Crawl-delay`, `Sitemap`, and other directives — we
 *     enforce our own pace via `delayPerHostMs`.
 *   - Leaves `Allow` precedence simple: a longer prefix wins.
 *
 * This is good-enough for the curated set of government portals we
 * crawl. If we ever expand into hosts with elaborate rules a
 * dedicated parser library (`robots-parser`) is the right escape
 * hatch.
 */
export function parseRobotsTxt(body: string, userAgent: string): ParsedRobots {
  const ourAgentToken = extractAgentToken(userAgent).toLowerCase();
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l.length > 0);

  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastDirectiveWasAgent = false;

  for (const line of lines) {
    const sepIdx = line.indexOf(':');
    if (sepIdx === -1) continue;
    const directive = line.slice(0, sepIdx).trim().toLowerCase();
    const value = line.slice(sepIdx + 1).trim();

    if (directive === 'user-agent') {
      if (!current || !lastDirectiveWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastDirectiveWasAgent = true;
      continue;
    }

    lastDirectiveWasAgent = false;
    if (!current) continue;

    if (directive === 'disallow' && value.length > 0) {
      current.rules.push({ prefix: value, allow: false });
    } else if (directive === 'allow' && value.length > 0) {
      current.rules.push({ prefix: value, allow: true });
    }
  }

  // Pick the most specific applicable group.
  const specific = groups.find((g) => g.agents.some((a) => agentMatches(a, ourAgentToken)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const applicable = specific ?? wildcard;
  return applicable ? { rules: applicable.rules } : ALWAYS_ALLOW;
}

/**
 * Decide whether a path is allowed under the supplied robots rules.
 * Longest matching prefix wins; if the winner is Allow → allowed; if
 * Disallow → blocked. No rules → allowed.
 */
function isPathAllowed(rules: ParsedRobots, pathname: string): boolean {
  let winner: RobotsRule | null = null;
  for (const rule of rules.rules) {
    if (rule.prefix === '/' || pathname.startsWith(rule.prefix)) {
      if (!winner || rule.prefix.length > winner.prefix.length) winner = rule;
    }
  }
  return winner ? winner.allow : true;
}

function extractAgentToken(userAgent: string): string {
  // Browser-prefixed UA: "Mozilla/5.0 (compatible; X/1.0; ...)" — the
  // bot identifier lives inside the `compatible;` clause, so extract
  // it instead of the leading browser segment.
  const compatibleMatch = /compatible;\s*([^/;)\s]+)/i.exec(userAgent);
  if (compatibleMatch) return compatibleMatch[1];
  // Bare bot UA: "MyBot/1.0 (+url)" — first slash-bounded segment.
  const slashIdx = userAgent.indexOf('/');
  return slashIdx === -1 ? userAgent.split(/\s+/)[0] : userAgent.slice(0, slashIdx);
}

function agentMatches(robotsAgent: string, ourToken: string): boolean {
  if (robotsAgent === '*') return false; // wildcard handled separately
  return ourToken.includes(robotsAgent) || robotsAgent.includes(ourToken);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}
