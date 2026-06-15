'use client';

/**
 * React i18n context provider and hook.
 *
 * Wraps the application root with the active {@link Locale} so any client
 * component can call {@link useTranslation} to look up message keys.
 * Switching the locale via {@link useSetLocale} updates the cookie
 * (Requirement 12.6) and rerenders all subscribers in well under the
 * 2-second target from Requirement 12.2 — there are no network hops on
 * the language-change path; messages are bundled with the app.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DEFAULT_LOCALE,
  LOCALE_HTML_LANG,
  LOCALE_LABELS,
  LOCALE_NAMES_EN,
  SUPPORTED_LOCALES,
  type Locale,
} from './config';
import { writeLocaleToDocument } from './cookie';
import { t, type TranslateResult } from './messages';

/**
 * Translator function exposed to consumers. Returns the resolved string
 * directly for the common case; use {@link TranslateFn.raw} when you need
 * to know whether a fallback occurred (Requirement 12.5).
 */
export interface TranslateFn {
  (key: string, params?: Record<string, string | number>): string;
  /** Lower-level form returning `{ value, usedFallback, missing }`. */
  raw(key: string, params?: Record<string, string | number>): TranslateResult;
}

/** Public surface of {@link I18nContext}. */
export interface I18nContextValue {
  /** Currently active locale. */
  locale: Locale;
  /** All supported locale codes. */
  locales: readonly Locale[];
  /** Native-script display name for the active locale. */
  localeLabel: string;
  /** English (Latin) name of the active locale. */
  localeName: string;
  /** Translator function bound to the active locale. */
  t: TranslateFn;
  /**
   * Updates the active locale. Persists to a cookie (Req 12.6) and
   * notifies subscribers — server-rendered pages still need to rerun
   * if their content depends on locale, but interactive UI updates
   * within the same render tree happen synchronously.
   */
  setLocale(next: Locale): void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export interface I18nProviderProps {
  /** Initial locale resolved on the server (cookie / Accept-Language). */
  initialLocale: Locale;
  /** Optional callback invoked when locale changes — for SSR refresh hooks. */
  onLocaleChange?: (next: Locale) => void;
  children: ReactNode;
}

/**
 * Top-level i18n provider. Mount inside the App Router root layout so the
 * entire client tree has access to the active locale.
 */
export function I18nProvider({
  initialLocale,
  onLocaleChange,
  children,
}: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      writeLocaleToDocument(next);
      onLocaleChange?.(next);
    },
    [onLocaleChange],
  );

  const translator: TranslateFn = useMemo(() => {
    const fn: TranslateFn = ((key, params) => t(locale, key, params).value) as TranslateFn;
    fn.raw = (key, params) => t(locale, key, params);
    return fn;
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      locales: SUPPORTED_LOCALES,
      localeLabel: LOCALE_LABELS[locale],
      localeName: LOCALE_NAMES_EN[locale],
      t: translator,
      setLocale,
    }),
    [locale, translator, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Hook returning the active locale + translator + setter.
 *
 * Throws when used outside an {@link I18nProvider} — that signals a
 * configuration bug (the provider should wrap the entire tree).
 */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used inside an <I18nProvider>');
  }
  return ctx;
}

/**
 * Convenience hook returning just the translator. Mirrors the shape used
 * by libraries like next-intl / react-i18next so call sites stay familiar.
 */
export function useTranslation(): { t: TranslateFn; locale: Locale } {
  const { t: translator, locale } = useI18n();
  return { t: translator, locale };
}

/** Convenience hook returning only the setter. */
export function useSetLocale(): (next: Locale) => void {
  return useI18n().setLocale;
}

/** Returns the BCP-47 lang attribute for the current locale. */
export function useHtmlLang(): string {
  return LOCALE_HTML_LANG[useI18n().locale];
}

// ─── SSR-safe helpers (no hooks) ────────────────────────────────────────────

/** Returns the locale display label without using React state. */
export function getLocaleLabel(locale: Locale): string {
  return LOCALE_LABELS[locale] ?? LOCALE_LABELS[DEFAULT_LOCALE];
}
