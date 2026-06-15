/**
 * Benefits Dashboard page (Requirement 11).
 *
 * Server component that fetches the authenticated citizen's dashboard
 * showing eligible, applied, saved, and expired schemes grouped by status,
 * plus estimated total benefit value and missed benefits summary.
 *
 * Wired to `GET /api/dashboard` via the typed API client.
 */

import type { Metadata } from 'next';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '../../lib/auth';
import { createApiClient, type DashboardResponse } from '../../lib/api-client';
import { MAIN_CONTENT_ID } from '../../components/SkipLink';

export const metadata: Metadata = {
  title: 'Benefits Dashboard — Bharat Benefits AI',
  description: 'Track your eligible, applied, saved, and expired schemes in one place.',
};

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  const backendToken =
    typeof (session as unknown as { backendToken?: unknown })?.backendToken === 'string'
      ? (session as unknown as { backendToken: string }).backendToken
      : null;

  if (!session) {
    redirect('/login?callbackUrl=/dashboard');
  }

  // If no backend token yet, show empty dashboard
  if (!backendToken) {
    return (
      <main id={MAIN_CONTENT_ID} tabIndex={-1} style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}>
        <h1>Benefits Dashboard</h1>
        <div style={{ textAlign: 'center', padding: 48, color: '#57606a' }}>
          <p style={{ fontSize: 18 }}>Your dashboard is empty</p>
          <p>Start by <a href="/schemes" style={{ color: '#0b5394' }}>discovering schemes</a> or completing your <a href="/profile" style={{ color: '#0b5394' }}>profile</a> for personalized recommendations.</p>
        </div>
      </main>
    );
  }

  const client = createApiClient({ authToken: backendToken });

  let dashboard: DashboardResponse | null = null;
  let error: string | null = null;

  try {
    dashboard = await client.getDashboard();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    // Treat 401 as expired session — redirect to login
    if (msg.includes('401')) {
      redirect('/login?callbackUrl=/dashboard');
    }
    // Treat 404 as "endpoint not wired yet" — show empty dashboard
    if (msg.includes('404')) {
      dashboard = null;
    } else {
      error = msg || 'Unable to load dashboard';
    }
  }

  if (error) {
    return (
      <main id={MAIN_CONTENT_ID} tabIndex={-1} style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}>
        <h1>Benefits Dashboard</h1>
        <div role="alert" style={{ padding: 12, border: '1px solid #d73a49', background: '#ffeef0', color: '#86181d', borderRadius: 4 }}>
          {error}
        </div>
      </main>
    );
  }

  if (!dashboard) {
    return (
      <main id={MAIN_CONTENT_ID} tabIndex={-1} style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}>
        <h1>Benefits Dashboard</h1>
        <div style={{ textAlign: 'center', padding: 48, color: '#57606a' }}>
          <p style={{ fontSize: 18 }}>Your dashboard is empty</p>
          <p>Start by <a href="/schemes" style={{ color: '#0b5394' }}>discovering schemes</a> or completing your <a href="/profile" style={{ color: '#0b5394' }}>profile</a> for personalized recommendations.</p>
        </div>
      </main>
    );
  }

  const formatINR = (amount: number) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}>
      <h1>Benefits Dashboard</h1>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 24 }}>
        <div style={{ padding: 16, border: '1px solid #d0d7de', borderRadius: 8, background: '#f6f8fa' }}>
          <p style={{ margin: 0, fontSize: 13, color: '#57606a' }}>Estimated Total Benefits</p>
          <p style={{ margin: '4px 0 0', fontSize: 24, fontWeight: 600 }}>
            {formatINR(dashboard.estimatedTotalBenefitValue)}
          </p>
        </div>
        <div style={{ padding: 16, border: '1px solid #d0d7de', borderRadius: 8, background: '#f6f8fa' }}>
          <p style={{ margin: 0, fontSize: 13, color: '#57606a' }}>Eligible</p>
          <p style={{ margin: '4px 0 0', fontSize: 24, fontWeight: 600 }}>{dashboard.counts.eligible}</p>
        </div>
        <div style={{ padding: 16, border: '1px solid #d0d7de', borderRadius: 8, background: '#f6f8fa' }}>
          <p style={{ margin: 0, fontSize: 13, color: '#57606a' }}>Applied</p>
          <p style={{ margin: '4px 0 0', fontSize: 24, fontWeight: 600 }}>{dashboard.counts.applied}</p>
        </div>
        <div style={{ padding: 16, border: '1px solid #d0d7de', borderRadius: 8, background: '#f6f8fa' }}>
          <p style={{ margin: 0, fontSize: 13, color: '#57606a' }}>Saved</p>
          <p style={{ margin: '4px 0 0', fontSize: 24, fontWeight: 600 }}>{dashboard.counts.saved}</p>
        </div>
      </div>

      {/* Missed Benefits Summary */}
      {dashboard.missedBenefitsSummary.count > 0 && (
        <div style={{ padding: 12, border: '1px solid #d4a72c', background: '#fff8c5', borderRadius: 4, marginBottom: 16 }}>
          <strong>Missed Benefits:</strong> You were eligible for {dashboard.missedBenefitsSummary.count} scheme(s)
          worth an estimated {formatINR(dashboard.missedBenefitsSummary.totalMonetaryValue)} that you didn&apos;t apply for before the deadline.
        </div>
      )}

      {/* Eligible Schemes */}
      <section aria-labelledby="eligible-heading" style={{ marginBottom: 24 }}>
        <h2 id="eligible-heading">Eligible ({dashboard.counts.eligible})</h2>
        {dashboard.eligible.length === 0 ? (
          <p style={{ color: '#57606a' }}>No eligible schemes yet. Complete your profile to get personalized recommendations.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {dashboard.eligible.map((s) => (
              <li key={s.id} style={{ padding: '12px 0', borderBottom: '1px solid #d0d7de' }}>
                <a href={`/schemes/detail/${s.id}`} style={{ color: '#0b5394', fontWeight: 500 }}>{s.name}</a>
                <span style={{ marginLeft: 8, fontSize: 12, color: '#57606a' }}>{s.category}</span>
                {s.benefitAmount && <span style={{ marginLeft: 8, fontSize: 12, color: '#1a7f37' }}>{formatINR(s.benefitAmount)}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Applied Schemes */}
      <section aria-labelledby="applied-heading" style={{ marginBottom: 24 }}>
        <h2 id="applied-heading">Applied ({dashboard.counts.applied})</h2>
        {dashboard.applied.length === 0 ? (
          <p style={{ color: '#57606a' }}>No applications tracked yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {dashboard.applied.map((s) => (
              <li key={s.id} style={{ padding: '12px 0', borderBottom: '1px solid #d0d7de' }}>
                <a href={`/schemes/detail/${s.id}`} style={{ color: '#0b5394', fontWeight: 500 }}>{s.name}</a>
                {s.appliedAt && <span style={{ marginLeft: 8, fontSize: 12, color: '#57606a' }}>Applied: {new Date(s.appliedAt).toLocaleDateString()}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Saved Schemes */}
      <section aria-labelledby="saved-heading" style={{ marginBottom: 24 }}>
        <h2 id="saved-heading">Saved ({dashboard.counts.saved})</h2>
        {dashboard.saved.length === 0 ? (
          <p style={{ color: '#57606a' }}>No saved schemes. Browse schemes and save the ones you&apos;re interested in.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {dashboard.saved.map((s) => (
              <li key={s.id} style={{ padding: '12px 0', borderBottom: '1px solid #d0d7de' }}>
                <a href={`/schemes/detail/${s.id}`} style={{ color: '#0b5394', fontWeight: 500 }}>{s.name}</a>
                {s.deadline && <span style={{ marginLeft: 8, fontSize: 12, color: '#d4a72c' }}>Deadline: {new Date(s.deadline).toLocaleDateString()}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Expired Schemes */}
      <section aria-labelledby="expired-heading">
        <h2 id="expired-heading">Expired ({dashboard.counts.expired})</h2>
        {dashboard.expired.length === 0 ? (
          <p style={{ color: '#57606a' }}>No expired schemes.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {dashboard.expired.map((s) => (
              <li key={s.id} style={{ padding: '12px 0', borderBottom: '1px solid #d0d7de', opacity: 0.7 }}>
                <a href={`/schemes/detail/${s.id}`} style={{ color: '#57606a', fontWeight: 500 }}>{s.name}</a>
                <span style={{ marginLeft: 8, fontSize: 12, color: '#cf222e' }}>Expired</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Empty state */}
      {dashboard.counts.eligible === 0 && dashboard.counts.applied === 0 && dashboard.counts.saved === 0 && dashboard.counts.expired === 0 && (
        <div style={{ textAlign: 'center', padding: 48, color: '#57606a' }}>
          <p style={{ fontSize: 18 }}>Your dashboard is empty</p>
          <p>Start by <a href="/schemes" style={{ color: '#0b5394' }}>discovering schemes</a> or completing your <a href="/profile" style={{ color: '#0b5394' }}>profile</a> for personalized recommendations.</p>
        </div>
      )}
    </main>
  );
}
