/**
 * In-memory caching layer with stale-while-revalidate (SWR) pattern.
 *
 * Targets 500ms response time for repeated scheme reads by serving stale
 * data immediately while triggering a background revalidation when the entry
 * has exceeded its `staleAfterMs` threshold.
 *
 * Validates: Requirements 18.5 (caching for API responses).
 */

export interface CacheEntry<T> {
  data: T;
  createdAt: number;
  staleAt: number;
  expiresAt: number;
}

export interface CacheOptions {
  /** Time in ms before the entry is considered stale (default 30s). */
  staleAfterMs?: number;
  /** Time in ms before the entry is evicted entirely (default 5min). */
  maxAgeMs?: number;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_MAX_AGE_MS = 300_000;

export class SWRCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private revalidating = new Set<string>();
  private defaultStaleMs: number;
  private defaultMaxAgeMs: number;

  constructor(options: CacheOptions = {}) {
    this.defaultStaleMs = options.staleAfterMs ?? DEFAULT_STALE_MS;
    this.defaultMaxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /**
   * Get a cached value. Returns the data if fresh or stale (for SWR).
   * Returns `undefined` if the entry has expired or doesn't exist.
   */
  get<T>(key: string): { data: T; isStale: boolean } | undefined {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;

    const now = Date.now();
    if (now >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    const isStale = now >= entry.staleAt;
    return { data: entry.data, isStale };
  }

  /**
   * Store a value in the cache.
   */
  set<T>(key: string, data: T, options?: CacheOptions): void {
    const staleMs = options?.staleAfterMs ?? this.defaultStaleMs;
    const maxAgeMs = options?.maxAgeMs ?? this.defaultMaxAgeMs;
    const now = Date.now();

    this.store.set(key, {
      data,
      createdAt: now,
      staleAt: now + staleMs,
      expiresAt: now + maxAgeMs,
    });
  }

  /**
   * SWR fetch: returns cached data immediately (even if stale) and
   * triggers background revalidation when stale. If no cache exists,
   * calls the fetcher directly.
   */
  async getOrFetch<T>(
    key: string,
    fetcher: () => Promise<T>,
    options?: CacheOptions,
  ): Promise<T> {
    const cached = this.get<T>(key);

    if (cached && !cached.isStale) {
      return cached.data;
    }

    if (cached && cached.isStale) {
      // Trigger background revalidation (fire and forget)
      if (!this.revalidating.has(key)) {
        this.revalidating.add(key);
        fetcher()
          .then((freshData) => {
            this.set(key, freshData, options);
          })
          .catch(() => {
            // Revalidation failed — keep serving stale data
          })
          .finally(() => {
            this.revalidating.delete(key);
          });
      }
      return cached.data;
    }

    // No cache — fetch synchronously
    const data = await fetcher();
    this.set(key, data, options);
    return data;
  }

  /** Invalidate a specific cache key. */
  invalidate(key: string): void {
    this.store.delete(key);
    this.revalidating.delete(key);
  }

  /** Invalidate all keys matching a prefix. */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        this.revalidating.delete(key);
      }
    }
  }

  /** Clear all cached entries. */
  clear(): void {
    this.store.clear();
    this.revalidating.clear();
  }

  /** Number of entries currently in the cache. */
  get size(): number {
    return this.store.size;
  }

  /** Check if a key is currently being revalidated. */
  isRevalidating(key: string): boolean {
    return this.revalidating.has(key);
  }
}

/** Shared singleton cache for scheme data (used across the frontend). */
export const schemeCache = new SWRCache({
  staleAfterMs: 30_000,  // 30s before stale
  maxAgeMs: 300_000,      // 5min max age
});
