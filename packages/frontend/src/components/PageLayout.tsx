/**
 * Accessible page layout with landmark regions (Requirement 20.5).
 *
 * Provides the semantic structure that screen readers rely on to
 * navigate major page sections:
 *
 *   - `<header role="banner">` — site header with primary navigation
 *   - `<nav>` — primary navigation (inside header via SiteHeader)
 *   - `<main>` — primary content area (id="main-content" for skip link)
 *   - `<aside>` — optional complementary sidebar
 *   - `<footer>` — site footer with supplementary links
 *
 * This component wraps individual page content so every route gets
 * consistent landmarks without repeating the boilerplate. The root
 * layout renders the SkipLink and LiveAnnouncer; this component
 * handles the visual shell.
 *
 * Heading hierarchy: The SiteHeader renders the brand as a link (not
 * a heading) so that each page's `<main>` owns its own `<h1>`. This
 * prevents heading-level conflicts and ensures every page starts
 * with h1 (Req 20.5).
 */

import { SiteHeader } from './SiteHeader';
import { MAIN_CONTENT_ID } from './SkipLink';

export interface PageLayoutProps {
  /** The current route path for active nav highlighting. */
  currentPath?: string;
  /** Optional sidebar content rendered in an <aside> landmark. */
  aside?: React.ReactNode;
  /** ARIA label for the aside region (required when aside is provided). */
  asideLabel?: string;
  /** Main page content. */
  children: React.ReactNode;
}

const mainStyle: React.CSSProperties = {
  maxWidth: 1200,
  margin: '0 auto',
  padding: '24px 16px',
  minHeight: 'calc(100vh - 160px)',
};

const contentWrapperStyle: React.CSSProperties = {
  display: 'flex',
  gap: 24,
  alignItems: 'flex-start',
};

const mainContentStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const asideStyle: React.CSSProperties = {
  width: 280,
  flexShrink: 0,
  position: 'sticky' as const,
  top: 16,
};

const footerStyle: React.CSSProperties = {
  borderTop: '1px solid #d0d7de',
  padding: '24px 16px',
  marginTop: 48,
  color: '#57606a',
  fontSize: 13,
  textAlign: 'center' as const,
};

export function PageLayout({
  currentPath,
  aside,
  asideLabel = 'Supplementary information',
  children,
}: PageLayoutProps) {
  return (
    <>
      <SiteHeader currentPath={currentPath} />

      <div style={mainStyle}>
        <div style={contentWrapperStyle}>
          <main
            id={MAIN_CONTENT_ID}
            tabIndex={-1}
            style={mainContentStyle}
            aria-label="Main content"
          >
            {children}
          </main>

          {aside && (
            <aside aria-label={asideLabel} style={asideStyle}>
              {aside}
            </aside>
          )}
        </div>
      </div>

      <footer role="contentinfo" style={footerStyle}>
        <nav aria-label="Footer navigation">
          <ul
            style={{
              listStyle: 'none',
              margin: '0 0 8px',
              padding: 0,
              display: 'flex',
              justifyContent: 'center',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <li>
              <a href="/about" style={{ color: '#0b5394' }}>
                About
              </a>
            </li>
            <li>
              <a href="/privacy" style={{ color: '#0b5394' }}>
                Privacy Policy
              </a>
            </li>
            <li>
              <a href="/terms" style={{ color: '#0b5394' }}>
                Terms of Service
              </a>
            </li>
            <li>
              <a href="/accessibility" style={{ color: '#0b5394' }}>
                Accessibility
              </a>
            </li>
          </ul>
        </nav>
        <p style={{ margin: 0 }}>
          © {new Date().getFullYear()} Bharat Benefits AI. Data sourced
          exclusively from official government portals.
        </p>
      </footer>
    </>
  );
}
