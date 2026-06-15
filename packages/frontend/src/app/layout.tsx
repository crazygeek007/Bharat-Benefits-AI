import type { Metadata, Viewport } from 'next';
import './globals.css';
import { I18nProvider } from '../lib/i18n/I18nProvider';
import { LOCALE_HTML_LANG } from '../lib/i18n/config';
import { getRequestLocale } from '../lib/i18n/server';
import { t } from '../lib/i18n/messages';
import { SkipLink } from '../components/SkipLink';
import { LiveAnnouncer } from '../components/LiveAnnouncer';
import { SiteHeader } from '../components/SiteHeader';
import { SessionWrapper } from '../components/SessionWrapper';

/**
 * Root layout (Requirements 20.1, 20.2, 20.5, 20.6).
 *
 * Resolves the citizen's locale on the server (cookie → Accept-Language
 * → English fallback) and:
 *   - Sets the `<html lang>` attribute to the matching BCP-47 tag
 *     (Requirement 20 — accessibility) so screen readers announce the
 *     correct language.
 *   - Renders translated `<title>` / meta description for the active
 *     locale (Requirement 12.2 — interface elements localised).
 *   - Wraps the tree in {@link I18nProvider} so client components can
 *     translate via {@link useTranslation}.
 *   - Mounts the {@link SkipLink} as the first focusable element on
 *     every page (Requirement 20.2 — keyboard navigation) and the
 *     global {@link LiveAnnouncer} for ARIA live announcements
 *     (Requirement 20.6).
 *   - Includes all WCAG landmark regions (Requirement 20.5):
 *     `<header role="banner">` + `<nav>` (via SiteHeader),
 *     page content area for `<main>`, and `<footer role="contentinfo">`.
 *   - Loads `globals.css` once for the entire app so visible focus
 *     indicators (Requirement 20.2), the skip-link styling, the
 *     `.sr-only` utility, and `prefers-reduced-motion` overrides apply
 *     to every route (Requirement 20.1).
 *   - Applies mobile-first responsive layout strategy (Requirement 19.2)
 *     with viewport meta, font-display optimization, and overflow
 *     prevention (Requirement 19.1, 19.5).
 */

/**
 * Viewport configuration for mobile-first design (Req 19.1, 19.2).
 * - width=device-width: use the device's physical width
 * - initial-scale=1: start at 1:1 zoom
 * - viewport-fit=cover: extend to notch areas on modern devices
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export async function generateMetadata(): Promise<Metadata> {
  const locale = getRequestLocale();
  return {
    title: t(locale, 'app.title').value,
    description: t(locale, 'app.tagline').value,
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = getRequestLocale();
  return (
    <html lang={LOCALE_HTML_LANG[locale]}>
      <head>
        {/* Preconnect to font CDN for faster FCP (Req 19.5) */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Inter — modern variable font for the SaaS aesthetic */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
        />
      </head>
      <body>
        <SessionWrapper>
          <I18nProvider initialLocale={locale}>
            <SkipLink />
            <SiteHeader />
            {children}
            <footer
            role="contentinfo"
            style={{
              borderTop: '1px solid #e4e4e7',
              padding: '32px 24px',
              marginTop: 64,
              color: '#71717a',
              fontSize: 13,
              textAlign: 'center',
            }}
          >
            <nav aria-label={t(locale, 'nav.footerAriaLabel').value}>
              <ul
                style={{
                  listStyle: 'none',
                  margin: '0 0 12px',
                  padding: 0,
                  display: 'flex',
                  justifyContent: 'center',
                  gap: 24,
                  flexWrap: 'wrap',
                }}
              >
                <li>
                  <a href="/about" style={{ color: '#52525b', textDecoration: 'none', fontWeight: 500 }}>
                    About
                  </a>
                </li>
                <li>
                  <a href="/privacy" style={{ color: '#52525b', textDecoration: 'none', fontWeight: 500 }}>
                    Privacy
                  </a>
                </li>
                <li>
                  <a href="/terms" style={{ color: '#52525b', textDecoration: 'none', fontWeight: 500 }}>
                    Terms
                  </a>
                </li>
                <li>
                  <a href="/accessibility" style={{ color: '#52525b', textDecoration: 'none', fontWeight: 500 }}>
                    Accessibility
                  </a>
                </li>
              </ul>
            </nav>
            <p style={{ margin: 0, color: '#a1a1aa' }}>
              © 2026 Bharat Benefits AI · Verified data from official government portals only
            </p>
          </footer>
          <LiveAnnouncer />
          </I18nProvider>
        </SessionWrapper>
      </body>
    </html>
  );
}
