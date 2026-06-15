/**
 * Unit tests for locale cookie helpers.
 *
 * Validates: Requirements 12.1, 12.6.
 *
 * Covers:
 *   - parseLocaleCookie returns the stored locale when present.
 *   - parseLocaleCookie ignores unsupported locales and returns DEFAULT.
 *   - parseLocaleCookie ignores unrelated cookies and tolerates stray
 *     whitespace / empty segments.
 *   - serializeLocaleCookie emits Path/Max-Age/SameSite (and Secure when
 *     requested) and uses the canonical name.
 *   - serializeLocaleCookie sanitises unsupported input to DEFAULT.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './config';
import {
  LOCALE_COOKIE_MAX_AGE_SECONDS,
  LOCALE_COOKIE_NAME,
  parseLocaleCookie,
  serializeLocaleCookie,
} from './cookie';

describe('parseLocaleCookie', () => {
  it.each(SUPPORTED_LOCALES)('returns %s when stored in the cookie', (locale) => {
    expect(parseLocaleCookie(`${LOCALE_COOKIE_NAME}=${locale}`)).toBe(locale);
  });

  it('returns DEFAULT_LOCALE when the cookie header is empty/null', () => {
    expect(parseLocaleCookie(null)).toBe(DEFAULT_LOCALE);
    expect(parseLocaleCookie('')).toBe(DEFAULT_LOCALE);
  });

  it('returns DEFAULT_LOCALE when the cookie value is unsupported', () => {
    expect(parseLocaleCookie(`${LOCALE_COOKIE_NAME}=fr`)).toBe(DEFAULT_LOCALE);
    expect(parseLocaleCookie(`${LOCALE_COOKIE_NAME}=zz`)).toBe(DEFAULT_LOCALE);
  });

  it('extracts the locale from a multi-cookie header', () => {
    const header = `session=abc; ${LOCALE_COOKIE_NAME}=ta; theme=dark`;
    expect(parseLocaleCookie(header)).toBe('ta');
  });

  it('tolerates extra whitespace and empty segments', () => {
    const header = `  ; ${LOCALE_COOKIE_NAME}=mr ;  `;
    expect(parseLocaleCookie(header)).toBe('mr');
  });

  it('returns DEFAULT_LOCALE when the locale cookie is absent', () => {
    expect(parseLocaleCookie('session=abc; theme=dark')).toBe(DEFAULT_LOCALE);
  });
});

describe('serializeLocaleCookie', () => {
  it('emits the canonical attributes for a supported locale', () => {
    const value = serializeLocaleCookie('hi');
    expect(value).toContain(`${LOCALE_COOKIE_NAME}=hi`);
    expect(value).toContain('Path=/');
    expect(value).toContain(`Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}`);
    expect(value).toContain('SameSite=Lax');
    expect(value).not.toContain('Secure');
  });

  it('appends Secure when requested', () => {
    const value = serializeLocaleCookie('hi', { secure: true });
    expect(value).toContain('Secure');
  });

  it('honours a custom Max-Age', () => {
    const value = serializeLocaleCookie('hi', { maxAgeSeconds: 60 });
    expect(value).toContain('Max-Age=60');
  });

  it('falls back to DEFAULT_LOCALE for unsupported input', () => {
    const value = serializeLocaleCookie('fr' as unknown as 'en');
    expect(value).toContain(`${LOCALE_COOKIE_NAME}=${DEFAULT_LOCALE}`);
  });

  it('is parseable by parseLocaleCookie (round-trip)', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const cookie = serializeLocaleCookie(locale);
      // The Set-Cookie value isn't a valid `Cookie:` request header
      // verbatim — strip attributes by taking the first segment.
      const requestForm = cookie.split(';')[0];
      expect(parseLocaleCookie(requestForm)).toBe(locale);
    }
  });
});
