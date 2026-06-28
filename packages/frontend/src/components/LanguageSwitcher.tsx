'use client';

/**
 * Language switcher.
 *
 * Lets a citizen change their interface language (Requirement 12.1) with
 * the new selection persisted via cookie (Requirement 12.6). The switch
 * happens client-side — translations are bundled with the app — so the
 * 2-second target from Requirement 12.2 is comfortably met (in practice
 * the rerender is sub-100ms).
 *
 * Each option label is shown in its native script (हिन्दी, বাংলা, தமிழ்,
 * తెలుగు, मराठी) so the option is recognisable to users in any starting
 * language. The Latin name is preserved as the option's `title` and as
 * accessible text for screen readers.
 */

import { useTransition, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  LOCALE_LABELS,
  LOCALE_NAMES_EN,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  type Locale,
} from '../lib/i18n/config';
import { useI18n } from '../lib/i18n/I18nProvider';

export interface LanguageSwitcherProps {
  /** Optional id for label association. */
  id?: string;
  /** Optional CSS class to override default styles. */
  className?: string;
  /**
   * Whether to refresh the current route after a locale change. Defaults
   * to `true` so server components re-render against the new cookie.
   * Set to `false` for purely client-side surfaces (e.g. tests).
   */
  refreshOnChange?: boolean;
}

const SELECT_STYLE: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid #d0d7de',
  borderRadius: 4,
  fontSize: 14,
  background: '#fff',
};

const LABEL_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 14,
  color: '#24292f',
};

export function LanguageSwitcher({
  id = 'bb-language-switcher',
  className,
  refreshOnChange = true,
}: LanguageSwitcherProps) {
  const { locale, setLocale, t } = useI18n();
  const router = useRouter();
  const [, startTransition] = useTransition();

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    if (!isSupportedLocale(next)) return;
    if (next === locale) return;
    setLocale(next as Locale);
    if (refreshOnChange) {
      // `router.refresh()` re-runs server components against the updated
      // cookie so server-rendered scheme content swaps to the new locale.
      // Wrapped in a transition to avoid blocking the language selector.
      startTransition(() => router.refresh());
    }
  }

  return (
    <label htmlFor={id} className={className} style={LABEL_STYLE}>
      <span aria-hidden="true">🌐</span>
      {/* "Language" text label is hidden on mobile via .bb-lang-label
         in responsive.css so the header fits on a single row on phones
         (the globe icon + dropdown carry enough meaning on their own). */}
      <span className="bb-lang-label">{t('languageSwitcher.label')}</span>
      <select
        id={id}
        value={locale}
        onChange={handleChange}
        aria-label={t('languageSwitcher.ariaLabel')}
        style={SELECT_STYLE}
      >
        {SUPPORTED_LOCALES.map((code) => (
          <option key={code} value={code} title={LOCALE_NAMES_EN[code]}>
            {LOCALE_LABELS[code]}
          </option>
        ))}
      </select>
    </label>
  );
}
