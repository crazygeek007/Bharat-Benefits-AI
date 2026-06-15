/**
 * Side-by-side comparison table for 2-3 schemes (Requirement 24).
 *
 * Renders a single `<table>` with:
 *   - one column per scheme (header: name, ministry, government level,
 *     official source link),
 *   - one row per attribute (eligibility criteria, benefits, deadline,
 *     required documents, application process),
 *   - one row of eligibility status per scheme (Req 24.6),
 *   - per-row visual highlighting when the values differ (Req 24.4),
 *   - "Information not available" markers for cells the source omits
 *     (Req 24.7) plus a link back to the scheme's official source so the
 *     citizen can verify directly.
 */

import type {
  ApplicationStep,
  Benefit,
  DocumentRequirement,
  EligibilityCriterion,
  EligibilityResult,
} from '@bharat-benefits/shared';
import type {
  ComparisonAttributeKey,
  ComparisonAttributeRow,
  SchemeComparisonResponse,
  SchemeEligibilityRow,
} from '../lib/api';

export interface SchemeComparisonTableProps {
  data: SchemeComparisonResponse;
  /**
   * When false, the eligibility row prompts the citizen to sign in
   * rather than displaying "no profile" copy (Req 24.6).
   */
  isAuthenticated?: boolean;
}

/** Human-readable labels for the comparison rows. */
const ATTRIBUTE_LABELS: Record<ComparisonAttributeKey, string> = {
  eligibilityCriteria: 'Eligibility criteria',
  benefits: 'Benefits',
  deadline: 'Application deadline',
  requiredDocuments: 'Required documents',
  applicationProcess: 'Application process',
};

const MISSING_LABEL = 'Information not available';

const ROW_HIGHLIGHT_BG = '#fff8c5';
const ROW_HIGHLIGHT_BORDER = '#d4a72c';

const ELIGIBILITY_BADGE_STYLES: Record<
  EligibilityResult['status'],
  React.CSSProperties
> = {
  // Background/foreground pairs with WCAG AA contrast ≥ 4.5:1 (Req 20.4).
  Eligible: { backgroundColor: '#15633a', color: '#fff' },
  'Partially Eligible': { backgroundColor: '#8a5d00', color: '#fff' },
  'Not Eligible': { backgroundColor: '#b1232b', color: '#fff' },
};

// ─── Per-attribute renderers ─────────────────────────────────────────────────

function renderEligibilityCriteria(value: unknown) {
  const list = Array.isArray(value) ? (value as EligibilityCriterion[]) : [];
  if (list.length === 0) return null;
  return (
    <ul style={{ paddingLeft: 18, margin: 0 }}>
      {list.map((c, idx) => (
        <li key={`crit-${idx}`} style={{ marginBottom: 4 }}>
          {c.description || `${c.field} ${c.operator} ${String(c.value)}`}
        </li>
      ))}
    </ul>
  );
}

function formatBenefitAmount(amount: number | null): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return '';
  }
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}

function renderBenefits(value: unknown) {
  const list = Array.isArray(value) ? (value as Benefit[]) : [];
  if (list.length === 0) return null;
  return (
    <ul style={{ paddingLeft: 18, margin: 0 }}>
      {list.map((b, idx) => {
        const headline =
          b.type === 'monetary' && typeof b.amount === 'number'
            ? formatBenefitAmount(b.amount)
            : b.type === 'monetary'
              ? 'Monetary benefit'
              : 'Non-monetary benefit';
        return (
          <li key={`benefit-${idx}`} style={{ marginBottom: 4 }}>
            <strong>{headline}</strong>
            {b.description ? <> — {b.description}</> : null}
          </li>
        );
      })}
    </ul>
  );
}

