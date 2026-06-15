/**
 * Server-side locale helpers.
 *
 * Server components and route handlers call {@link getRequestLocale} to
 * resolve the citizen's preferred language. Resolution order:
 *
 *   1. The `bb_locale` cookie (Requirement 12.6 — persisted preference).
 *   2. The `Accept-Language` request header — best-effort match against
 *      our supported locales so a first-time visitor immediately sees
 *      their preferred Indian language when possible.
 *   3. {@link DEFAULT_LOCALE} (English) as the final fallback.
 *
 * The header parser is intentionally tolerant — Accept-Language can be
 * absent, malformed, or list languages we do not support. We never
 * throw; the result is always a valid `Locale`.
 */

import { cookies, headers } from 'next/headers';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  type Locale,
} from './config';
import { LOCALE_COOKIE_NAME } from './cookie';

/**
 * Picks the best-matching supported locale from an `Accept-Language`
 * header value. Returns `null` when no supported locale appears in the
 * header (so the caller can fall through to a different source).
 */
export function pickLocaleFromAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null;
  // Parse entries like "hi-IN;q=0.9, en;q=0.8" into [{tag, q}, ...].
  const entries = header
    .split(',')
    .map((raw) => {
      const [tagRaw, ...params] = raw.trim().split(';');
      const tag = tagRaw?.trim().toLowerCase();
      if (!tag) return null;
      let q = 1;
      for (const param of params) {
        const [k, v] = param.trim().split('=');
        if (k === 'q' && v !== undefined) {
          const parsed = Number.parseFloat(v);
          if (!Number.isNaN(parsed)) q = parsed;
        }
      }
      return { tag, q };
    })
    .filter((entry): entry is { tag: string; q: number } => entry !== null)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of entries) {
    // Try exact match first (e.g. "hi"), then language-only prefix
    // (so "hi-IN" matches "hi").
    if (isSupportedLocale(tag)) return tag;
    const prefix = tag.split('-')[0];
    if (isSupportedLocale(prefix)) return prefix;
  }
  return null;
}

/**
 * Resolves the active locale for an incoming server request. Reads the
 * `bb_locale` cookie first (persisted preference per Req 12.6), then
 * falls back to the `Accept-Language` header, then to English.
 */
export function getRequestLocale(): Locale {
  // `cookies()` and `headers()` are dynamic — calling them within a
  // server component or route handler is safe. We `try` because some
  // contexts (e.g. unit tests that import this module) may not provide
  // the request scope.
  try {
    const cookieStore = cookies();
    const cookieLocale = cookieStore.get(LOCALE_COOKIE_NAME)?.value;
    if (cookieLocale && isSupportedLocale(cookieLocale)) return cookieLocale;
  } catch {
    // No cookie scope — fall through.
  }
  try {
    const headerStore = headers();
    const fromHeader = pickLocaleFromAcceptLanguage(
      headerStore.get('accept-language'),
    );
    if (fromHeader) return fromHeader;
  } catch {
    // No header scope — fall through.
  }
  return DEFAULT_LOCALE;
}

/** Re-export for convenience. */
export { SUPPORTED_LOCALES };
