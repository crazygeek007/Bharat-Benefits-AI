/**
 * Unit tests for the polite HTTP fetcher.
 *
 * Robots.txt parsing gets explicit coverage because the production
 * crawler is bound by it. Per-host throttling is tested by injecting
 * a fake clock + sleep so we don't actually sleep in the test process.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PoliteHttpFetcher,
  RobotsDisallowedError,
  parseRobotsTxt,
} from './polite-http-fetcher';

// ─── parseRobotsTxt ─────────────────────────────────────────────────────────

describe('parseRobotsTxt', () => {
  it('returns an always-allow result for an empty body', () => {
    expect(parseRobotsTxt('', 'BharatBenefitsAI-Crawler/1.0').rules).toEqual([]);
  });

  it('picks the wildcard group when no specific match exists', () => {
    const body = `
      User-agent: *
      Disallow: /private/
      Allow: /private/public/
    `;
    const result = parseRobotsTxt(body, 'BharatBenefitsAI-Crawler/1.0');
    expect(result.rules).toEqual([
      { prefix: '/private/', allow: false },
      { prefix: '/private/public/', allow: true },
    ]);
  });

  it('prefers a UA-specific group over the wildcard', () => {
    const body = `
      User-agent: *
      Disallow: /

      User-agent: BharatBenefitsAI-Crawler
      Disallow: /admin/
    `;
    const result = parseRobotsTxt(body, 'BharatBenefitsAI-Crawler/1.0');
    expect(result.rules).toEqual([{ prefix: '/admin/', allow: false }]);
  });

  it('extracts the bot identifier from a browser-prefixed UA for robots matching', () => {
    // Real-world UA we send in production: browser prefix + our token
    // inside the `compatible;` clause. The parser should still
    // recognise the BharatBenefitsAI-Crawler group, not fall through
    // to the wildcard.
    const body = `
      User-agent: *
      Disallow: /

      User-agent: BharatBenefitsAI-Crawler
      Disallow: /admin/
    `;
    const ua =
      'Mozilla/5.0 (compatible; BharatBenefitsAI-Crawler/1.0; +https://x.indevs.in/about) Chrome/126.0.0.0';
    const result = parseRobotsTxt(body, ua);
    expect(result.rules).toEqual([{ prefix: '/admin/', allow: false }]);
  });

  it('ignores comments and unknown directives', () => {
    const body = `
      # Just a comment
      User-agent: *
      Crawl-delay: 5
      Sitemap: https://x.gov.in/sitemap.xml
      Disallow: /tmp/
    `;
    const result = parseRobotsTxt(body, 'BharatBenefitsAI-Crawler/1.0');
    expect(result.rules).toEqual([{ prefix: '/tmp/', allow: false }]);
  });

  it('handles consecutive User-agent lines as a shared group', () => {
    const body = `
      User-agent: BharatBenefitsAI-Crawler
      User-agent: Googlebot
      Disallow: /share/
    `;
    const result = parseRobotsTxt(body, 'BharatBenefitsAI-Crawler/1.0');
    expect(result.rules).toEqual([{ prefix: '/share/', allow: false }]);
  });
});

// ─── PoliteHttpFetcher ──────────────────────────────────────────────────────

interface FakeHttpResponse {
  status: number;
  body: string;
}

function makeFakeFetch(map: Record<string, FakeHttpResponse>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const response = map[url];
    if (!response) {
      return new Response('not found', { status: 404 });
    }
    return new Response(response.body, { status: response.status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('PoliteHttpFetcher', () => {
  it('fetches HTML and sets the identifying user-agent header', async () => {
    const { impl, calls } = makeFakeFetch({
      'https://x.gov.in/robots.txt': { status: 404, body: '' },
      'https://x.gov.in/scheme-a': { status: 200, body: '<html>A</html>' },
    });
    const fetcher = new PoliteHttpFetcher({
      fetchImpl: impl,
      delayPerHostMs: 0,
      sleep: async () => undefined,
    });
    const result = await fetcher.fetch('https://x.gov.in/scheme-a');

    expect(result.html).toBe('<html>A</html>');
    const realCall = calls.find((c) => c.url === 'https://x.gov.in/scheme-a');
    expect(realCall).toBeDefined();
    const headers = realCall?.init?.headers as Record<string, string>;
    expect(headers['user-agent']).toMatch(/BharatBenefitsAI-Crawler/);
  });

  it('blocks a request that robots.txt disallows', async () => {
    const robots = `
      User-agent: *
      Disallow: /private/
    `;
    const { impl } = makeFakeFetch({
      'https://x.gov.in/robots.txt': { status: 200, body: robots },
    });
    const fetcher = new PoliteHttpFetcher({
      fetchImpl: impl,
      delayPerHostMs: 0,
      sleep: async () => undefined,
    });
    await expect(fetcher.fetch('https://x.gov.in/private/secret')).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
  });

  it('caches robots.txt — does not refetch on subsequent same-host requests', async () => {
    const { impl, calls } = makeFakeFetch({
      'https://x.gov.in/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n' },
      'https://x.gov.in/a': { status: 200, body: 'A' },
      'https://x.gov.in/b': { status: 200, body: 'B' },
    });
    const fetcher = new PoliteHttpFetcher({
      fetchImpl: impl,
      delayPerHostMs: 0,
      sleep: async () => undefined,
    });
    await fetcher.fetch('https://x.gov.in/a');
    await fetcher.fetch('https://x.gov.in/b');

    const robotsCalls = calls.filter((c) => c.url === 'https://x.gov.in/robots.txt');
    expect(robotsCalls).toHaveLength(1);
  });

  it('enforces the per-host delay between consecutive requests', async () => {
    const { impl } = makeFakeFetch({
      'https://x.gov.in/robots.txt': { status: 404, body: '' },
      'https://x.gov.in/a': { status: 200, body: 'A' },
      'https://x.gov.in/b': { status: 200, body: 'B' },
    });

    let now = 0;
    const sleeps: number[] = [];
    const fetcher = new PoliteHttpFetcher({
      fetchImpl: impl,
      delayPerHostMs: 1500,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await fetcher.fetch('https://x.gov.in/a');
    now += 200; // 200 ms pass between requests
    await fetcher.fetch('https://x.gov.in/b');

    // Second request had to sleep 1500 - 200 = 1300 ms.
    expect(sleeps).toEqual([1300]);
  });

  it('does not throttle requests across different hosts', async () => {
    const { impl } = makeFakeFetch({
      'https://x.gov.in/robots.txt': { status: 404, body: '' },
      'https://y.gov.in/robots.txt': { status: 404, body: '' },
      'https://x.gov.in/a': { status: 200, body: 'A' },
      'https://y.gov.in/a': { status: 200, body: 'B' },
    });

    let now = 0;
    const sleeps: number[] = [];
    const fetcher = new PoliteHttpFetcher({
      fetchImpl: impl,
      delayPerHostMs: 1500,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await fetcher.fetch('https://x.gov.in/a');
    await fetcher.fetch('https://y.gov.in/a');

    // Different host → no delay enforced.
    expect(sleeps).toEqual([]);
  });

  it('treats a missing robots.txt as "everything allowed"', async () => {
    const { impl } = makeFakeFetch({
      // No /robots.txt entry → fake fetch returns 404.
      'https://x.gov.in/whatever': { status: 200, body: 'ok' },
    });
    const fetcher = new PoliteHttpFetcher({
      fetchImpl: impl,
      delayPerHostMs: 0,
      sleep: async () => undefined,
    });
    const result = await fetcher.fetch('https://x.gov.in/whatever');
    expect(result.html).toBe('ok');
  });

  it('surfaces non-2xx responses as fetch errors', async () => {
    const { impl } = makeFakeFetch({
      'https://x.gov.in/robots.txt': { status: 404, body: '' },
      'https://x.gov.in/gone': { status: 500, body: 'oops' },
    });
    const fetcher = new PoliteHttpFetcher({
      fetchImpl: impl,
      delayPerHostMs: 0,
      sleep: async () => undefined,
    });
    await expect(fetcher.fetch('https://x.gov.in/gone')).rejects.toThrow(/500/);
  });
});
