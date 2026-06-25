/**
 * Sitemap fetcher + parser.
 *
 * Many government portals sit behind bot protection that hard-blocks
 * server-side HTML scrapers (Cloudflare et al. — see the design notes
 * for the discovery feature for the full diagnosis). Sitemap XML
 * endpoints typically get CDN-special-case treatment so search
 * engines can index the site, which means they're often reachable
 * from the same IPs that get 403'd on regular page fetches.
 *
 * This module handles two sitemap shapes per https://sitemaps.org:
 *
 *   `<urlset>`        — flat list of `<url><loc>URL</loc>...</url>` entries.
 *   `<sitemapindex>`  — list of `<sitemap><loc>URL</loc></sitemap>` entries
 *                        pointing to child sitemaps (typically one per
 *                        section of a large site). Recursive — we
 *                        follow up to a configurable depth.
 *
 * Single-responsibility: parse / fetch. Domain allow-list enforcement
 * is the caller's job (same separation we use in `link-extractor.ts`).
 */

import { XMLParser } from 'fast-xml-parser';

export interface SitemapEntry {
  /** Canonical URL declared by the sitemap. */
  url: string;
  /** Optional last-modified date, as parsed from `<lastmod>`. */
  lastModified?: Date;
  /** Optional `<changefreq>` hint. We surface it but don't act on it. */
  changeFrequency?: string;
  /** Optional `<priority>` hint in [0, 1]. */
  priority?: number;
}

export interface SitemapIndexEntry {
  /** Child sitemap URL. */
  url: string;
  /** Optional last-modified date. */
  lastModified?: Date;
}

export type ParsedSitemap =
  | { kind: 'urlset'; urls: SitemapEntry[] }
  | { kind: 'sitemapindex'; sitemaps: SitemapIndexEntry[] };

/**
 * Parse a sitemap XML document. Returns a discriminated union so the
 * caller knows whether to consume the URLs directly or recurse into
 * child sitemaps.
 *
 * Forgiving: malformed entries are skipped rather than throwing — a
 * single bad `<url>` shouldn't tank the whole sitemap pass.
 */
export function parseSitemapXml(xml: string): ParsedSitemap {
  if (typeof xml !== 'string' || xml.trim().length === 0) {
    return { kind: 'urlset', urls: [] };
  }

  // fast-xml-parser is configured to keep the namespace stripped and
  // always-coerce single children into arrays so the same code path
  // handles a 1-element and N-element sitemap.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: true,
    trimValues: true,
    isArray: (name) => name === 'url' || name === 'sitemap',
  });

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return { kind: 'urlset', urls: [] };
  }

  // sitemapindex takes precedence over urlset because a malformed file
  // sometimes has both (we want to recurse into the child sitemaps).
  const indexNode = doc['sitemapindex'] as Record<string, unknown> | undefined;
  if (indexNode && Array.isArray(indexNode['sitemap'])) {
    const sitemaps = (indexNode['sitemap'] as Array<Record<string, unknown>>)
      .map(toSitemapIndexEntry)
      .filter((e): e is SitemapIndexEntry => e !== null);
    return { kind: 'sitemapindex', sitemaps };
  }

  const urlsetNode = doc['urlset'] as Record<string, unknown> | undefined;
  if (urlsetNode && Array.isArray(urlsetNode['url'])) {
    const urls = (urlsetNode['url'] as Array<Record<string, unknown>>)
      .map(toSitemapEntry)
      .filter((e): e is SitemapEntry => e !== null);
    return { kind: 'urlset', urls };
  }

  return { kind: 'urlset', urls: [] };
}

function toSitemapEntry(node: Record<string, unknown>): SitemapEntry | null {
  const loc = readString(node['loc']);
  if (!loc) return null;
  const entry: SitemapEntry = { url: loc };
  const lastmod = readString(node['lastmod']);
  if (lastmod) {
    const d = new Date(lastmod);
    if (!Number.isNaN(d.getTime())) entry.lastModified = d;
  }
  const changefreq = readString(node['changefreq']);
  if (changefreq) entry.changeFrequency = changefreq;
  const priority = readNumber(node['priority']);
  if (priority !== null && priority >= 0 && priority <= 1) entry.priority = priority;
  return entry;
}

function toSitemapIndexEntry(node: Record<string, unknown>): SitemapIndexEntry | null {
  const loc = readString(node['loc']);
  if (!loc) return null;
  const entry: SitemapIndexEntry = { url: loc };
  const lastmod = readString(node['lastmod']);
  if (lastmod) {
    const d = new Date(lastmod);
    if (!Number.isNaN(d.getTime())) entry.lastModified = d;
  }
  return entry;
}

function readString(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return undefined;
}

function readNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
