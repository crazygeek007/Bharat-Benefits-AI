/**
 * Benefits Dashboard page (Requirement 11).
 *
 * Server component that fetches the authenticated citizen's dashboard
 * showing eligible, applied, saved, and expired schemes grouped by status,
 * plus estimated total benefit value and missed benefits summary.
 *
 * Wired to `GET /api/dashboard` via the typed API client.
 *
 * Auth: a session without `backendToken` is treated as broken and the
 * user is sent back to /login rather than seeing an empty placeholder.
 * That previously masked real session corruption.
 */

import type { Metadata } from 'next';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '../../lib/auth';
import { createApiClient, type DashboardResponse } from '../../lib/api-client';
import { MAIN_CONTENT_ID } from '../../components/SkipLink';
import { formatINR } from '../../lib/formatCurrency';

export const metadata: Metadata = {
  title: 'Benefits Dashboard — Bharat Benefits AI',
  description: 'Track your eligible, applied, saved, and expired schemes in one place.',
};

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect('/login?callbackUrl=/dashboard');
  }

  const backendToken =
    typeof (session as unknown as { backendToken?: unknown }).backendToken === 'string'
      ? (session as unknown as { backendToken: string }).backendToken
      : null;

  if (!backendToken) {
    redirect('/login?callbackUrl=/dashboard');
  }

  const client = createApiClient({ authToken: backendToken });

  let dashboard: DashboardResponse | null = null;
  let error: string | null = null;

  try {
    dashboard = await client.getDashboard();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('401')) {
      redirect('/login?callbackUrl=/dashboard');
    }
    error = msg || 'Unable to load dashboard';
  }

  if (error) {
    return (
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="bb-app-page">
        <header className="bb-app-page__head">
          <h1 className="bb-app-page__title">Benefits Dashboard</h1>
        </header>
        <div role="alert" className="bb-page-alert">
          {error}
        </div>
      </main>
    );
  }

  if (!dashboard) {
    // /api/dashboard returned an unexpected null. Render the empty state.
    return <EmptyDashboard />;
  }

  const everythingZero =
    dashboard.counts.eligible === 0 &&
    dashboard.counts.applied === 0 &&
    dashboard.counts.saved === 0 &&
    dashboard.counts.expired === 0;

  if (everythingZero) {
    return <EmptyDashboard />;
  }

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="bb-app-page">
      <header className="bb-app-page__head">
        <h1 className="bb-app-page__title">Benefits Dashboard</h1>
        <p className="bb-app-page__lede">
          Track your eligible, applied, saved, and expired schemes in one place.
        </p>
      </header>

      <div className="bb-stat-grid">
        <div className="bb-stat bb-stat--featured">
          <p className="bb-stat__label">Estimated total benefits</p>
          <p className="bb-stat__value">{formatINR(dashboard.estimatedTotalBenefitValue)}</p>
        </div>
        <div className="bb-stat">
          <p className="bb-stat__label">Eligible</p>
          <p className="bb-stat__value">{dashboard.counts.eligible}</p>
        </div>
        <div className="bb-stat">
          <p className="bb-stat__label">Applied</p>
          <p className="bb-stat__value">{dashboard.counts.applied}</p>
        </div>
        <div className="bb-stat">
          <p className="bb-stat__label">Saved</p>
          <p className="bb-stat__value">{dashboard.counts.saved}</p>
        </div>
      </div>

      {dashboard.missedBenefitsSummary.count > 0 && (
        <div className="bb-banner" role="status">
          <span className="bb-banner__icon" aria-hidden="true">
            !
          </span>
          <div>
            <strong>Missed benefits:</strong> You were eligible for{' '}
            {dashboard.missedBenefitsSummary.count} scheme
            {dashboard.missedBenefitsSummary.count === 1 ? '' : 's'} worth roughly{' '}
            {formatINR(dashboard.missedBenefitsSummary.totalMonetaryValue)} that
            you didn&apos;t apply for before the deadline.
          </div>
        </div>
      )}

      <SchemeSection
        title="Eligible"
        count={dashboard.counts.eligible}
        emptyMessage="No eligible schemes yet. Complete your profile to get personalised recommendations."
        items={dashboard.eligible.map((s) => ({
          id: s.id,
          name: s.name,
          metaLeft: s.category,
          metaRight: s.benefitAmount ? formatINR(s.benefitAmount) : undefined,
          metaRightTone: 'success',
        }))}
      />
      <SchemeSection
        title="Applied"
        count={dashboard.counts.applied}
        emptyMessage="No applications tracked yet."
        items={dashboard.applied.map((s) => ({
          id: s.id,
          name: s.name,
          metaRight: s.appliedAt
            ? `Applied ${new Date(s.appliedAt).toLocaleDateString()}`
            : undefined,
        }))}
      />
      <SchemeSection
        title="Saved"
        count={dashboard.counts.saved}
        emptyMessage="No saved schemes. Browse and save the ones you're interested in."
        items={dashboard.saved.map((s) => ({
          id: s.id,
          name: s.name,
          metaRight: s.deadline
            ? `Deadline ${new Date(s.deadline).toLocaleDateString()}`
            : undefined,
          metaRightTone: 'warning',
        }))}
      />
      <SchemeSection
        title="Expired"
        count={dashboard.counts.expired}
        emptyMessage="No expired schemes."
        items={dashboard.expired.map((s) => ({
          id: s.id,
          name: s.name,
          metaRight: 'Expired',
          metaRightTone: 'danger',
          expired: true,
        }))}
      />
    </main>
  );
}

function EmptyDashboard() {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="bb-app-page">
      <header className="bb-app-page__head">
        <h1 className="bb-app-page__title">Benefits Dashboard</h1>
      </header>
      <section className="bb-card">
        <div className="bb-empty">
          <p className="bb-empty__title">Your dashboard is empty</p>
          <p style={{ marginBottom: 20 }}>
            Start by completing your profile for personalised recommendations,
            or browse the catalogue and save what catches your eye.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a className="bb-button-primary" href="/profile/edit">
              Complete profile
            </a>
            <a className="bb-button-secondary" href="/schemes">
              Browse schemes
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}

interface SchemeRow {
  id: string;
  name: string;
  metaLeft?: string;
  metaRight?: string;
  metaRightTone?: 'success' | 'warning' | 'danger';
  expired?: boolean;
}

function SchemeSection({
  title,
  count,
  emptyMessage,
  items,
}: {
  title: string;
  count: number;
  emptyMessage: string;
  items: SchemeRow[];
}) {
  const headingId = `dashboard-section-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={headingId} className="bb-card">
      <h2 id={headingId} className="bb-card__title">
        {title}
        <span className="bb-card__count">{count}</span>
      </h2>
      {items.length === 0 ? (
        <p className="bb-card__sub">{emptyMessage}</p>
      ) : (
        <ul className="bb-scheme-list">
          {items.map((item) => (
            <li
              key={item.id}
              className={
                item.expired
                  ? 'bb-scheme-list__item bb-scheme-list__item--expired'
                  : 'bb-scheme-list__item'
              }
            >
              <a href={`/schemes/detail/${item.id}`} className="bb-scheme-list__name">
                {item.name}
              </a>
              {item.metaLeft && (
                <span className="bb-scheme-list__meta">{item.metaLeft}</span>
              )}
              {item.metaRight && (
                <span
                  className={
                    item.metaRightTone
                      ? `bb-scheme-list__meta bb-scheme-list__meta--${item.metaRightTone}`
                      : 'bb-scheme-list__meta'
                  }
                >
                  {item.metaRight}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
