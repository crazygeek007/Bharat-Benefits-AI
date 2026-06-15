/**
 * Unit tests for the SWR caching layer.
 *
 * Validates: Requirements 18.5 (caching layer for repeated scheme reads,
 * targeting 500ms response time).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRCache } from './cache';

describe('SWRCache', () => {
  let cache: SWRCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new SWRCache({ staleAfterMs: 1000, maxAgeMs: 5000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('get/set', () => {
    it('returns undefined for a missing key', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('returns the stored data for a fresh entry', () => {
      cache.set('key1', { name: 'test' });
      const result = cache.get<{ name: string }>('key1');
      expect(result).toBeDefined();
      expect(result!.data).toEqual({ name: 'test' });
      expect(result!.isStale).toBe(false);
    });

    it('marks entry as stale after staleAfterMs', () => {
      cache.set('key1', 'data');
      vi.advanceTimersByTime(1001);
      const result = cache.get('key1');
      expect(result).toBeDefined();
      expect(result!.isStale).toBe(true);
    });

    it('evicts entry after maxAgeMs', () => {
      cache.set('key1', 'data');
      vi.advanceTimersByTime(5001);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('allows per-key cache options', () => {
      cache.set('fast', 'data', { staleAfterMs: 100, maxAgeMs: 200 });
      vi.advanceTimersByTime(101);
      expect(cache.get('fast')!.isStale).toBe(true);
      vi.advanceTimersByTime(100);
      expect(cache.get('fast')).toBeUndefined();
    });
  });

  describe('getOrFetch', () => {
    it('calls the fetcher on cache miss and stores the result', async () => {
      const fetcher = vi.fn().mockResolvedValue({ id: 1 });
      const result = await cache.getOrFetch('key', fetcher);
      expect(result).toEqual({ id: 1 });
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it('returns cached data without calling fetcher when fresh', async () => {
      cache.set('key', { id: 1 });
      const fetcher = vi.fn().mockResolvedValue({ id: 2 });
      const result = await cache.getOrFetch('key', fetcher);
      expect(result).toEqual({ id: 1 });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('returns stale data immediately and triggers background revalidation', async () => {
      cache.set('key', { id: 1 });
      vi.advanceTimersByTime(1001); // Make it stale

      let resolveRevalidation: (v: unknown) => void;
      const revalidationPromise = new Promise((resolve) => {
        resolveRevalidation = resolve;
      });
      const fetcher = vi.fn().mockImplementation(() => revalidationPromise);

      const result = await cache.getOrFetch('key', fetcher);
      // Returns stale data immediately
      expect(result).toEqual({ id: 1 });
      // Fetcher is called for background revalidation
      expect(fetcher).toHaveBeenCalledOnce();
      expect(cache.isRevalidating('key')).toBe(true);

      // Resolve revalidation
      resolveRevalidation!({ id: 2 });
      await vi.advanceTimersByTimeAsync(0); // flush microtasks

      // After revalidation, cache is updated
      const fresh = cache.get<{ id: number }>('key');
      expect(fresh!.data).toEqual({ id: 2 });
      expect(fresh!.isStale).toBe(false);
    });

    it('does not re-trigger revalidation while one is in progress', async () => {
      cache.set('key', { id: 1 });
      vi.advanceTimersByTime(1001);

      let resolveRevalidation: (v: unknown) => void;
      const revalidationPromise = new Promise((resolve) => {
        resolveRevalidation = resolve;
      });
      const fetcher = vi.fn().mockReturnValue(revalidationPromise);

      await cache.getOrFetch('key', fetcher);
      await cache.getOrFetch('key', fetcher);
      // Only called once despite two getOrFetch calls
      expect(fetcher).toHaveBeenCalledOnce();

      resolveRevalidation!({ id: 2 });
      await vi.advanceTimersByTimeAsync(0);
    });

    it('keeps stale data when revalidation fails', async () => {
      cache.set('key', { id: 1 });
      vi.advanceTimersByTime(1001);

      const fetcher = vi.fn().mockRejectedValue(new Error('network error'));
      const result = await cache.getOrFetch('key', fetcher);
      expect(result).toEqual({ id: 1 });

      await vi.advanceTimersByTimeAsync(0);
      // Still has the stale value (not evicted)
      expect(cache.get('key')!.data).toEqual({ id: 1 });
    });

    it('meets 500ms target for cached reads', async () => {
      // Simulate a slow fetcher on first call
      const fetcher = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ data: 'slow' }), 2000)),
      );

      // First call takes time
      const fetchPromise = cache.getOrFetch('key', fetcher);
      vi.advanceTimersByTime(2000);
      await fetchPromise;

      // Second call should be near-instant (cached)
      const start = Date.now();
      const cachedResult = await cache.getOrFetch('key', fetcher);
      const elapsed = Date.now() - start;

      expect(cachedResult).toEqual({ data: 'slow' });
      expect(elapsed).toBeLessThan(500);
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });

  describe('invalidation', () => {
    it('invalidate removes a specific key', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.invalidate('a');
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeDefined();
    });

    it('invalidatePrefix removes all matching keys', () => {
      cache.set('schemes:list:1', 'data1');
      cache.set('schemes:list:2', 'data2');
      cache.set('profile:1', 'data3');
      cache.invalidatePrefix('schemes:');
      expect(cache.get('schemes:list:1')).toBeUndefined();
      expect(cache.get('schemes:list:2')).toBeUndefined();
      expect(cache.get('profile:1')).toBeDefined();
    });

    it('clear removes all entries', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();
      expect(cache.size).toBe(0);
    });
  });

  describe('size', () => {
    it('reports the number of cached entries', () => {
      expect(cache.size).toBe(0);
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.size).toBe(2);
    });
  });
});
