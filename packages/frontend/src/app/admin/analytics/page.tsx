/**
 * Admin Analytics page (Requirement 17.4).
 *
 * Server component that displays the rolling 30-day analytics rollup
 * alongside the system-health snapshot so administrators have a
 * single landing surface for "is everything OK".
 */

import Link from 'next/link';
import { getAdminAuthContext } from '../../../lib/admin-auth';
import {
  fetchAdminAnalytics,
  fetchAdminHealth,
} from '../../../lib/admin-api';

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

export default async function AdminAnalyticsPage() {
  const { authHeader, isAuthenticated } = await getAdminAuthContext();
  if (!isAuthenticated) {
    return (
      <p>
        <Link href="/api/auth/signin">Sign in as administrator</Link> to view
        analytics.
      </p>
    );
  }

  const [analytics, health] = await Promise.all([
    fetchAdminAnalytics(authHeader),
    fetchAdminHealth(authHeader),
  ]);

  if (!analytics.ok) {
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
        {analytics.message}
      </div>
    );
  }

  const a = analytics.data;
  const h = health.ok ? health.data : null;

  return (
    <>
      <h2 style={{ marginTop: 0 }}>Analytics</h2>
      <p style={{ color: '#57606a' }}>
        Calculated over a rolling {a.windowDays}-day window. Generated{' '}
        {formatTimestamp(a.generatedAt)}.
      </p>

      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          background: '#fff',
          border: '1px solid #d0d7de',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <thead style={{ background: '#f6f8fa', textAlign: 'left' }}>
          <tr>
            <th style={{ padding: 12, fontSize: 13 }}>Metric</th>
            <th style={{ padding: 12, fontSize: 13 }}>Value</th>
            <th style={{ padding: 12, fontSize: 13 }}>Window</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ padding: 12 }}>Total schemes</td>
            <td style={{ padding: 12 }}>{formatNumber(a.totalSchemes)}</td>
            <td style={{ padding: 12, color: '#57606a' }}>Lifetime</td>
          </tr>
          <tr>
            <td style={{ padding: 12 }}>Active citizens</td>
            <td style={{ padding: 12 }}>{formatNumber(a.activeCitizens)}</td>
            <td style={{ padding: 12, color: '#57606a' }}>
              Logged in within {a.windowDays} days
            </td>
          </tr>
          <tr>
            <td style={{ padding: 12 }}>Queries per day</td>
            <td style={{ padding: 12 }}>{formatNumber(a.queriesPerDay)}</td>
            <td style={{ padding: 12, color: '#57606a' }}>
              Average over {a.windowDays} days
            </td>
          </tr>
          <tr>
            <td style={{ padding: 12 }}>Eligibility calcs per day</td>
            <td style={{ padding: 12 }}>
              {formatNumber(a.eligibilityCalculationsPerDay)}
            </td>
            <td style={{ padding: 12, color: '#57606a' }}>
              Average over {a.windowDays} days
            </td>
          </tr>
          {h && (
            <>
              <tr>
                <td style={{ padding: 12 }}>Database size</td>
                <td style={{ padding: 12 }}>
                  {formatNumber(h.database.sizeMb)} MB
                </td>
                <td style={{ padding: 12, color: '#57606a' }}>Current</td>
              </tr>
              <tr>
                <td style={{ padding: 12 }}>Average API response time</td>
                <td style={{ padding: 12 }}>
                  {formatNumber(h.api.averageResponseTimeMs)} ms
                </td>
                <td style={{ padding: 12, color: '#57606a' }}>
                  Last 24 hours ({formatNumber(h.api.sampleCount)} samples)
                </td>
              </tr>
            </>
          )}
        </tbody>
      </table>
    </>
  );
}
