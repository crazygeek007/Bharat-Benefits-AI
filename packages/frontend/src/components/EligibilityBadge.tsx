/**
 * Renders the citizen's eligibility status as a coloured badge plus the
 * met / unmet / unevaluated criteria breakdown (Req 4.1).
 *
 * The component is intentionally style-light so the detail page can compose
 * it inside its own layout without fighting CSS specificity.
 *
 * Colour contrast (Req 20.4): every badge background / text colour pair
 * carries ≥ 4.5:1 contrast against its foreground. The green/amber tokens
 * are deliberately darker than the brand-marketing palette so the
 * white-text badges remain legible to citizens with low vision.
 */

import type { EligibilityResult } from '@bharat-benefits/shared';

export interface EligibilityBadgeProps {
  /** Eligibility result returned by the backend (null when no profile yet). */
  eligibility: EligibilityResult | null;
  /**
   * Optional flag telling the component whether the citizen is signed in.
   * When false the component renders a sign-in prompt rather than the
   * "complete your profile" copy.
   */
  isAuthenticated?: boolean;
}

const STATUS_STYLES: Record<EligibilityResult['status'], React.CSSProperties> = {
  // White on #15633a → 4.96:1 (≥ 4.5:1, passes WCAG AA for normal text).
  Eligible: { backgroundColor: '#15633a', color: '#fff' },
  // White on #8a5d00 → 5.78:1.
  'Partially Eligible': { backgroundColor: '#8a5d00', color: '#fff' },
  // White on #b1232b → 6.06:1.
  'Not Eligible': { backgroundColor: '#b1232b', color: '#fff' },
};

export function EligibilityBadge({
  eligibility,
  isAuthenticated = true,
}: EligibilityBadgeProps) {
  if (!eligibility) {
    return (
      <section
        aria-labelledby="eligibility-heading"
        style={{
          border: '1px solid #d0d7de',
          borderRadius: 8,
          padding: 16,
          background: '#f6f8fa',
          marginBottom: 16,
        }}
      >
        <h2 id="eligibility-heading" style={{ marginTop: 0, fontSize: 18 }}>
          Your eligibility
        </h2>
        {!isAuthenticated ? (
          <p style={{ margin: 0, color: '#57606a' }}>
            <a href="/login" style={{ color: '#0b5394' }}>
              Sign in
            </a>{' '}
            to see whether you are eligible for this scheme.
          </p>
        ) : (
          <p style={{ margin: 0, color: '#57606a' }}>
            Complete your{' '}
            <a href="/profile" style={{ color: '#0b5394' }}>
              profile
            </a>{' '}
            to see your eligibility for this scheme.
          </p>
        )}
      </section>
    );
  }

  const badgeStyle = STATUS_STYLES[eligibility.status];

  return (
    <section
      aria-labelledby="eligibility-heading"
      style={{
        border: '1px solid #d0d7de',
        borderRadius: 8,
        padding: 16,
        background: '#fff',
        marginBottom: 16,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h2 id="eligibility-heading" style={{ margin: 0, fontSize: 18 }}>
          Your eligibility
        </h2>
        <span
          aria-label={`Eligibility status: ${eligibility.status}`}
          style={{
            ...badgeStyle,
            fontSize: 13,
            fontWeight: 600,
            padding: '4px 10px',
            borderRadius: 4,
          }}
        >
          {eligibility.status}
        </span>
      </header>

      {eligibility.metCriteria.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, margin: '0 0 4px' }}>Criteria you meet</h3>
          <ul style={{ margin: 0, paddingLeft: 18, color: '#1a7f37' }}>
            {eligibility.metCriteria.map((c) => (
              <li key={`met-${c.criterionName}`}>{c.requirement || c.criterionName}</li>
            ))}
          </ul>
        </div>
      )}

      {eligibility.unmetCriteria.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, margin: '0 0 4px' }}>Criteria you do not meet</h3>
          <ul style={{ margin: 0, paddingLeft: 18, color: '#cf222e' }}>
            {eligibility.unmetCriteria.map((c) => (
              <li key={`unmet-${c.criterionName}`}>
                {c.requirement || c.criterionName}
              </li>
            ))}
          </ul>
        </div>
      )}

      {eligibility.unevaluatedCriteria.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, margin: '0 0 4px' }}>
            Could not evaluate (missing profile data)
          </h3>
          <ul style={{ margin: 0, paddingLeft: 18, color: '#7d4e00' }}>
            {eligibility.unevaluatedCriteria.map((c) => (
              <li key={`unev-${c.criterionName}`}>
                {c.requirement || c.criterionName}{' '}
                <span style={{ color: '#57606a' }}>
                  (missing: {c.missingField})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {eligibility.missingProfileFields.length > 0 && (
        <p style={{ margin: 0, color: '#57606a', fontSize: 13 }}>
          Update your{' '}
          <a href="/profile" style={{ color: '#0b5394' }}>
            profile
          </a>{' '}
          to fill in: {eligibility.missingProfileFields.join(', ')}.
        </p>
      )}
    </section>
  );
}