function renderDeadline(value: unknown) {
  if (!value || typeof value !== 'string') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <span>
      {date.toLocaleDateString('en-IN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })}
    </span>
  );
}

function renderDocuments(value: unknown) {
  const list = Array.isArray(value) ? (value as DocumentRequirement[]) : [];
  if (list.length === 0) return null;
  return (
    <ul style={{ paddingLeft: 18, margin: 0 }}>
      {list.map((d, idx) => (
        <li key={`doc-${idx}`} style={{ marginBottom: 4 }}>
          <strong>{d.documentName}</strong>
          {d.required ? null : (
            <span style={{ color: '#57606a' }}> (optional)</span>
          )}
          {d.description ? <> — {d.description}</> : null}
        </li>
      ))}
    </ul>
  );
}

function renderApplicationSteps(value: unknown) {
  const list = Array.isArray(value) ? (value as ApplicationStep[]) : [];
  if (list.length === 0) return null;
  return (
    <ol style={{ paddingLeft: 18, margin: 0 }}>
      {list.map((s, idx) => (
        <li key={`step-${idx}`} style={{ marginBottom: 4 }}>
          <strong>{s.action}</strong>
          {s.expectedOutcome ? <> — <em>{s.expectedOutcome}</em></> : null}
        </li>
      ))}
    </ol>
  );
}

function renderAttributeCell(
  key: ComparisonAttributeKey,
  value: unknown,
): React.ReactNode {
  switch (key) {
    case 'eligibilityCriteria':
      return renderEligibilityCriteria(value);
    case 'benefits':
      return renderBenefits(value);
    case 'deadline':
      return renderDeadline(value);
    case 'requiredDocuments':
      return renderDocuments(value);
    case 'applicationProcess':
      return renderApplicationSteps(value);
    default:
      return null;
  }
}

// ─── Eligibility row helpers ────────────────────────────────────────────────

function renderEligibilityCell(
  row: SchemeEligibilityRow,
  isAuthenticated: boolean,
) {
  if (!row.eligibility) {
    return (
      <span style={{ color: '#57606a', fontSize: 13 }}>
        {isAuthenticated ? (
          <>
            <a href="/profile" style={{ color: '#0b5394' }}>
              Complete your profile
            </a>{' '}
            to see eligibility.
          </>
        ) : (
          <>
            <a href="/login" style={{ color: '#0b5394' }}>
              Sign in
            </a>{' '}
            to see eligibility.
          </>
        )}
      </span>
    );
  }
  const badgeStyle = ELIGIBILITY_BADGE_STYLES[row.eligibility.status];
  return (
    <span
      aria-label={`Eligibility status: ${row.eligibility.status}`}
      style={{
        ...badgeStyle,
        fontSize: 13,
        fontWeight: 600,
        padding: '4px 10px',
        borderRadius: 4,
        whiteSpace: 'nowrap',
      }}
    >
      {row.eligibility.status}
    </span>
  );
}

function eligibilityById(
  rows: ReadonlyArray<SchemeEligibilityRow>,
  schemeId: string,
): SchemeEligibilityRow {
  return (
    rows.find((row) => row.schemeId === schemeId) ?? {
      schemeId,
      eligibility: null,
    }
  );
}

// ─── Top-level table ─────────────────────────────────────────────────────────

export function SchemeComparisonTable({
  data,
  isAuthenticated = true,
}: SchemeComparisonTableProps) {
  const { schemes, attributes, eligibility } = data;
  const cellPadding = '12px 14px';

  return (
    <div
      style={{
        overflowX: 'auto',
        border: '1px solid #d0d7de',
        borderRadius: 8,
      }}
    >
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
        }}
        aria-label="Scheme comparison"
      >
        <colgroup>
          <col style={{ width: 200 }} />
          {schemes.map((s) => (
            <col key={`col-${s.id}`} />
          ))}
        </colgroup>
        <thead>
          <tr style={{ background: '#f6f8fa' }}>
            <th
              scope="col"
              style={{
                textAlign: 'left',
                padding: cellPadding,
                borderBottom: '1px solid #d0d7de',
                verticalAlign: 'top',
              }}
            >
              Attribute
            </th>
            {schemes.map((s) => (
              <th
                key={`th-${s.id}`}
                scope="col"
                style={{
                  textAlign: 'left',
                  padding: cellPadding,
                  borderBottom: '1px solid #d0d7de',
                  verticalAlign: 'top',
                  minWidth: 200,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <a
                    href={`/schemes/detail/${encodeURIComponent(s.id)}`}
                    style={{
                      color: '#0b5394',
                      fontSize: 16,
                      fontWeight: 600,
                      textDecoration: 'none',
                    }}
                  >
                    {s.name}
                  </a>
                  <span
                    aria-label={`${s.governmentLevel} Government Scheme`}
                    style={{
                      backgroundColor:
                        s.governmentLevel === 'Central' ? '#0b5394' : '#9c5700',
                      color: '#fff',
                      fontSize: 12,
                      fontWeight: 600,
                      padding: '2px 6px',
                      borderRadius: 4,
                      width: 'fit-content',
                    }}
                  >
                    {s.governmentLevel} Govt
                  </span>
                  <span style={{ color: '#57606a', fontSize: 12 }}>
                    {s.ministry}
                    {s.state ? ` · ${s.state}` : ''}
                  </span>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Eligibility status row (Req 24.6) — placed first so the citizen
              sees their personalised verdict before the field-by-field
              comparison. */}
          <tr style={{ background: '#fff' }}>
            <th
              scope="row"
              style={{
                textAlign: 'left',
                padding: cellPadding,
                borderBottom: '1px solid #eaeef2',
                verticalAlign: 'top',
                fontWeight: 600,
              }}
            >
              Your eligibility
            </th>
            {schemes.map((s) => (
              <td
                key={`elig-${s.id}`}
                style={{
                  padding: cellPadding,
                  borderBottom: '1px solid #eaeef2',
                  verticalAlign: 'top',
                }}
              >
                {renderEligibilityCell(
                  eligibilityById(eligibility, s.id),
                  isAuthenticated,
                )}
              </td>
            ))}
          </tr>

          {attributes.map((row) => (
            <AttributeRow
              key={`row-${row.attributeName}`}
              row={row}
              schemes={schemes.map((s) => ({
                id: s.id,
                sourceUrl: s.sourceUrl,
              }))}
              cellPadding={cellPadding}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Single attribute row ────────────────────────────────────────────────────

function AttributeRow({
  row,
  schemes,
  cellPadding,
}: {
  row: ComparisonAttributeRow;
  schemes: ReadonlyArray<{ id: string; sourceUrl: string }>;
  cellPadding: string;
}) {
  // Highlight the entire row when values differ across the selected
  // schemes (Req 24.4 / Property 22). A row-level highlight is friendlier
  // to keyboard / screen-reader users than per-cell colouring because the
  // visual cue stays anchored to the row label.
  const rowStyle: React.CSSProperties = row.differs
    ? {
        background: ROW_HIGHLIGHT_BG,
        outline: `1px solid ${ROW_HIGHLIGHT_BORDER}`,
        outlineOffset: '-1px',
      }
    : { background: '#fff' };

  return (
    <tr style={rowStyle} data-differs={row.differs ? 'true' : 'false'}>
      <th
        scope="row"
        style={{
          textAlign: 'left',
          padding: cellPadding,
          borderBottom: '1px solid #eaeef2',
          verticalAlign: 'top',
          fontWeight: 600,
        }}
      >
        <span>{ATTRIBUTE_LABELS[row.attributeName]}</span>
        {row.differs ? (
          <>
            {' '}
            <span
              aria-label="Values differ across schemes"
              title="Values differ"
              style={{ color: ROW_HIGHLIGHT_BORDER, fontSize: 13 }}
            >
              ⚠ differs
            </span>
          </>
        ) : null}
      </th>
      {schemes.map((scheme) => {
        const cell = row.values.find((v) => v.schemeId === scheme.id);
        const rendered = cell ? renderAttributeCell(row.attributeName, cell.value) : null;
        return (
          <td
            key={`cell-${row.attributeName}-${scheme.id}`}
            style={{
              padding: cellPadding,
              borderBottom: '1px solid #eaeef2',
              verticalAlign: 'top',
            }}
          >
            {rendered ?? (
              <span style={{ color: '#57606a', fontSize: 13 }}>
                {MISSING_LABEL}
                {scheme.sourceUrl ? (
                  <>
                    {' '}— see{' '}
                    <a
                      href={scheme.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ color: '#0b5394' }}
                    >
                      official source
                    </a>
                  </>
                ) : null}
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
}
