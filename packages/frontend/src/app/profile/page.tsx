/**
 * User Profile page (Requirement 3).
 *
 * Server component that fetches the authenticated citizen's profile and
 * displays it. Wired to `GET /api/profile` via the typed API client.
 *
 * Note on auth: the session check below is enough to gate access. A
 * missing `backendToken` would mean the session was issued before the
 * bundled-token wiring or somehow got corrupted; in either case the
 * right response is to send the user back to /login. The previous code
 * showed a fake "complete your profile" prompt for this state, which
 * masked the real broken session.
 */

import type { Metadata } from 'next';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '../../lib/auth';
import { createApiClient, type ProfileResponse } from '../../lib/api-client';
import { MAIN_CONTENT_ID } from '../../components/SkipLink';
import { formatINR } from '../../lib/formatCurrency';

export const metadata: Metadata = {
  title: 'My Profile — Bharat Benefits AI',
  description:
    'Manage your profile to get accurate eligibility calculations and personalized recommendations.',
};

export default async function ProfilePage() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect('/login?callbackUrl=/profile');
  }

  const backendToken =
    typeof (session as unknown as { backendToken?: unknown }).backendToken === 'string'
      ? (session as unknown as { backendToken: string }).backendToken
      : null;

  if (!backendToken) {
    // Session exists but no backend JWT — broken state, force a fresh login.
    redirect('/login?callbackUrl=/profile');
  }

  const client = createApiClient({ authToken: backendToken });

  let profileData: ProfileResponse | null = null;
  let error: string | null = null;

  try {
    profileData = await client.getProfile();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('401')) {
      redirect('/login?callbackUrl=/profile');
    }
    error = msg || 'Unable to load profile';
  }

  if (error) {
    return (
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="bb-app-page bb-app-page--narrow">
        <header className="bb-app-page__head">
          <h1 className="bb-app-page__title">My Profile</h1>
        </header>
        <div role="alert" className="bb-page-alert">
          {error}
        </div>
      </main>
    );
  }

  const profile = profileData?.profile;

  if (!profile) {
    return (
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="bb-app-page bb-app-page--narrow">
        <header className="bb-app-page__head">
          <h1 className="bb-app-page__title">My Profile</h1>
          <p className="bb-app-page__lede">
            Complete your profile so we can match you to schemes you actually
            qualify for.
          </p>
        </header>
        <section className="bb-card">
          <div className="bb-empty">
            <p className="bb-empty__title">No profile yet</p>
            <p style={{ marginBottom: 20 }}>
              Add your age, state, income, and a few other details so the
              eligibility engine can do its job.
            </p>
            <a className="bb-button-primary" href="/profile/edit">
              Create your profile
            </a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="bb-app-page bb-app-page--narrow">
      <header className="bb-app-page__head">
        <h1 className="bb-app-page__title">My Profile</h1>
        <p className="bb-app-page__lede">
          Keep this up to date for accurate eligibility and recommendations.
        </p>
      </header>

      <section className="bb-card">
        <dl className="bb-detail-list">
          <dt>Age</dt>
          <dd>{profile.age ?? '—'}</dd>

          <dt>Gender</dt>
          <dd>{profile.gender ?? '—'}</dd>

          <dt>State</dt>
          <dd>{profile.state ?? '—'}</dd>

          <dt>District</dt>
          <dd>{profile.district ?? '—'}</dd>

          <dt>Annual income</dt>
          <dd>{formatINR(profile.incomeLevel)}</dd>

          <dt>Occupation</dt>
          <dd>{profile.occupation ?? '—'}</dd>

          <dt>Education</dt>
          <dd>{profile.educationLevel ?? '—'}</dd>

          <dt>Caste category</dt>
          <dd>{profile.casteCategory ?? '—'}</dd>

          <dt>Disability</dt>
          <dd>
            {profile.disabilityStatus === true
              ? 'Yes'
              : profile.disabilityStatus === false
                ? 'No'
                : '—'}
          </dd>

          <dt>Marital status</dt>
          <dd>{profile.maritalStatus ?? '—'}</dd>

          <dt>Dependents</dt>
          <dd>{profile.dependents ?? '—'}</dd>
        </dl>

        <div style={{ marginTop: 28, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <a className="bb-button-primary" href="/profile/edit">
            Edit profile
          </a>
          <a className="bb-button-secondary" href="/dashboard">
            View dashboard
          </a>
        </div>
      </section>
    </main>
  );
}
