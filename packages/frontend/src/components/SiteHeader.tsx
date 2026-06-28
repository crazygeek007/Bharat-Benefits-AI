'use client';

/**
 * Top-of-page site header with primary navigation.
 *
 * Implements the responsive navigation contract from Requirement 19:
 *   - Below 768px the link list collapses behind a single-tap
 *     hamburger toggle (Req 19.6).
 *   - At 768px and above the toggle is hidden and the links render
 *     inline (Req 19.2 — enhanced layout).
 *   - The toggle, brand link, and every nav link expose ≥44×44 CSS
 *     pixel hit areas via `globals.css` (Req 19.4).
 *
 * The component is intentionally JS-light: the CSS in `globals.css`
 * controls visibility based on the `data-open` attribute and the
 * viewport breakpoint, so the only runtime work is flipping that
 * attribute on toggle. Nav link clicks close the menu so a citizen who
 * taps "Schemes" on their phone is not stuck looking at an open
 * panel after the page changes.
 *
 * The header is a `<header role="banner">` and the link list is a
 * `<nav role="navigation" aria-label="Primary">` so screen readers
 * see the standard landmark regions (this also satisfies the landmark
 * requirement from Requirement 20.5).
 */

import { useCallback, useId, useState } from 'react';
import { LanguageSwitcher } from './LanguageSwitcher';
import { AuthButton } from './AuthButton';
import { useI18n } from '../lib/i18n/I18nProvider';

/** Single nav entry: i18n key + destination href. */
interface NavLinkSpec {
  /** Dot-delimited message key consumed by the i18n translator. */
  messageKey: string;
  /** Target path. Same-origin route handled by the Next.js router. */
  href: string;
}

const PRIMARY_NAV_LINKS: readonly NavLinkSpec[] = [
  { messageKey: 'nav.schemes', href: '/schemes' },
  { messageKey: 'nav.assistant', href: '/assistant' },
  { messageKey: 'nav.compare', href: '/schemes/compare' },
  { messageKey: 'nav.dashboard', href: '/dashboard' },
  { messageKey: 'nav.profile', href: '/profile' },
];

export interface SiteHeaderProps {
  /**
   * Active path used to mark the matching link as `aria-current="page"`.
   * Optional because the active route isn't always available in tests
   * or from server contexts; pages that want the highlight should
   * pass it explicitly.
   */
  currentPath?: string;
}

export function SiteHeader({ currentPath }: SiteHeaderProps = {}) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);

  // Stable id to wire `aria-controls` ↔ the nav element.
  const generatedId = useId();
  const navId = `bb-primary-nav-${generatedId.replace(/:/g, '')}`;

  const toggleMenu = useCallback(() => setIsOpen((open) => !open), []);
  const closeMenu = useCallback(() => setIsOpen(false), []);

  const toggleLabel = isOpen ? t('nav.closeMenu') : t('nav.openMenu');

  return (
    <header className="bb-site-header" role="banner">
      <div className="bb-site-header__inner">
        <a
          href="/"
          className="bb-site-header__brand"
          aria-label={t('app.title')}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 30,
              borderRadius: 8,
              background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #d946ef 100%)',
              color: '#fff',
              fontSize: 14,
              fontWeight: 700,
              boxShadow: '0 0 0 1px rgba(99, 102, 241, 0.2), 0 2px 4px rgba(99, 102, 241, 0.2)',
            }}
          >
            ✦
          </span>
          <span>{t('app.title')}</span>
        </a>

        <div className="bb-site-header__controls">
          {/* Desktop-only cluster: LanguageSwitcher + AuthButton sit in
              the header top-right. Hidden on mobile via CSS — on
              phones the same controls render inside the hamburger
              menu (see `.bb-nav__extras` below). This is the premium
              mobile pattern Notion/Linear/Stripe all use: keep the
              header clean (just brand + hamburger) and tuck auth +
              settings inside the menu. */}
          <div className="bb-header-desktop-controls">
            <LanguageSwitcher />
            <AuthButton />
          </div>
          <button
            type="button"
            className="bb-nav-toggle"
            aria-controls={navId}
            aria-expanded={isOpen}
            aria-label={toggleLabel}
            onClick={toggleMenu}
          >
            <span aria-hidden="true">{isOpen ? '✕' : '☰'}</span>
          </button>
        </div>

        <nav
          id={navId}
          className="bb-nav"
          role="navigation"
          aria-label={t('nav.primaryAriaLabel')}
          data-open={isOpen ? 'true' : 'false'}
        >
          <ul className="bb-nav__list">
            {PRIMARY_NAV_LINKS.map((link) => {
              const label = t(link.messageKey);
              const isCurrent =
                currentPath !== undefined &&
                isActivePath(currentPath, link.href);
              return (
                <li key={link.href} className="bb-nav__item">
                  <a
                    href={link.href}
                    className="bb-nav__link"
                    aria-current={isCurrent ? 'page' : undefined}
                    onClick={closeMenu}
                  >
                    {label}
                  </a>
                </li>
              );
            })}
          </ul>
          {/* Mobile-only menu extras: Language switcher + Sign in /
              user menu. Hidden ≥768px (the desktop header already
              shows them top-right). Rendering both copies is cheap —
              useSession() shares context, useId() generates unique
              ids per call. */}
          <div className="bb-nav__extras">
            <LanguageSwitcher />
            <AuthButton />
          </div>
        </nav>
      </div>
    </header>
  );
}

/**
 * Returns true when `href` represents the currently active page given
 * `currentPath`. Exact match for "/" so that every page does not light
 * up the home tab; prefix match (with boundary) for nested routes.
 *
 * Exported so unit tests can validate the matching rules without
 * rendering the full component.
 */
export function isActivePath(currentPath: string, href: string): boolean {
  if (href === '/') {
    return currentPath === '/' || currentPath === '';
  }
  if (currentPath === href) return true;
  return currentPath.startsWith(`${href}/`);
}
