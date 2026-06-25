/**
 * Unit tests for the in-memory crawl frontier.
 *
 * Focused on the three policies that protect us from runaway crawls:
 * dedup, depth limit, per-host budget. The orchestrator-level tests
 * exercise the frontier in context; these tests pin the contract.
 */

import { describe, expect, it } from 'vitest';
import { CrawlFrontier } from './crawl-frontier';

describe('CrawlFrontier.add', () => {
  it('accepts a fresh URL at depth 0', () => {
    const f = new CrawlFrontier();
    expect(f.add('https://x.gov.in/a', 0)).toEqual({ ok: true });
    expect(f.size()).toBe(1);
  });

  it('rejects duplicate URLs (same normalised form)', () => {
    const f = new CrawlFrontier();
    expect(f.add('https://x.gov.in/a', 0)).toEqual({ ok: true });
    expect(f.add('https://x.gov.in/a', 1)).toEqual({
      ok: false,
      reason: 'already-seen',
    });
    expect(f.add('https://x.gov.in/a#section', 0)).toEqual({
      ok: false,
      reason: 'already-seen',
    });
    expect(f.size()).toBe(1);
  });

  it('rejects URLs exceeding the configured depth limit', () => {
    const f = new CrawlFrontier({ maxDepth: 2 });
    expect(f.add('https://x.gov.in/a', 2)).toEqual({ ok: true });
    expect(f.add('https://x.gov.in/b', 3)).toEqual({
      ok: false,
      reason: 'depth-exceeded',
    });
  });

  it('rejects URLs past the per-host budget', () => {
    const f = new CrawlFrontier({ maxPagesPerHost: 2 });
    expect(f.add('https://x.gov.in/a', 0)).toEqual({ ok: true });
    expect(f.add('https://x.gov.in/b', 0)).toEqual({ ok: true });
    expect(f.add('https://x.gov.in/c', 0)).toEqual({
      ok: false,
      reason: 'host-budget-exhausted',
    });
    // Different host has its own budget.
    expect(f.add('https://y.gov.in/a', 0)).toEqual({ ok: true });
  });

  it('rejects malformed URLs without crashing', () => {
    const f = new CrawlFrontier();
    expect(f.add('not-a-url', 0)).toEqual({ ok: false, reason: 'invalid-url' });
    expect(f.add('javascript:void(0)', 0)).toEqual({
      ok: false,
      reason: 'invalid-url',
    });
    expect(f.add('', 0)).toEqual({ ok: false, reason: 'invalid-url' });
  });

  it('normalises hostnames to lowercase but preserves path / query', () => {
    const f = new CrawlFrontier();
    expect(f.add('https://X.gov.in/Path?Q=1', 0)).toEqual({ ok: true });
    expect(f.add('https://x.gov.in/Path?Q=1', 0)).toEqual({
      ok: false,
      reason: 'already-seen',
    });
    // Different path = different URL.
    expect(f.add('https://x.gov.in/path?Q=1', 0)).toEqual({ ok: true });
  });
});

describe('CrawlFrontier.next', () => {
  it('returns entries in FIFO order', () => {
    const f = new CrawlFrontier();
    f.add('https://x.gov.in/a', 0);
    f.add('https://x.gov.in/b', 1);
    f.add('https://x.gov.in/c', 2);
    expect(f.next()?.url).toBe('https://x.gov.in/a');
    expect(f.next()?.url).toBe('https://x.gov.in/b');
    expect(f.next()?.url).toBe('https://x.gov.in/c');
    expect(f.next()).toBeNull();
  });

  it('reports isEmpty correctly after every dequeue', () => {
    const f = new CrawlFrontier();
    expect(f.isEmpty()).toBe(true);
    f.add('https://x.gov.in/a', 0);
    expect(f.isEmpty()).toBe(false);
    f.next();
    expect(f.isEmpty()).toBe(true);
  });
});

describe('CrawlFrontier.stats', () => {
  it('aggregates counters across enqueue + dequeue', () => {
    const f = new CrawlFrontier({ maxPagesPerHost: 1, maxDepth: 2 });
    f.add('https://x.gov.in/a', 0); // ok
    f.add('https://x.gov.in/b', 0); // host-budget
    f.add('https://x.gov.in/a', 0); // already-seen
    f.add('https://y.gov.in/a', 3); // depth-exceeded
    f.add('not-a-url', 0);          // invalid
    f.next();

    const stats = f.stats();
    expect(stats.totalEnqueued).toBe(1);
    expect(stats.totalDequeued).toBe(1);
    expect(stats.rejectedAlreadySeen).toBe(1);
    expect(stats.rejectedDepthExceeded).toBe(1);
    expect(stats.rejectedHostBudgetExhausted).toBe(1);
    expect(stats.rejectedInvalidUrl).toBe(1);
    expect(stats.perHostQueued.get('x.gov.in')).toBe(1);
  });
});
