/**
 * Flagged Schemes admin page (Requirements 17.3, 17.5, 17.6).
 *
 * Server component that lists schemes flagged by the Crawler_System or
 * Change_Detector sorted by `flaggedAt` descending. Each row shows the
 * flag reason, source URL, scheme details, and an Approve / Reject
 * action group (the actions are wired through a client component
 * because they need form state).
 */

import Link from 'next/link';
import { getAdminAuthContext } from '../../../lib/admin-auth';
import {
  fetchAdminFlags,
  type FlagStatus,
  type SchemeFlagRecord,
} from '../../../lib/admin-api';
import { FlagActions } from './FlagActions';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

const STATUS_OPTIONS: ReadonlyArray<{
  value: FlagStatus | 'all';
  label: string;
}> = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
];

function readStatus(
  searchParams: Record<string, string | string[] | undefined>,
): FlagStatus | 'all' {
  const raw = searchParams.status;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === 'approved' || value === 'rejected' || value === 'all') return value;
  return 'pending';
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function statusPill(status: FlagStatus) {
  const palette: Record<FlagStatus, { bg: string; fg: string }> = {
    pending: { bg: '#fff8c5', fg: '#7d4e00' },
    approved: { bg: '#dafbe1', fg: '#1a7f37' },
    rejected: { bg: '#ffeef0', fg: '#cf222e' },
  };
  const { bg, fg } = palette[status];
  return (
    <span
      style={{
        background: bg,
        color: fg,
        padding: '2px 8px',
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'capitalize',
      }}
    >
      {status}
    </span>
  );
}

export default async function FlaggedSchemesPage({ searchParams = {} }: PageProps) {
  const status = readStatus(searchParams);
  const { authHeader, isAuthenticated } = await getAdminAuthContext();

  if (!isAuthenticated) {
    return (
      <p>
        <Link href="/api/auth/signin">Sign in as administrator</Link> to view
        flagged schemes.
      </p>
    );
  }

  const result = await fetchAdminFlags(authHeader, { status, limit: 100 });

  if (!result.ok) {
    return (
      <div
        role="alert"
        style={{
          padding: 12,
          border: '1px solid #d73a49',
          background: '#ffeef0',
          color: '#86181d',
          borderRadius: 4,
        }}
      >
        {result.message}
      </div>
    );
  }

  const flags = result.data.flags;

  return (
    <>
      <h2 style={{ marginTop: 0 }}>Flagged schemes</h2>
      <p style={{ color: '#57606a' }}>
        Schemes flagged by the Crawler System or Change Detector for review.
        Sorted by flag date with the most recent first. Approving a flag
        verifies the scheme and lifts it above the citizen-visibility
        threshold; rejecting it keeps the scheme hidden and records your
        reason.
      </p>

      <nav
        aria-label="Filter by status"
        style={{ marginBottom: 16, display: 'flex', gap: 8 }}
      >
        {STATUS_OPTIONS.map((opt) => {
          const isActive = opt.value === status;
          const href = `/admin/flags?status=${opt.value}`;
          return (
            <Link
              key={opt.value}
              href={href}
              style={{
                padding: '6px 12px',
                background: isActive ? '#0b5394' : '#fff',
                color: isActive ? '#fff' : '#24292f',
                border: '1px solid #d0d7de',
                borderRadius: 6,
                textDecoration: 'none',
                fontSize: 13,
              }}
            >
              {opt.label}
            </Link>
          );
        })}
      </nav>

      {flags.length === 0 ? (
        <p style={{ color: '#57606a' }}>
          No flags in this category. The crawl pipeline raises a flag whenever
          a scheme drops below the trust threshold or the change detector
          spots a discrepancy.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {flags.map((flag) => (
            <FlagRow key={flag.id} flag={flag} />
          ))}
        </div>
      )}

      <p style={{ color: '#57606a', marginTop: 16, fontSize: 13 }}>
        Showing {flags.length} of {result.data.totalCount} flag(s).
      </p>
    </>
  );
}

function FlagRow({ flag }: { flag: SchemeFlagRecord }) {
  return (
    <article
      style={{
        background: '#fff',
        border: '1px solid #d0d7de',
        borderRadius: 8,
        padding: 16,
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 16,
      }}
    >
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 4,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16 }}>
            {flag.scheme?.name ?? `Scheme ${flag.schemeId}`}
          </h3>
          {statusPill(flag.status)}
          <span
            style={{
              background: '#eaeef2',
              color: '#57606a',
              padding: '2px 8px',
              borderRadius: 12,
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {flag.flagSource.replace('_', ' ')}
          </span>
        </div>
        <p style={{ margin: '0 0 8px', color: '#24292f' }}>
          <strong>Reason:</strong> {flag.reason}
        </p>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            fontSize: 13,
            color: '#57606a',
          }}
        >
          <span>
            <strong>Flagged:</strong> {formatDate(flag.flaggedAt)}
          </span>
          {flag.scheme && (
            <span>
              <strong>Ministry:</strong> {flag.scheme.ministry}
            </span>
          )}
          {flag.scheme?.state && (
            <span>
              <strong>State:</strong> {flag.scheme.state}
            </span>
          )}
          {flag.scheme && (
            <span>
              <strong>Trust score:</strong> {flag.scheme.trustScore}
            </span>
          )}
          {flag.scheme && (
            <span>
              <strong>Verified:</strong> {flag.scheme.verified ? 'Yes' : 'No'}
            </span>
          )}
        </div>
        {flag.sourceUrl && (
          <p style={{ margin: '8px 0 0', fontSize: 13 }}>
            <a
              href={flag.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#0b5394' }}
            >
              Open source URL
            </a>
          </p>
        )}
        {flag.status !== 'pending' && flag.resolutionNote && (
          <p
            style={{
              margin: '8px 0 0',
              padding: 8,
              background: '#f6f8fa',
              borderRadius: 6,
              fontSize: 13,
              color: '#24292f',
            }}
          >
            <strong>Resolution note:</strong> {flag.resolutionNote}
          </p>
        )}
      </div>
      <div>
        {flag.status === 'pending' ? (
          <FlagActions flagId={flag.id} />
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: '#57606a' }}>
            Resolved {formatDate(flag.resolvedAt)}
          </p>
        )}
      </div>
    </article>
  );
}
