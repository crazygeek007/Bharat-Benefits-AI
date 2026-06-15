/**
 * Public i18n surface for the frontend.
 *
 * Importers SHOULD pull from this barrel rather than the individual
 * modules — it keeps the API surface explicit and hides internal
 * structure (e.g. messages JSON paths) from call sites.
 */

export {
  DEFAULT_LOCALE,
  LOCALE_HTML_LANG,
  LOCALE_LABELS,
  LOCALE_NAMES_EN,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  resolveLocale,
} from './config';
export type { Locale } from './config';

export {
  LOCALE_COOKIE_NAME,
  LOCALE_COOKIE_MAX_AGE_SECONDS,
  parseLocaleCookie,
  serializeLocaleCookie,
  readLocaleFromDocument,
  writeLocaleToDocument,
} from './cookie';

export {
  MESSAGES,
  t,
  translateKey,
  interpolate,
} from './messages';
export type { Messages, MessageNamespace, TranslateResult } from './messages';

export {
  I18nProvider,
  useI18n,
  useTranslation,
  useSetLocale,
  useHtmlLang,
  getLocaleLabel,
} from './I18nProvider';
export type { I18nContextValue, I18nProviderProps, TranslateFn } from './I18nProvider';

// Server helpers are intentionally NOT re-exported from the barrel — they
// import `next/headers` which is server-only. Import them directly via
// `@/lib/i18n/server` from server components and route handlers.
