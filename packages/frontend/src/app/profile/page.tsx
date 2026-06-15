/**
 * User Profile page (Requirement 3).
 *
 * Server component that fetches the authenticated citizen's profile and
 * displays it. Wired to `GET /api/profile` via the typed API client.
 *
 * Profile updates and deletion are handled via client-side actions that
 * call the API client's updateProfile/deleteProfile methods.
 */

import type { Metadata } from 'next';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '../../lib/auth';
import { createApiClient, type ProfileResponse } from '../../lib/api-client';
import { MAIN_CONTENT_ID } from '../../components/SkipLink';

export const metadata: Metadata = {
  title: 'My Profile — Bharat Benefits AI',
  description: 'Manage your profile to get accurate eligibility calculations and personalized recommendations.',
};

export default async function ProfilePage() {
  const session = await getServerSession(authOptions);
  const backendToken =
    typeof (session as unknown as { backendToken?: unknown })?.backendToken === 'string'
      ? (session as unknown as { backendToken: string }).backendToken
      : null;

  if (!session) {
    redirect('/login?callbackUrl=/profile');
  }

  // If no backend token, show profile creation prompt
  if (!backendToken) {
    return (
      <main id={MAIN_CONTENT_ID} tabIndex={-1} style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
        <h1>My Profile</h1>
        <p style={{ color: '#57606a' }}>
          Complete your profile to get accurate eligibility calculations and
          personalized scheme recommendations.
        </p>
        <p>
          <a href="/profile/edit" style={{ color: '#0b5394' }}>Create your profile →</a>
        </p>
      </main>
    );
  }

  const client = createApiClient({ authToken: backendToken });

  let profileData: ProfileResponse | null = null;
  let error: string | null = null;

  try {
    profileData = await client.getProfile();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    // Treat 401 as expired session — redirect to login
    if (msg.includes('401')) {
      redirect('/login?callbackUrl=/profile');
    }
    // Treat 404 as "no profile endpoint yet" — show empty state
    if (msg.includes('404')) {
      profileData = { profile: null };
    } else {
      error = msg || 'Unable to load profile';
    }
  }

  if (error) {
    return (
      <main id={MAIN_CONTENT_ID} tabIndex={-1} style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
        <h1>My Profile</h1>
        <div role="alert" style={{ padding: 12, border: '1px solid #d73a49', background: '#ffeef0', color: '#86181d', borderRadius: 4 }}>
          {error}
        </div>
      </main>
    );
  }

  const profile = profileData?.profile;

  if (!profile) {
    return (
      <main id={MAIN_CONTENT_ID} tabIndex={-1} style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
        <h1>My Profile</h1>
        <p style={{ color: '#57606a' }}>
          Complete your profile to get accurate eligibility calculations and
          personalized scheme recommendations.
        </p>
        <p>
          <a href="/profile/edit" style={{ color: '#0b5394' }}>Create your profile →</a>
        </p>
      </main>
    );
  }

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1>My Profile</h1>
      <p style={{ color: '#57606a', marginTop: 0 }}>
        Keep your profile up to date for accurate eligibility and recommendations.
      </p>

      <dl style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '8px 16px', marginTop: 24 }}>
        <dt style={{ fontWeight: 500, color: '#24292f' }}>Age</dt>
        <dd style={{ margin: 0 }}>{profile.age ?? '—'}</dd>

        <dt style={{ fontWeight: 500, color: '#24292f' }}>Gender</dt>
        <dd style={{ margin: 0 }}>{profile.gender ?? '—'}</dd>

        <dt style={{ fontWeight: 500, color: '#24292f' }}>State</dt>
        <dd style={{ margin: 0 }}>{profile.state ?? '—'}</dd>

        <dt style={{ fontWeight: 500, color: '#24292f' }}>District</dt>
        <dd style={{ margin: 0 }}>{profile.district ?? '—'}</dd>

        <dt style={{ fontWeight: 500, color: '#24292f' }}>Annual Income (INR)</dt>
        <dd style={{ margin: 0 }}>
          {profile.incomeLevel != null
            ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(profile.incomeLevel)
            : '—'}
        </dd>

        <dt style={{ fontWeight: 500, color: '#24292f' }}>Occupation</dt>
        <dd style={{ margin: 0 }}>{profile.occupation ?? '—'}</dd>

        <dt style={{ fontWeight: 500, color: '#24292f' }}>Education Level</dt>
        <dd style={{ margin: 0 }}>{profile.educationLevel ?? '—'}</dd>

        <dt style={{ fontWeight: 500, color: '#24292f' }}>Caste Category</dt>
        <dd style={{ margin: 0 }}>{profile.casteCategory ?? '—'}</dd>

        <dt style={{ fontWeight: 500, color: '#24292f' }}>Disability</dt>
        <dd style={{ margin: 0 }}>{profile.disabilityStatus === true ? 'Yes' : profile.disabilityStatus === false ? 'No' : '—'}</dd>

        <dt style={{ fontWeight: 500, color: '#24292f' }}>Marital Status</dt>
        <dd style={{ margin: 0 }}>{profile.maritalStatus ?? '—'}</dd>

        <dt style={{ fontWeight: 500, color: '#24292f' }}>Dependents</dt>
        <dd style={{ margin: 0 }}>{profile.dependents ?? '—'}</dd>
      </dl>

      <div style={{ marginTop: 32, display: 'flex', gap: 12 }}>
        <a
          href="/profile/edit"
          style={{
            display: 'inline-block',
            padding: '8px 16px',
            background: '#0b5394',
            color: '#fff',
            borderRadius: 4,
            textDecoration: 'none',
            fontWeight: 500,
          }}
        >
          Edit Profile
        </a>
      </div>
    </main>
  );
}
