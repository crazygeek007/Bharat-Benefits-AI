/**
 * Link extraction for the crawler's discovery loop.
 *
 * Pure function: given an HTML document fetched from `baseUrl`, return a
 * deduplicated list of absolute outbound `<a href>` URLs that are
 * structurally valid HTTP(S) targets. Domain validation (gov.in/nic.in
 * gate) happens downstream so the extractor stays single-responsibility
 * and the validator remains the single source of truth for allow-list
 * policy.
 *
 * Filters applied in this module:
 *   - Drop non-HTTP(S) schemes (mailto:, tel:, javascript:, data:, ftp:).
 *   - Strip URL fragments (#section) so anchor-only links don't pollute
 *     the frontier.
 *   - Resolve relative paths via the standard `URL` constructor against
 *     `baseUrl`.
 *   - Dedupe within the returned list (page-local dedup; frontier-side
 *     dedup is a separate concern).
 *
 * Filters NOT applied here (deliberately):
 *   - Domain allow-list — that's `validateSource`'s job.
 *   - Robots.txt / rate limiting — that's the crawl driver's job.
 *   - Page-type classification — that's `page-classifier.ts`.
 */

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

/**
 * Extracts every outbound `<a href>` URL from `html`, resolved against
 * `baseUrl` into an absolute form. Returns a deduplicated list in
 * document order. Empty / malformed inputs return `[]` rather than
 * throwing so a misbehaving portal page can't break a crawl.
 */
export function extractLinks(baseUrl: string, html: string): string[] {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return [];
  if (typeof html !== 'string' || html.length === 0) return [];

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: string[] = [];

  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href');
    const resolved = resolveLink(raw, base);
    if (!resolved) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  });

  return out;
}

/**
 * Variant of {@link extractLinks} that returns the link text alongside
 * each URL. Useful when a downstream classifier wants to consult the
 * anchor text (e.g. links labelled "Apply" / "Eligibility" suggest a
 * scheme detail page).
 */
export function extractLinksWithText(
  baseUrl: string,
  html: string,
): Array<{ url: string; text: string }> {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return [];
  if (typeof html !== 'string' || html.length === 0) return [];

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: Array<{ url: string; text: string }> = [];

  $('a[href]').each((_, el) => {
    const node = $(el);
    const raw = node.attr('href');
    const resolved = resolveLink(raw, base);
    if (!resolved) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push({ url: resolved, text: cleanText(node.text()) });
  });

  return out;
}

/**
 * Resolve a single `href` value against the base URL. Returns the
 * absolute URL string, or `null` if the value is empty, malformed, or
 * uses a non-HTTP(S) scheme. The fragment is dropped — anchor-only
 * targets are not useful as crawl frontier entries.
 */
function resolveLink(raw: string | undefined, base: URL): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Filter out pure fragments and obviously non-navigable schemes
  // before even trying to construct the URL. The `URL` constructor is
  // permissive with `javascript:` etc., so the protocol check after
  // construction is the real gate.
  if (trimmed.startsWith('#')) return null;
  if (/^(javascript|mailto|tel|data|ftp|file):/i.test(trimmed)) return null;

  let absolute: URL;
  try {
    absolute = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') {
    return null;
  }

  absolute.hash = '';
  return absolute.toString();
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Re-exporting CheerioAPI so callers that need to inspect the same DOM
// for additional signals (e.g. the HTML-signals classifier in a follow-
// up commit) can do so without re-parsing.
export type { CheerioAPI };
