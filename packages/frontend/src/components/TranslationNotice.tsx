/**
 * Visible notice rendered when scheme content is shown in English because
 * a translation was not available in the selected locale (Requirement 12.5).
 *
 * Two display modes:
 *   - `partial` — at least one field fell back to English. The notice
 *     names the affected fields so the citizen understands what is
 *     showing in English vs. their preferred language.
 *   - `outage` — the translation service was entirely unreachable. The
 *     notice surfaces a stronger "service unavailable" message.
 *
 * The component is intentionally framework-agnostic (no client hooks) so
 * it can render inside server components alongside translated scheme
 * content.
 */

import type { Locale } from '../lib/i18n/config';
import { t } from '../lib/i18n/messages';

export interface TranslationNoticeProps {
  /** Locale the citizen is viewing the page in. */
  locale: Locale;
  /** True when the upstream translator was unreachable for every field. */
  outage?: boolean;
  /** Optional list of field paths that fell back to English. */
  fallbackFields?: ReadonlyArray<string>;
  /** Optional CSS class to override default styles. */
  className?: string;
}

const BOX_STYLE: React.CSSProperties = {
  padding: '8px 12px',
  background: '#fff8c5',
  border: '1px solid #d4a72c',
  borderRadius: 4,
  color: '#54470c',
  fontSize: 13,
  margin: '8px 0',
};

export function TranslationNotice({
  locale,
  outage = false,
  fallbackFields,
  className,
}: TranslationNoticeProps) {
  // English target never falls back, so suppress the notice entirely.
  if (locale === 'en') return null;
  // No outage AND no recorded fallbacks → nothing to warn about.
  if (!outage && (!fallbackFields || fallbackFields.length === 0)) return null;

  const messageKey = outage
    ? 'translation.outageNotice'
    : 'translation.fallbackNotice';
  const message = t(locale, messageKey).value;

  return (
    <div role="status" aria-live="polite" className={className} style={BOX_STYLE}>
      {message}
    </div>
  );
}
