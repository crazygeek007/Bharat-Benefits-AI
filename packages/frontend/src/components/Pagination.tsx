/**
 * Pagination control for the scheme listing pages.
 *
 * Renders Previous / Next links plus a "Page N of M" indicator. Page links
 * are server-rendered so the listing remains accessible without JS.
 */

import Link from 'next/link';

export interface PaginationProps {
  page: number;
  totalPages: number;
  /**
   * Builds the href for a given page. Allows callers (e.g. category pages)
   * to keep their existing path while only changing the `page` query param.
   */
  buildHref: (page: number) => string;
}

export function Pagination({ page, totalPages, buildHref }: PaginationProps) {
  if (totalPages <= 1) return null;

  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  const linkStyle: React.CSSProperties = {
    padding: '6px 12px',
    border: '1px solid #d0d7de',
    borderRadius: 4,
    textDecoration: 'none',
    color: '#0b5394',
  };
  const disabledStyle: React.CSSProperties = {
    ...linkStyle,
    color: '#8c959f',
    pointerEvents: 'none',
    background: '#f6f8fa',
  };

  return (
    <nav
      aria-label="Pagination"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginTop: 16,
      }}
    >
      {hasPrev ? (
        <Link href={buildHref(page - 1)} style={linkStyle} rel="prev">
          ← Previous
        </Link>
      ) : (
        <span style={disabledStyle} aria-disabled="true">
          ← Previous
        </span>
      )}

      <span aria-live="polite">
        Page {page} of {totalPages}
      </span>

      {hasNext ? (
        <Link href={buildHref(page + 1)} style={linkStyle} rel="next">
          Next →
        </Link>
      ) : (
        <span style={disabledStyle} aria-disabled="true">
          Next →
        </span>
      )}
    </nav>
  );
}
