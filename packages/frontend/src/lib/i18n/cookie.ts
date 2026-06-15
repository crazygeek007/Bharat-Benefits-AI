/**
 * Locale cookie helpers.
 *
 * Language preference is persisted in a first-party cookie so it survives
 * across sessions (Requirement 12.6). The cookie is named `bb_locale`
 * and uses a 1-year expiry, `SameSite=Lax`, and `Path=/` so it applies
 * to every route. It is intentionally NOT marked HttpOnly: the client-side
 * language switcher needs to read and update it from the browser without a
 * round-trip to the server.
 *
 * Authenticated citizens additionally have `languagePreference` written to
 * their `UserProfile` row (see backend); the cookie is the source of truth
 * for unauthenticated visits and a fast cache for authenticated ones.
 */

import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  resolveLocale,
  type Locale,
} from './config';

/** Cookie name used to persist the citizen's language preference. */
export const LOCALE_COOKIE_NAME = 'bb_locale';

/** One year in seconds — used as `Max-Age` for the locale cookie. */
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Parses a raw `Cookie:` header (or `document.cookie` value) and returns
 * the locale stored in {@link LOCALE_COOKIE_NAME}, falling back to
 * {@link DEFAULT_LOCALE} when the cookie is missing or invalid.
 *
 * The parser is intentionally minimal — it ignores attributes and only
 * looks for the locale pair. It treats whitespace around `;` separators
 * as optional to handle both header and document-cookie inputs.
 */
export function parseLocaleCookie(rawCookieHeader: string | null | undefined): Locale {
  if (!rawCookieHeader) return DEFAULT_LOCALE;
  // Split on `;` and look for `name=value` pairs. We don't decode complex
  // values because locale codes are URL-safe ASCII.
  const parts = rawCookieHeader.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) continue;
    const name = trimmed.slice(0, equalsIndex).trim();
    if (name !== LOCALE_COOKIE_NAME) continue;
    const value = trimmed.slice(equalsIndex + 1).trim();
    return resolveLocale(value);
  }
  return DEFAULT_LOCALE;
}

/**
 * Builds a `Set-Cookie` header value that persists the locale across
 * sessions (Requirement 12.6). The result is suitable for use with
 * Next.js `NextResponse.cookies.set` headers, the Web Fetch API,
 * `Response` objects, or `document.cookie`.
 */
export function serializeLocaleCookie(
  locale: Locale,
  options: { maxAgeSeconds?: number; secure?: boolean } = {},
): string {
  const safe = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  const maxAge = options.maxAgeSeconds ?? LOCALE_COOKIE_MAX_AGE_SECONDS;
  const segments = [
    `${LOCALE_COOKIE_NAME}=${safe}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'SameSite=Lax',
  ];
  if (options.secure) segments.push('Secure');
  return segments.join('; ');
}

/**
 * Browser helper: reads the locale from `document.cookie`. Returns
 * {@link DEFAULT_LOCALE} when running on the server (no `document`).
 */
export function readLocaleFromDocument(): Locale {
  if (typeof document === 'undefined') return DEFAULT_LOCALE;
  return parseLocaleCookie(document.cookie);
}

/**
 * Browser helper: writes the locale to `document.cookie`. No-op on the
 * server. The cookie is automatically marked `Secure` when the page is
 * served over HTTPS (Requirement 16.4 — TLS 1.2+).
 */
export function writeLocaleToDocument(locale: Locale): void {
  if (typeof document === 'undefined') return;
  const isSecure =
    typeof window !== 'undefined' && window.location?.protocol === 'https:';
  document.cookie = serializeLocaleCookie(locale, { secure: isSecure });
}
