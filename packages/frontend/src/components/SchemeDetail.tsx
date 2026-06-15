/**
 * Renders the citizen-facing scheme detail body (Req 2.5).
 *
 * Surfaces every official field the platform must display when a citizen
 * selects a scheme:
 *   - Scheme name (heading) and the simplified description
 *   - Eligibility criteria
 *   - Benefits
 *   - Application process / steps
 *   - Required documents (split into Required + Optional)
 *   - Official source URL
 *   - Last verified date
 *
 * The component takes the wire-format detail payload (Date fields are ISO
 * strings) and renders it as a server-component-friendly tree.
 */

import type {
  ApplicationStep,
  Benefit,
  DocumentRequirement,
  EligibilityCriterion,
} from '@bharat-benefits/shared';
import type { SchemeDetailWithLevel } from '../lib/api';

export interface SchemeDetailProps {
  scheme: SchemeDetailWithLevel;
}

function formatDate(iso: string): string {
  // Parse defensively — bad strings should fall back to the raw value so the
  // user still sees the data on the page rather than "Invalid Date".
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatBenefitAmount(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return '';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}

function CriteriaSection({ criteria }: { criteria: EligibilityCriterion[] }) {
  if (!criteria || criteria.length === 0) return null;
  return (
    <section
      aria-labelledby="criteria-heading"
      style={{ marginBottom: 16 }}
    >
      <h2 id="criteria-heading" style={{ fontSize: 18 }}>
        Eligibility criteria
      </h2>
      <ul style={{ paddingLeft: 18, margin: 0 }}>
        {criteria.map((c, idx) => (
          <li key={`crit-${idx}-${c.field}`} style={{ marginBottom: 6 }}>
            {c.description || `${c.field} ${c.operator} ${String(c.value)}`}
          </li>
        ))}
      </ul>
    </section>
  );
}

function BenefitsSection({ benefits }: { benefits: Benefit[] }) {
  if (!benefits || benefits.length === 0) return null;
  return (
    <section
      aria-labelledby="benefits-heading"
      style={{ marginBottom: 16 }}
    >
      <h2 id="benefits-heading" style={{ fontSize: 18 }}>
        Benefits
      </h2>
      <ul style={{ paddingLeft: 18, margin: 0 }}>
        {benefits.map((b, idx) => (
          <li key={`benefit-${idx}`} style={{ marginBottom: 6 }}>
            <strong>
              {b.type === 'monetary' && b.amount !== null
                ? formatBenefitAmount(b.amount)
                : b.type === 'monetary'
                  ? 'Monetary benefit'
                  : 'Non-monetary benefit'}
            </strong>
            {b.description && <> — {b.description}</>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ApplicationStepsSection({
  steps,
  applicationUrl,
  applicationMode,
}: {
  steps: ApplicationStep[] | null;
  applicationUrl: string | null;
  applicationMode: 'online' | 'offline' | 'hybrid';
}) {
  return (
    <section
      aria-labelledby="application-heading"
      style={{ marginBottom: 16 }}
    >
      <h2 id="application-heading" style={{ fontSize: 18 }}>
        How to apply
      </h2>
      <p style={{ margin: '0 0 8px', color: '#57606a', fontSize: 13 }}>
        Application mode: <strong>{applicationMode}</strong>
        {applicationUrl && (
          <>
            {' '}
            ·{' '}
            <a
              href={applicationUrl}
              target="_blank"
              rel="noreferrer noopener"
              style={{ color: '#0b5394' }}
            >
              Official application portal
            </a>
          </>
        )}
      </p>
      {steps && steps.length > 0 ? (
        <ol style={{ paddingLeft: 18, margin: 0 }}>
          {steps.map((step) => (
            <li key={`step-${step.stepNumber}`} style={{ marginBottom: 6 }}>
              <strong>{step.action}</strong>
              {step.expectedOutcome && (
                <>
                  {' '}
                  — <em>{step.expectedOutcome}</em>
                </>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p style={{ margin: 0, color: '#57606a' }}>
          Application steps are not yet detailed for this scheme. Please
          consult the official source.
        </p>
      )}
    </section>
  );
}

function DocumentsSection({ documents }: { documents: DocumentRequirement[] }) {
  if (!documents || documents.length === 0) {
    return (
      <section
        aria-labelledby="docs-heading"
        style={{ marginBottom: 16 }}
      >
        <h2 id="docs-heading" style={{ fontSize: 18 }}>
          Required documents
        </h2>
        <p style={{ margin: 0, color: '#57606a' }}>
          No documents are specified for this scheme. Please consult the
          official source.
        </p>
      </section>
    );
  }

  const required = documents.filter((d) => d.required);
  const optional = documents.filter((d) => !d.required);

  return (
    <section
      aria-labelledby="docs-heading"
      style={{ marginBottom: 16 }}
    >
      <h2 id="docs-heading" style={{ fontSize: 18 }}>
        Required documents
      </h2>
      {required.length > 0 && (
        <>
          <h3 style={{ fontSize: 14, margin: '8px 0 4px' }}>Required</h3>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            {required.map((doc, idx) => (
              <li key={`req-${idx}-${doc.documentName}`} style={{ marginBottom: 4 }}>
                <strong>{doc.documentName}</strong>
                {doc.description && <> — {doc.description}</>}
                {doc.format && (
                  <span style={{ color: '#57606a' }}> ({doc.format})</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {optional.length > 0 && (
        <>
          <h3 style={{ fontSize: 14, margin: '12px 0 4px' }}>Optional</h3>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            {optional.map((doc, idx) => (
              <li key={`opt-${idx}-${doc.documentName}`} style={{ marginBottom: 4 }}>
                <strong>{doc.documentName}</strong>
                {doc.description && <> — {doc.description}</>}
                {doc.format && (
                  <span style={{ color: '#57606a' }}> ({doc.format})</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function SchemeDetail({ scheme }: SchemeDetailProps) {
  // Colour contrast (Req 20.4):
  //   - #0b5394 / white = 9.61:1
  //   - #9c5700 / white = 4.95:1
  const badgeStyle: React.CSSProperties =
    scheme.governmentLevel === 'Central'
      ? { backgroundColor: '#0b5394', color: '#fff' }
      : { backgroundColor: '#9c5700', color: '#fff' };

  return (
    <article>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ marginBottom: 8 }}>{scheme.name}</h1>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            alignItems: 'center',
            color: '#57606a',
            fontSize: 13,
          }}
        >
          <span
            aria-label={`${scheme.governmentLevel} Government Scheme`}
            style={{
              ...badgeStyle,
              fontSize: 12,
              fontWeight: 600,
              padding: '4px 8px',
              borderRadius: 4,
            }}
          >
            {scheme.governmentLevel} Govt
          </span>
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
      </header>

      <section style={{ marginBottom: 16 }}>
        <p
          style={{
            margin: 0,
            color: '#24292f',
            fontSize: 16,
            lineHeight: 1.5,
          }}
        >
          {scheme.description}
        </p>
      </section>

      <CriteriaSection criteria={scheme.eligibilityCriteria} />
      <BenefitsSection benefits={scheme.benefits} />
      <ApplicationStepsSection
        steps={scheme.applicationSteps}
        applicationUrl={scheme.applicationUrl}
        applicationMode={scheme.applicationMode}
      />
      <DocumentsSection documents={scheme.documents} />

      <section
        aria-label="Official source and verification"
        style={{
          borderTop: '1px solid #d0d7de',
          paddingTop: 12,
          color: '#57606a',
          fontSize: 13,
          marginTop: 24,
        }}
      >
        <p style={{ margin: '0 0 4px' }}>
          <strong>Official source:</strong>{' '}
          <a
            href={scheme.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: '#0b5394' }}
          >
            {scheme.sourceUrl}
          </a>
        </p>
        <p style={{ margin: 0 }}>
          <strong>Last verified:</strong> {formatDate(scheme.lastVerifiedAt)}
        </p>
      </section>
    </article>
  );
}
