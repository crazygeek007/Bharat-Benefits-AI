/**
 * Unit tests for the sitemap XML parser.
 *
 * Exercises the two sitemap shapes per https://sitemaps.org plus the
 * malformed-input / partial-data branches the parser must tolerate
 * without throwing (we don't want a single bad portal sitemap to
 * crash a daily crawl).
 */

import { describe, expect, it } from 'vitest';
import { parseSitemapXml } from './sitemap-fetcher';

describe('parseSitemapXml — urlset', () => {
  it('parses a flat urlset with loc + lastmod entries', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url>
          <loc>https://www.india.gov.in/scheme-a</loc>
          <lastmod>2026-06-24T22:56:23.521Z</lastmod>
        </url>
        <url>
          <loc>https://www.india.gov.in/scheme-b</loc>
          <lastmod>2026-06-23T10:00:00Z</lastmod>
          <changefreq>weekly</changefreq>
          <priority>0.8</priority>
        </url>
      </urlset>`;
    const result = parseSitemapXml(xml);
    expect(result.kind).toBe('urlset');
    if (result.kind !== 'urlset') return;
    expect(result.urls).toHaveLength(2);
    expect(result.urls[0]).toMatchObject({
      url: 'https://www.india.gov.in/scheme-a',
    });
    expect(result.urls[0].lastModified).toBeInstanceOf(Date);
    expect(result.urls[1]).toMatchObject({
      url: 'https://www.india.gov.in/scheme-b',
      changeFrequency: 'weekly',
      priority: 0.8,
    });
  });

  it('handles a single-entry urlset (array coercion)', () => {
    const xml = `<urlset>
      <url><loc>https://x.gov.in/only</loc></url>
    </urlset>`;
    const result = parseSitemapXml(xml);
    expect(result.kind).toBe('urlset');
    if (result.kind !== 'urlset') return;
    expect(result.urls).toEqual([{ url: 'https://x.gov.in/only' }]);
  });

  it('skips entries without a <loc>', () => {
    const xml = `<urlset>
      <url><lastmod>2026-01-01</lastmod></url>
      <url><loc>https://x.gov.in/keep</loc></url>
    </urlset>`;
    const result = parseSitemapXml(xml);
    if (result.kind !== 'urlset') throw new Error('expected urlset');
    expect(result.urls).toEqual([{ url: 'https://x.gov.in/keep' }]);
  });

  it('drops priority values outside [0, 1]', () => {
    const xml = `<urlset>
      <url><loc>https://x.gov.in/a</loc><priority>2.5</priority></url>
    </urlset>`;
    const result = parseSitemapXml(xml);
    if (result.kind !== 'urlset') throw new Error('expected urlset');
    expect(result.urls[0].priority).toBeUndefined();
  });
});

describe('parseSitemapXml — sitemapindex', () => {
  it('parses a sitemap index with child URLs', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap>
          <loc>https://x.gov.in/sitemap-0.xml</loc>
          <lastmod>2026-06-24T00:00:00Z</lastmod>
        </sitemap>
        <sitemap>
          <loc>https://x.gov.in/sitemap-1.xml</loc>
        </sitemap>
      </sitemapindex>`;
    const result = parseSitemapXml(xml);
    expect(result.kind).toBe('sitemapindex');
    if (result.kind !== 'sitemapindex') return;
    expect(result.sitemaps).toHaveLength(2);
    expect(result.sitemaps.map((s) => s.url)).toEqual([
      'https://x.gov.in/sitemap-0.xml',
      'https://x.gov.in/sitemap-1.xml',
    ]);
    expect(result.sitemaps[0].lastModified).toBeInstanceOf(Date);
  });

  it('matches the real myscheme.gov.in sitemap shape', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://www.myscheme.gov.in/sitemap-0.xml</loc></sitemap>
      <sitemap><loc>https://www.myscheme.gov.in/sitemap.xml</loc></sitemap>
      </sitemapindex>`;
    const result = parseSitemapXml(xml);
    expect(result.kind).toBe('sitemapindex');
    if (result.kind !== 'sitemapindex') return;
    expect(result.sitemaps.map((s) => s.url)).toEqual([
      'https://www.myscheme.gov.in/sitemap-0.xml',
      'https://www.myscheme.gov.in/sitemap.xml',
    ]);
  });
});

describe('parseSitemapXml — degenerate inputs', () => {
  it('returns an empty urlset for empty / whitespace input', () => {
    expect(parseSitemapXml('').kind).toBe('urlset');
    expect(parseSitemapXml('   \n').kind).toBe('urlset');
  });

  it('returns an empty urlset for non-sitemap XML', () => {
    const result = parseSitemapXml('<html><body>not a sitemap</body></html>');
    expect(result.kind).toBe('urlset');
    if (result.kind !== 'urlset') return;
    expect(result.urls).toEqual([]);
  });

  it('does not throw on truncated / malformed XML', () => {
    expect(() => parseSitemapXml('<urlset><url><loc>')).not.toThrow();
    expect(() => parseSitemapXml('not xml at all')).not.toThrow();
  });
});
