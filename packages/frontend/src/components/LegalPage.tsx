/**
 * Shared layout for legal/info pages (Privacy, Terms, Accessibility).
 */

interface LegalPageProps {
  pill: string;
  title: string;
  subtitle?: string;
  lastUpdated?: string;
  children: React.ReactNode;
}

export function LegalPage({ pill, title, subtitle, lastUpdated, children }: LegalPageProps) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={{ maxWidth: 780, margin: '0 auto', padding: '60px 24px 100px' }}
    >
      <div style={{ marginBottom: 48 }}>
        <span
          style={{
            display: 'inline-block',
            padding: '5px 12px',
            background: 'rgba(99, 102, 241, 0.08)',
            border: '1px solid rgba(99, 102, 241, 0.2)',
            borderRadius: 9999,
            fontSize: 12,
            fontWeight: 600,
            color: '#4338ca',
            marginBottom: 16,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          {pill}
        </span>
        <h1 style={{ fontSize: 'clamp(32px, 5vw, 48px)', margin: '0 0 12px', lineHeight: 1.1, letterSpacing: '-0.03em' }}>
          {title}
        </h1>
        {subtitle && (
          <p style={{ fontSize: 17, color: '#52525b', margin: 0, lineHeight: 1.5 }}>
            {subtitle}
          </p>
        )}
        {lastUpdated && (
          <p style={{ fontSize: 13, color: '#a1a1aa', margin: '12px 0 0' }}>
            Last updated: {lastUpdated}
          </p>
        )}
      </div>

      <div className="legal-prose">{children}</div>

      <style>{`
        .legal-prose {
          font-size: 16px;
          line-height: 1.7;
          color: #3f3f46;
        }
        .legal-prose h2 {
          font-size: 22px;
          font-weight: 600;
          letter-spacing: -0.02em;
          margin: 40px 0 12px;
          color: #09090b;
        }
        .legal-prose h3 {
          font-size: 17px;
          font-weight: 600;
          margin: 24px 0 8px;
          color: #09090b;
        }
        .legal-prose p {
          margin: 0 0 16px;
          color: #52525b;
        }
        .legal-prose ul, .legal-prose ol {
          padding-left: 24px;
          margin: 0 0 16px;
          color: #52525b;
        }
        .legal-prose li {
          margin-bottom: 6px;
        }
        .legal-prose strong {
          color: #09090b;
          font-weight: 600;
        }
        .legal-prose a {
          color: #6366f1;
          font-weight: 500;
        }
        .legal-prose a:hover {
          color: #4338ca;
        }
        .legal-prose .callout {
          padding: 16px 20px;
          background: rgba(99, 102, 241, 0.05);
          border-left: 3px solid #6366f1;
          border-radius: 8px;
          margin: 20px 0;
          font-size: 14.5px;
        }
        .legal-prose .callout strong {
          display: block;
          margin-bottom: 4px;
        }
      `}</style>
    </main>
  );
}
