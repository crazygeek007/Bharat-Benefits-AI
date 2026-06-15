/**
 * Admin Dashboard overview page (Requirements 17.1, 17.4).
 *
 * Server component that fetches system-health metrics and the analytics
 * rollup in parallel and renders them as a card grid. Each card maps to
 * an acceptance criterion:
 *   - Crawler status + last execution timestamp (Req 17.1).
 *   - Database size in megabytes (Req 17.1).
 *   - Average API response time over the last 24 hours (Req 17.1).
 *   - Total schemes / active citizens / queries-per-day / eligibility
 *     calcs-per-day (Req 17.4).
 *
 * The page renders a graceful sign-in prompt when the citizen has no
 * session, and a friendly inline error when the backend rejects with
 * 401/403/503.
 */

import Link from 'next/link';
import { getAdminAuthContext } from '../../lib/admin-auth';
import {
  fetchAdminAnalytics,
  fetchAdminHealth,
  type AdminApiResult,
  type SystemHealthSnapshot,
} from '../../lib/admin-api';

export const dynamic = 'force-dynamic';

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString();
}

function statusBadge(status: SystemHealthSnapshot['crawler']['status']) {
  const palette: Record<typeof status, { bg: string; fg: string; label: string }> = {
    running: { bg: '#dafbe1', fg: '#1a7f37', label: 'Running' },
    stopped: { bg: '#eaeef2', fg: '#57606a', label: 'Stopped' },
    error: { bg: '#ffeef0', fg: '#cf222e', label: 'Error' },
    unknown: { bg: '#fff8c5', fg: '#7d4e00', label: 'Unknown' },
  };
  const { bg, fg, label } = palette[status] ?? palette.unknown;
  return (
    <span
      style={{
        background: bg,
        color: fg,
        padding: '2px 8px',
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={`card-${title}`}
      style={{
        background: '#fff',
        border: '1px solid #d0d7de',
        borderRadius: 8,
        padding: 16,
      }}
    >
      <h3
        id={`card-${title}`}
        style={{ margin: 0, fontSize: 13, color: '#57606a', fontWeight: 600 }}
      >
        {title}
      </h3>
      <div style={{ marginTop: 8, fontSize: 22, color: '#24292f' }}>
        {children}
      </div>
    </section>
  );
}

function describe<T>(result: AdminApiResult<T>) {
  if (result.ok) return null;
  if (result.status === 401) {
    return 'You need to sign in as an administrator to view this dashboard.';
  }
  if (result.status === 403) {
    return 'Your account does not have administrator access.';
  }
  return result.message ?? 'Unable to load data right now.';
}

export default async function AdminOverviewPage() {
  const { authHeader, isAuthenticated } = await getAdminAuthContext();

  if (!isAuthenticated) {
    return (
      <section
        style={{
          background: '#fff',
          border: '1px solid #d0d7de',
          borderRadius: 8,
          padding: 24,
        }}
      >
        <h2 style={{ marginTop: 0 }}>Sign in required</h2>
        <p style={{ color: '#57606a' }}>
          The admin dashboard requires an administrator account. Please sign
          in to continue.
        </p>
        <Link
          href="/api/auth/signin"
          style={{
            display: 'inline-block',
            background: '#0b5394',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: 6,
            textDecoration: 'none',
          }}
        >
          Sign in
        </Link>
      </section>
    );
  }

  const [health, analytics] = await Promise.all([
    fetchAdminHealth(authHeader),
    fetchAdminAnalytics(authHeader),
  ]);

  const healthError = describe(health);
  const analyticsError = describe(analytics);

  return (
    <>
      <h2 style={{ marginTop: 0 }}>System overview</h2>
      <p style={{ color: '#57606a', marginTop: 0 }}>
        Real-time view of the crawler, database, and API. Analytics are
        averaged over a rolling 30-day window.
      </p>

      {(healthError || analyticsError) && (
        <div
          role="alert"
          style={{
            padding: 12,
            border: '1px solid #d73a49',
            background: '#ffeef0',
            color: '#86181d',
            borderRadius: 4,
            marginBottom: 16,
          }}
        >
          {healthError ?? analyticsError}
        </div>
      )}

      <h3 style={{ marginTop: 24 }}>System health</h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 16,
        }}
      >
        <Card title="Crawler status">
          {health.ok ? (
            <>
              <div>{statusBadge(health.data.crawler.status)}</div>
              <p
                style={{
                  margin: '8px 0 0',
                  fontSize: 13,
                  color: '#57606a',
                }}
              >
                Last run: {formatTimestamp(health.data.crawler.lastExecutionAt)}
              </p>
              {health.data.crawler.errorMessage && (
                <p
                  style={{
                    margin: '4px 0 0',
                    fontSize: 12,
                    color: '#cf222e',
                  }}
                >
                  {health.data.crawler.errorMessage}
                </p>
              )}
            </>
          ) : (
            '—'
          )}
        </Card>
        <Card title="Database size">
          {health.ok ? `${formatNumber(health.data.database.sizeMb)} MB` : '—'}
        </Card>
        <Card title="API response time (24h avg)">
          {health.ok ? (
            <>
              {formatNumber(health.data.api.averageResponseTimeMs)} ms
              <p
                style={{
                  margin: '8px 0 0',
                  fontSize: 12,
                  color: '#57606a',
                }}
              >
                {formatNumber(health.data.api.sampleCount)} samples
              </p>
            </>
          ) : (
            '—'
          )}
        </Card>
      </div>

      <h3 style={{ marginTop: 32 }}>Analytics (last 30 days)</h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 16,
        }}
      >
        <Card title="Total schemes">
          {analytics.ok ? formatNumber(analytics.data.totalSchemes) : '—'}
        </Card>
        <Card title="Active citizens">
          {analytics.ok ? formatNumber(analytics.data.activeCitizens) : '—'}
        </Card>
        <Card title="Queries per day">
          {analytics.ok ? formatNumber(analytics.data.queriesPerDay) : '—'}
        </Card>
        <Card title="Eligibility calcs per day">
          {analytics.ok
            ? formatNumber(analytics.data.eligibilityCalculationsPerDay)
            : '—'}
        </Card>
      </div>

      <p style={{ marginTop: 32, color: '#57606a', fontSize: 13 }}>
        {analytics.ok
          ? `Generated ${formatTimestamp(analytics.data.generatedAt)}`
          : ''}
      </p>
    </>
  );
}
