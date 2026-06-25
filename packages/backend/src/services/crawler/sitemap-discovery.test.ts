/**
 * Unit tests for the sitemap-driven URL discovery loop.
 *
 * Uses an in-memory fake fetcher so the recursion / dedup / cap logic
 * is exercised end-to-end without standing up a real HTTP client.
 */

import { describe, expect, it } from 'vitest';
import {
  discoverFromSitemaps,
  resolveSitemapSeeds,
  type SitemapDiscoveryFetcher,
} from './sitemap-discovery';

function makeFakeFetcher(map: Record<string, string>): SitemapDiscoveryFetcher {
  return {
    async fetch(url) {
      const body = map[url];
      if (body === undefined) throw new Error(`no fake for ${url}`);
      return { body, finalUrl: url };
    },
  };
}

// ─── Basic flow ──────────────────────────────────────────────────────────────

describe('discoverFromSitemaps', () => {
  it('returns URLs from a flat urlset seed', async () => {
    const fetcher = makeFakeFetcher({
      'https://x.gov.in/sitemap.xml': `<urlset>
        <url><loc>https://x.gov.in/a</loc></url>
        <url><loc>https://x.gov.in/b</loc></url>
      </urlset>`,
    });
    const result = await discoverFromSitemaps(
      ['https://x.gov.in/sitemap.xml'],
      fetcher,
    );
    expect(result.urls.map((u) => u.url).sort()).toEqual([
      'https://x.gov.in/a',
      'https://x.gov.in/b',
    ]);
    expect(result.sitemapsParsed).toBe(1);
    expect(result.sitemapFailures).toBe(0);
  });

  it('recurses through a sitemap index to the child urlsets', async () => {
    const fetcher = makeFakeFetcher({
      'https://x.gov.in/sitemap.xml': `<sitemapindex>
        <sitemap><loc>https://x.gov.in/sitemap-0.xml</loc></sitemap>
        <sitemap><loc>https://x.gov.in/sitemap-1.xml</loc></sitemap>
      </sitemapindex>`,
      'https://x.gov.in/sitemap-0.xml': `<urlset>
        <url><loc>https://x.gov.in/scheme-a</loc></url>
      </urlset>`,
      'https://x.gov.in/sitemap-1.xml': `<urlset>
        <url><loc>https://x.gov.in/scheme-b</loc></url>
      </urlset>`,
    });
    const result = await discoverFromSitemaps(
      ['https://x.gov.in/sitemap.xml'],
      fetcher,
    );
    expect(result.urls.map((u) => u.url).sort()).toEqual([
      'https://x.gov.in/scheme-a',
      'https://x.gov.in/scheme-b',
    ]);
    expect(result.sitemapsParsed).toBe(3);
  });

  it('dedupes URLs that appear in multiple child sitemaps', async () => {
    const fetcher = makeFakeFetcher({
      'https://x.gov.in/sitemap.xml': `<sitemapindex>
        <sitemap><loc>https://x.gov.in/s-a.xml</loc></sitemap>
        <sitemap><loc>https://x.gov.in/s-b.xml</loc></sitemap>
      </sitemapindex>`,
      'https://x.gov.in/s-a.xml': `<urlset>
        <url><loc>https://x.gov.in/shared</loc></url>
      </urlset>`,
      'https://x.gov.in/s-b.xml': `<urlset>
        <url><loc>https://x.gov.in/shared</loc></url>
        <url><loc>https://x.gov.in/only-b</loc></url>
      </urlset>`,
    });
    const result = await discoverFromSitemaps(
      ['https://x.gov.in/sitemap.xml'],
      fetcher,
    );
    expect(result.urls.map((u) => u.url).sort()).toEqual([
      'https://x.gov.in/only-b',
      'https://x.gov.in/shared',
    ]);
  });

  it('sorts URLs by lastModified descending (freshest first)', async () => {
    const fetcher = makeFakeFetcher({
      'https://x.gov.in/sitemap.xml': `<urlset>
        <url><loc>https://x.gov.in/old</loc><lastmod>2020-01-01</lastmod></url>
        <url><loc>https://x.gov.in/new</loc><lastmod>2026-06-01</lastmod></url>
      </urlset>`,
    });
    const result = await discoverFromSitemaps(
      ['https://x.gov.in/sitemap.xml'],
      fetcher,
    );
    expect(result.urls.map((u) => u.url)).toEqual([
      'https://x.gov.in/new',
      'https://x.gov.in/old',
    ]);
  });
});

// ─── Error isolation ─────────────────────────────────────────────────────────

