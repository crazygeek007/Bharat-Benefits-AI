/**
 * Unit tests for `pickLocaleFromAcceptLanguage`.
 *
 * Validates: Requirements 12.1, 12.6 (header-based resolution path).
 *
 * The full `getRequestLocale` helper is exercised via integration tests
 * because it depends on Next.js `cookies()` / `headers()` which require
 * a request scope. The header parser is the part with non-trivial logic
 * and is testable in isolation.
 */

import { describe, it, expect } from 'vitest';
import { pickLocaleFromAcceptLanguage } from './server';

describe('pickLocaleFromAcceptLanguage', () => {
  it('returns null when the header is missing', () => {
    expect(pickLocaleFromAcceptLanguage(null)).toBeNull();
    expect(pickLocaleFromAcceptLanguage('')).toBeNull();
  });

  it('matches a supported locale exactly', () => {
    expect(pickLocaleFromAcceptLanguage('hi')).toBe('hi');
    expect(pickLocaleFromAcceptLanguage('bn')).toBe('bn');
  });

  it('matches a language-only prefix from a regional tag', () => {
    expect(pickLocaleFromAcceptLanguage('hi-IN')).toBe('hi');
    expect(pickLocaleFromAcceptLanguage('ta-LK')).toBe('ta');
  });

  it('respects q-value ordering across multiple entries', () => {
    // English wins because it has the higher q-value despite appearing later.
    expect(
      pickLocaleFromAcceptLanguage('hi-IN;q=0.5, en-US;q=0.9, mr;q=0.4'),
    ).toBe('en');
  });

  it('returns null when no entry matches a supported locale', () => {
    expect(pickLocaleFromAcceptLanguage('fr-FR, de;q=0.8')).toBeNull();
  });

  it('falls back to language prefix when regional variant is unsupported', () => {
    // Indian Marathi fictional region — `mr` should still be selected.
    expect(pickLocaleFromAcceptLanguage('mr-XX')).toBe('mr');
  });

  it('treats malformed entries as non-matches without throwing', () => {
    expect(pickLocaleFromAcceptLanguage(',,,')).toBeNull();
    expect(pickLocaleFromAcceptLanguage('en;q=notanumber')).toBe('en');
  });
});
