/**
 * Card component used in scheme listing grids.
 *
 * Displays the scheme name, category, ministry, a Central/State Government
 * label (Requirement 2.4), and a short description preview. The card title
 * links through to the per-scheme detail page (Requirement 2.5). A small
 * "Compare" checkbox lets the citizen add the scheme to the
 * side-by-side comparison tool (Req 24).
 */

import type { SchemeWithLevel } from '../lib/api';
import { CompareCheckbox } from './SchemeComparisonBar';

export interface SchemeCardProps {
  scheme: SchemeWithLevel;
}

function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

export function SchemeCard({ scheme }: SchemeCardProps) {
  // Both badge colours pair white text with a background dark enough to
  // clear the WCAG AA 4.5:1 contrast threshold (Req 20.4):
  //   - #0b5394 (Central) →  9.61:1 against white.
  //   - #9c5700 (State)   →  4.95:1 against white.
  const badgeStyle: React.CSSProperties =
    scheme.governmentLevel === 'Central'
      ? { backgroundColor: '#0b5394', color: '#fff' }
      : { backgroundColor: '#9c5700', color: '#fff' };

  const detailHref = `/schemes/detail/${encodeURIComponent(scheme.id)}`;

  return (
    <article
      style={{
        border: '1px solid #d0d7de',
        borderRadius: 8,
        padding: 16,
        marginBottom: 12,
        background: '#fff',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 8,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 18 }}>
          <a
            href={detailHref}
            style={{ color: '#0b5394', textDecoration: 'none' }}
          >
            {scheme.name}
          </a>
        </h3>
        <span
          aria-label={`${scheme.governmentLevel} Government Scheme`}
          style={{
            ...badgeStyle,
            fontSize: 12,
            fontWeight: 600,
            padding: '4px 8px',
            borderRadius: 4,
            whiteSpace: 'nowrap',
          }}
        >
          {scheme.governmentLevel} Govt
        </span>
      </header>
      <div
        style={{
          fontSize: 13,
          color: '#57606a',
          marginBottom: 8,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <span>
          <strong>Category:</strong> {scheme.category}
        </span>
        <span>
          <strong>Ministry:</strong> {scheme.ministry}
        </span>
        {scheme.state && (
          <span>
            <strong>State:</strong> {scheme.state}
          </span>
        )}
      </div>
      <p style={{ margin: '0 0 8px', color: '#24292f' }}>
        {truncate(scheme.description)}
      </p>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          fontSize: 13,
        }}
      >
        <a href={detailHref} style={{ color: '#0b5394' }}>
          View details →
        </a>
        <CompareCheckbox schemeId={scheme.id} schemeName={scheme.name} />
      </div>
    </article>
  );
}