describe('discoverFromSitemaps — error isolation', () => {
  it('continues after a sitemap fetch failure', async () => {
    const fetcher: SitemapDiscoveryFetcher = {
      async fetch(url) {
        if (url === 'https://broken.gov.in/sitemap.xml') {
          throw new Error('403 Forbidden');
        }
        if (url === 'https://ok.gov.in/sitemap.xml') {
          return {
            body: `<urlset><url><loc>https://ok.gov.in/a</loc></url></urlset>`,
            finalUrl: url,
          };
        }
        throw new Error('no fake');
      },
    };
    const result = await discoverFromSitemaps(
      [
        'https://broken.gov.in/sitemap.xml',
        'https://ok.gov.in/sitemap.xml',
      ],
      fetcher,
    );
    expect(result.sitemapFailures).toBe(1);
    expect(result.urls.map((u) => u.url)).toEqual(['https://ok.gov.in/a']);
  });

  it('treats non-sitemap XML as an empty urlset (no throw)', async () => {
    const fetcher = makeFakeFetcher({
      'https://x.gov.in/sitemap.xml': '<html><body>not a sitemap</body></html>',
    });
    const result = await discoverFromSitemaps(
      ['https://x.gov.in/sitemap.xml'],
      fetcher,
    );
    expect(result.sitemapsParsed).toBe(1);
    expect(result.urls).toEqual([]);
  });
});

// ─── Caps & domain validation ────────────────────────────────────────────────

describe('discoverFromSitemaps — caps', () => {
  it('honours the global maxUrls cap', async () => {
    const xmlEntries = Array.from({ length: 20 }, (_, i) => `<url><loc>https://x.gov.in/${i}</loc></url>`).join('');
    const fetcher = makeFakeFetcher({
      'https://x.gov.in/sitemap.xml': `<urlset>${xmlEntries}</urlset>`,
    });
    const result = await discoverFromSitemaps(
      ['https://x.gov.in/sitemap.xml'],
      fetcher,
      { maxUrls: 5 },
    );
    expect(result.urls).toHaveLength(5);
  });

  it('honours the per-host sitemap cap', async () => {
    // 3 nested sitemap-index levels, each pointing to one child sitemap
    // — with maxSitemapsPerHost=2 we should only load the first 2.
    const fetcher = makeFakeFetcher({
      'https://x.gov.in/sitemap.xml': `<sitemapindex><sitemap><loc>https://x.gov.in/s-1.xml</loc></sitemap></sitemapindex>`,
      'https://x.gov.in/s-1.xml': `<sitemapindex><sitemap><loc>https://x.gov.in/s-2.xml</loc></sitemap></sitemapindex>`,
      'https://x.gov.in/s-2.xml': `<urlset><url><loc>https://x.gov.in/leaf</loc></url></urlset>`,
    });
    const result = await discoverFromSitemaps(
      ['https://x.gov.in/sitemap.xml'],
      fetcher,
      { maxSitemapsPerHost: 2 },
    );
    expect(result.sitemapsParsed).toBe(2);
    expect(result.urls).toEqual([]);
  });

  it('rejects URLs failing the domain validator', async () => {
    const fetcher = makeFakeFetcher({
      'https://x.gov.in/sitemap.xml': `<urlset>
        <url><loc>https://x.gov.in/keep</loc></url>
        <url><loc>https://malicious.com/drop</loc></url>
      </urlset>`,
    });
    const result = await discoverFromSitemaps(
      ['https://x.gov.in/sitemap.xml'],
      fetcher,
      { validateDomain: (u) => new URL(u).hostname.endsWith('gov.in') },
    );
    expect(result.urls.map((u) => u.url)).toEqual(['https://x.gov.in/keep']);
    expect(result.rejectedByDomain).toBe(1);
  });
});

// ─── resolveSitemapSeeds ────────────────────────────────────────────────────

describe('resolveSitemapSeeds', () => {
  it('derives canonical sitemap URLs from portal seed URLs', () => {
    expect(
      resolveSitemapSeeds([
        'https://www.myscheme.gov.in/',
        'https://www.india.gov.in/my-government/schemes',
      ]),
    ).toEqual([
      'https://www.myscheme.gov.in/sitemap.xml',
      'https://www.india.gov.in/sitemap.xml',
    ]);
  });

  it('dedupes seeds on the same portal', () => {
    expect(
      resolveSitemapSeeds([
        'https://www.india.gov.in/a',
        'https://www.india.gov.in/b',
      ]),
    ).toEqual(['https://www.india.gov.in/sitemap.xml']);
  });

  it('silently drops malformed seed URLs', () => {
    expect(
      resolveSitemapSeeds(['not-a-url', 'https://ok.gov.in/']),
    ).toEqual(['https://ok.gov.in/sitemap.xml']);
  });
});
