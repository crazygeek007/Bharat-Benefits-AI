/**
 * Internationalisation configuration.
 *
 * The platform supports six Indian languages (Requirement 12.1). Locale
 * identifiers match `SupportedLanguage` in `@bharat-benefits/shared` so the
 * cookie value can be passed straight through to the backend translation
 * service without re-mapping.
 *
 * English is the default locale and serves as the fallback when a translation
 * is missing for a given key (Requirement 12.5).
 */

import type { SupportedLanguage } from '@bharat-benefits/shared';

/** Locale identifier — matches `SupportedLanguage` from shared types. */
export type Locale = SupportedLanguage;

/** Ordered list of supported locales (English first; default). */
export const SUPPORTED_LOCALES = ['en', 'hi', 'bn', 'ta', 'te', 'mr'] as const;

/** Default platform locale (Requirement 12.5 — English fallback). */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Native-script display names for each locale. Used by the language switcher
 * so each option is recognisable in its own script (e.g. हिन्दी, বাংলা).
 */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  hi: 'हिन्दी',
  bn: 'বাংলা',
  ta: 'தமிழ்',
  te: 'తెలుగు',
  mr: 'मराठी',
};

/** English (Latin-script) names — useful for accessible labels. */
export const LOCALE_NAMES_EN: Record<Locale, string> = {
  en: 'English',
  hi: 'Hindi',
  bn: 'Bengali',
  ta: 'Tamil',
  te: 'Telugu',
  mr: 'Marathi',
};

/** BCP-47 lang attribute value used on `<html lang>`. */
export const LOCALE_HTML_LANG: Record<Locale, string> = {
  en: 'en',
  hi: 'hi-IN',
  bn: 'bn-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  mr: 'mr-IN',
};

/** Type guard: narrows an arbitrary string to `Locale`. */
export function isSupportedLocale(value: unknown): value is Locale {
  return (
    typeof value === 'string' &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Resolves any string into a valid `Locale`. Unknown or undefined inputs
 * fall back to {@link DEFAULT_LOCALE} so callers always receive a usable
 * value (Requirement 12.5 — fallback to English).
 */
export function resolveLocale(value: unknown): Locale {
  return isSupportedLocale(value) ? value : DEFAULT_LOCALE;
}
