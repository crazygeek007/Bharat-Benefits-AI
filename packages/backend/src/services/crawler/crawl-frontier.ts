/**
 * In-memory crawl frontier for the discovery loop.
 *
 * Manages the queue of URLs the discovery orchestrator hasn't visited
 * yet, with three policies baked in:
 *
 *   1. Per-host page budget (default 500). Hard cap so a runaway
 *      listing page can't inflate the crawl footprint. Operators
 *      tune via the constructor option.
 *   2. Depth limit (default 3). Hops from the seed URL. Anything
 *      deeper smells like a navigation loop.
 *   3. Page-local + global dedup. The same URL never enters the queue
 *      twice within a single run; cross-run dedup falls out of the
 *      Prisma upsert at the persistence layer.
 *
 * Persistence is intentionally in-memory for v1 (per the design
 * decision recorded in the discovery-feature design doc). A persistent
 * frontier backed by Prisma would let crawls resume after a crash but
 * adds a table + writes on the hot path; we deferred until we've seen
 * a real run blow up on us.
 */

/** Entry in the frontier queue. */
export interface FrontierEntry {
  url: string;
  /** Hops from the seed URL. Seeds enter at depth 0. */
  depth: number;
  /** Tracking field — surfaced in logs to explain how a URL got here. */
  parentUrl?: string;
}

export interface CrawlFrontierOptions {
  /** Hard cap on pages processed per host per run. Default 500. */
  maxPagesPerHost?: number;
  /** Maximum depth from a seed URL. Seeds are depth 0. Default 3. */
  maxDepth?: number;
}

/**
 * Reasons the frontier can reject an enqueue request. Returned by
 * `add` so the discovery orchestrator can update its rejection
 * counters without inspecting frontier internals.
 */
export type EnqueueRejection =
  | { ok: false; reason: 'already-seen' }
  | { ok: false; reason: 'depth-exceeded' }
  | { ok: false; reason: 'host-budget-exhausted' }
  | { ok: false; reason: 'invalid-url' };

export type EnqueueResult = { ok: true } | EnqueueRejection;

export interface FrontierStats {
  totalEnqueued: number;
  totalDequeued: number;
  rejectedAlreadySeen: number;
  rejectedDepthExceeded: number;
  rejectedHostBudgetExhausted: number;
  rejectedInvalidUrl: number;
  perHostQueued: ReadonlyMap<string, number>;
}

export class CrawlFrontier {
  private readonly queue: FrontierEntry[] = [];
  private readonly seen = new Set<string>();
  private readonly perHostQueued = new Map<string, number>();
  private readonly maxPagesPerHost: number;
  private readonly maxDepth: number;

  private totalEnqueued = 0;
  private totalDequeued = 0;
  private rejectedAlreadySeen = 0;
  private rejectedDepthExceeded = 0;
  private rejectedHostBudgetExhausted = 0;
  private rejectedInvalidUrl = 0;

  constructor(options: CrawlFrontierOptions = {}) {
    this.maxPagesPerHost = options.maxPagesPerHost ?? 500;
    this.maxDepth = options.maxDepth ?? 3;
  }

  /**
   * Enqueue a URL at the supplied depth. Returns a discriminated
   * result so callers can update specific rejection counters without
   * needing to inspect frontier state.
   *
   * URL normalisation: we strip the fragment (already removed by the
   * link extractor but defensive) and lower-case the hostname. We do
   * NOT collapse trailing slashes or query parameter ordering — those
   * variants can legitimately resolve to different content on some
   * portals.
   */
  add(url: string, depth: number, parentUrl?: string): EnqueueResult {
    const normalised = normaliseUrl(url);
    if (!normalised) {
      this.rejectedInvalidUrl++;
      return { ok: false, reason: 'invalid-url' };
    }
    if (depth > this.maxDepth) {
      this.rejectedDepthExceeded++;
      return { ok: false, reason: 'depth-exceeded' };
    }
    if (this.seen.has(normalised.url)) {
      this.rejectedAlreadySeen++;
      return { ok: false, reason: 'already-seen' };
    }
    const hostCount = this.perHostQueued.get(normalised.host) ?? 0;
    if (hostCount >= this.maxPagesPerHost) {
      this.rejectedHostBudgetExhausted++;
      return { ok: false, reason: 'host-budget-exhausted' };
    }

    this.seen.add(normalised.url);
    this.perHostQueued.set(normalised.host, hostCount + 1);
    this.queue.push({ url: normalised.url, depth, parentUrl });
    this.totalEnqueued++;
    return { ok: true };
  }

  /** Pull the next entry. FIFO — first-in / first-out, breadth-first. */
  next(): FrontierEntry | null {
    const entry = this.queue.shift();
    if (!entry) return null;
    this.totalDequeued++;
    return entry;
  }

  /** True when no more entries are available. */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /** Current queue size (entries enqueued but not yet dequeued). */
  size(): number {
    return this.queue.length;
  }

  /** Snapshot of run-wide stats — safe to call mid-crawl for logging. */
  stats(): FrontierStats {
    return {
      totalEnqueued: this.totalEnqueued,
      totalDequeued: this.totalDequeued,
      rejectedAlreadySeen: this.rejectedAlreadySeen,
      rejectedDepthExceeded: this.rejectedDepthExceeded,
      rejectedHostBudgetExhausted: this.rejectedHostBudgetExhausted,
      rejectedInvalidUrl: this.rejectedInvalidUrl,
      perHostQueued: new Map(this.perHostQueued),
    };
  }
}

/**
 * Normalise a URL for frontier purposes — strip fragment, lowercase
 * scheme + host, leave path + query untouched (those carry meaning on
 * gov portals). Returns null for malformed inputs.
 */
function normaliseUrl(url: string): { url: string; host: string } | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    u.protocol = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase();
    u.hostname = host;
    return { url: u.toString(), host };
  } catch {
    return null;
  }
}
