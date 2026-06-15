/**
 * Translation message catalogue.
 *
 * Each supported locale has a JSON file under `./messages/<locale>.json`
 * with the same shape as the English source. The English catalogue is
 * the canonical schema — every other locale is type-checked against it
 * via the {@link Messages} type so missing keys surface at compile time.
 *
 * At runtime, individual missing keys fall back to the English value so
 * the citizen always sees a usable string (Requirement 12.5). The fact
 * that a fallback occurred is reported to the caller so the UI can show
 * a "translation unavailable" notice.
 */

import en from './messages/en.json';
import hi from './messages/hi.json';
import bn from './messages/bn.json';
import ta from './messages/ta.json';
import te from './messages/te.json';
import mr from './messages/mr.json';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from './config';

/** Concrete shape of the message catalogue (derived from English). */
export type Messages = typeof en;

/** Top-level namespaces (e.g. "nav", "scheme"). */
export type MessageNamespace = keyof Omit<Messages, '$meta'>;

/**
 * All translation catalogues, keyed by locale. Values are typed against
 * the English schema so missing keys are caught at build time.
 */
export const MESSAGES: Record<Locale, Messages> = {
  en,
  hi: hi as Messages,
  bn: bn as Messages,
  ta: ta as Messages,
  te: te as Messages,
  mr: mr as Messages,
};

/**
 * Result of a single translation lookup. The frontend uses
 * {@link usedFallback} to render the visible "translation unavailable"
 * notice required by Requirement 12.5.
 */
export interface TranslateResult {
  /** Resolved string (target translation or English fallback). */
  value: string;
  /** True when the target locale lacked the key and English was used. */
  usedFallback: boolean;
  /** True when the key was missing in BOTH the target locale and English. */
  missing: boolean;
}

/**
 * Looks up a dot-delimited message key (e.g. "nav.schemes") on a typed
 * messages object. Returns `undefined` when any segment is missing or
 * resolves to a non-string value.
 */
function lookupKey(messages: Messages, key: string): string | undefined {
  const segments = key.split('.');
  let cursor: unknown = messages;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

/**
 * Translates `key` for `locale` with English fallback.
 *
 * The lookup order is:
 *   1. Target locale catalogue
 *   2. English catalogue (Requirement 12.5)
 *   3. The key itself (so the UI never renders an empty string)
 */
export function translateKey(locale: Locale, key: string): TranslateResult {
  const messages = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
  const direct = lookupKey(messages, key);
  if (direct !== undefined) {
    return { value: direct, usedFallback: false, missing: false };
  }
  const fallback = lookupKey(MESSAGES[DEFAULT_LOCALE], key);
  if (fallback !== undefined) {
    return { value: fallback, usedFallback: true, missing: false };
  }
  return { value: key, usedFallback: false, missing: true };
}

/**
 * Replaces `{name}` placeholders in `template` with the matching value
 * from `params`. Missing placeholders are left in place to make
 * misconfigurations visible during development.
 */
export function interpolate(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Convenience helper combining {@link translateKey} and
 * {@link interpolate}. The vast majority of UI call sites should use
 * this rather than the lower-level pieces.
 */
export function t(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): TranslateResult {
  const result = translateKey(locale, key);
  if (params) {
    return { ...result, value: interpolate(result.value, params) };
  }
  return result;
}

/**
 * Re-exported supported locales — placed here for the convenience of
 * callers that want a single import for "everything i18n".
 */
export { SUPPORTED_LOCALES };
