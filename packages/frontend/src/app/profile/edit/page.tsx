/**
 * Profile editor page — create or update the citizen's profile.
 *
 * Calls the backend POST/PUT /api/profile endpoints to persist
 * demographic and financial data used for eligibility calculations.
 */

'use client';

import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { INDIAN_STATES, PROFILE_CONSTRAINTS } from '@bharat-benefits/shared';

interface ProfileForm {
  age: string;
  gender: string;
  state: string;
  district: string;
  incomeLevel: string;
  occupation: string;
  educationLevel: string;
  casteCategory: string;
  disabilityStatus: string;
  maritalStatus: string;
  dependents: string;
}

const EMPTY_FORM: ProfileForm = {
  age: '',
  gender: '',
  state: '',
  district: '',
  incomeLevel: '',
  occupation: '',
  educationLevel: '',
  casteCategory: '',
  disabilityStatus: '',
  maritalStatus: '',
  dependents: '',
};

export default function ProfileEditPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login?callbackUrl=/profile/edit');
      return;
    }

    if (status === 'loading') return;

    // Load existing profile if any
    const token = (session as unknown as { backendToken?: string })?.backendToken;
    if (!token) {
      setIsLoading(false);
      return;
    }

    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';
    fetch(`${backendUrl}/api/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.profile) {
          const p = data.profile;
          setForm({
            age: p.age?.toString() ?? '',
            gender: p.gender ?? '',
            state: p.state ?? '',
            district: p.district ?? '',
            incomeLevel: p.incomeLevel?.toString() ?? '',
            occupation: p.occupation ?? '',
            educationLevel: p.educationLevel ?? '',
            casteCategory: p.casteCategory ?? '',
            disabilityStatus: p.disabilityStatus === true ? 'Yes' : p.disabilityStatus === false ? 'No' : '',
            maritalStatus: p.maritalStatus ?? '',
            dependents: p.dependents?.toString() ?? '',
          });
        }
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [status, session, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setIsSubmitting(true);

    const token = (session as unknown as { backendToken?: string })?.backendToken;
    if (!token) {
      setError('You must be logged in to save your profile.');
      setIsSubmitting(false);
      return;
    }

    const payload: Record<string, unknown> = {
      age: form.age ? Number(form.age) : undefined,
      gender: form.gender || undefined,
      state: form.state || undefined,
      district: form.district || undefined,
      incomeLevel: form.incomeLevel ? Number(form.incomeLevel) : undefined,
      occupation: form.occupation || undefined,
      educationLevel: form.educationLevel || undefined,
      casteCategory: form.casteCategory || undefined,
      disabilityStatus: form.disabilityStatus === 'Yes' ? true : form.disabilityStatus === 'No' ? false : undefined,
      maritalStatus: form.maritalStatus || undefined,
      dependents: form.dependents ? Number(form.dependents) : undefined,
    };

    try {
      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';
      const res = await fetch(`${backendUrl}/api/profile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || `Failed to save profile (${res.status})`);
        setIsSubmitting(false);
        return;
      }

      setSuccess(true);
      setTimeout(() => router.push('/profile'), 1000);
    } catch (err) {
      setError('Unable to connect to the server. Please try again.');
      setIsSubmitting(false);
    }
  }

  if (status === 'loading' || isLoading) {
    return (
      <main id="main-content" tabIndex={-1} style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
        <p>Loading...</p>
      </main>
    );
  }

  const fieldStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    border: '1px solid #d0d7de',
    borderRadius: 4,
    fontSize: 16,
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: 4,
    fontWeight: 500,
    fontSize: 14,
  };

  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}
    >
      <h1>Edit Profile</h1>
      <p style={{ color: '#57606a', marginTop: 0 }}>
        Provide your details to get accurate eligibility and personalized recommendations.
      </p>

      {error && (
        <div role="alert" style={{ padding: 12, border: '1px solid #d73a49', background: '#ffeef0', color: '#86181d', borderRadius: 4, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {success && (
        <div role="status" style={{ padding: 12, border: '1px solid #1a7f37', background: '#dafbe1', color: '#1a7f37', borderRadius: 4, marginBottom: 16 }}>
          Profile saved successfully. Redirecting...
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 16 }}>
        <div>
          <label htmlFor="age" style={labelStyle}>Age <span style={{ color: '#cf222e' }}>*</span></label>
          <input id="age" type="number" min={0} max={150} value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })} required style={fieldStyle} />
        </div>

        <div>
          <label htmlFor="gender" style={labelStyle}>Gender <span style={{ color: '#cf222e' }}>*</span></label>
          <select id="gender" value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} required style={fieldStyle}>
            <option value="">Select...</option>
            {PROFILE_CONSTRAINTS.gender.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="state" style={labelStyle}>State <span style={{ color: '#cf222e' }}>*</span></label>
          <select id="state" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} required style={fieldStyle}>
            <option value="">Select state...</option>
            {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="district" style={labelStyle}>District</label>
          <input id="district" type="text" value={form.district} onChange={(e) => setForm({ ...form, district: e.target.value })} style={fieldStyle} />
        </div>

        <div>
          <label htmlFor="income" style={labelStyle}>Annual Income (INR) <span style={{ color: '#cf222e' }}>*</span></label>
          <input id="income" type="number" min={0} value={form.incomeLevel} onChange={(e) => setForm({ ...form, incomeLevel: e.target.value })} required style={fieldStyle} />
        </div>

        <div>
          <label htmlFor="occupation" style={labelStyle}>Occupation</label>
          <select id="occupation" value={form.occupation} onChange={(e) => setForm({ ...form, occupation: e.target.value })} style={fieldStyle}>
            <option value="">Select...</option>
            {PROFILE_CONSTRAINTS.occupation.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="education" style={labelStyle}>Education Level</label>
          <select id="education" value={form.educationLevel} onChange={(e) => setForm({ ...form, educationLevel: e.target.value })} style={fieldStyle}>
            <option value="">Select...</option>
            {PROFILE_CONSTRAINTS.education.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="caste" style={labelStyle}>Caste Category</label>
          <select id="caste" value={form.casteCategory} onChange={(e) => setForm({ ...form, casteCategory: e.target.value })} style={fieldStyle}>
            <option value="">Select...</option>
            {PROFILE_CONSTRAINTS.caste.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="marital" style={labelStyle}>Marital Status</label>
          <select id="marital" value={form.maritalStatus} onChange={(e) => setForm({ ...form, maritalStatus: e.target.value })} style={fieldStyle}>
            <option value="">Select...</option>
            {PROFILE_CONSTRAINTS.maritalStatus.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="disability" style={labelStyle}>Disability</label>
          <select id="disability" value={form.disabilityStatus} onChange={(e) => setForm({ ...form, disabilityStatus: e.target.value })} style={fieldStyle}>
            <option value="">Select...</option>
            <option value="No">No</option>
            <option value="Yes">Yes</option>
          </select>
        </div>

        <div>
          <label htmlFor="dependents" style={labelStyle}>Number of Dependents</label>
          <input id="dependents" type="number" min={0} max={20} value={form.dependents} onChange={(e) => setForm({ ...form, dependents: e.target.value })} style={fieldStyle} />
        </div>

        <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              padding: '10px 20px',
              background: isSubmitting ? '#8c9bab' : '#0b5394',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              fontSize: 16,
              fontWeight: 600,
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
            }}
          >
            {isSubmitting ? 'Saving...' : 'Save Profile'}
          </button>
          <a
            href="/profile"
            style={{
              padding: '10px 20px',
              background: '#fff',
              color: '#24292f',
              border: '1px solid #d0d7de',
              borderRadius: 4,
              fontSize: 16,
              textDecoration: 'none',
              display: 'inline-block',
            }}
          >
            Cancel
          </a>
        </div>
      </form>
    </main>
  );
}
