/**
 * Login page — renders the NextAuth.js credential form.
 *
 * For the MVP, this provides a simple email/password login form that
 * calls NextAuth's credential provider. Social login buttons are shown
 * when GOOGLE_CLIENT_ID is configured.
 */

'use client';

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginPageFallback />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginPageFallback() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={{
        maxWidth: 400,
        margin: '80px auto',
        padding: 24,
      }}
    >
      <h1 style={{ marginBottom: 8 }}>Sign In</h1>
      <p style={{ color: '#57606a' }}>Loading sign-in form...</p>
    </main>
  );
}

function LoginForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';
  const error = searchParams.get('error');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setFormError(null);

    const result = await signIn('credentials', {
      email,
      password,
      redirect: true,
      callbackUrl,
    });

    if (result?.error) {
      setFormError('Invalid email or password. Please try again.');
      setIsLoading(false);
    }
  }

  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={{
        maxWidth: 400,
        margin: '80px auto',
        padding: 24,
      }}
    >
      <h1 style={{ marginBottom: 8 }}>Sign In</h1>
      <p style={{ color: '#57606a', marginTop: 0, marginBottom: 24 }}>
        Sign in to access your personalized scheme recommendations and benefits dashboard.
      </p>

      {(error || formError) && (
        <div
          role="alert"
          style={{
            padding: 12,
            border: '1px solid #d73a49',
            background: '#ffeef0',
            color: '#86181d',
            borderRadius: 4,
            marginBottom: 16,
            fontSize: 14,
          }}
        >
          {formError || 'Authentication failed. Please try again.'}
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label
            htmlFor="email"
            style={{ display: 'block', marginBottom: 4, fontWeight: 500, fontSize: 14 }}
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            style={{
              width: '100%',
              padding: '10px 12px',
              border: '1px solid #d0d7de',
              borderRadius: 4,
              fontSize: 16,
            }}
          />
        </div>

        <div>
          <label
            htmlFor="password"
            style={{ display: 'block', marginBottom: 4, fontWeight: 500, fontSize: 14 }}
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            style={{
              width: '100%',
              padding: '10px 12px',
              border: '1px solid #d0d7de',
              borderRadius: 4,
              fontSize: 16,
            }}
          />
        </div>

        <button
          type="submit"
          disabled={isLoading}
          style={{
            padding: '12px 16px',
            background: isLoading ? '#8c9bab' : '#0b5394',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            fontSize: 16,
            fontWeight: 600,
            cursor: isLoading ? 'not-allowed' : 'pointer',
          }}
        >
          {isLoading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>

      <p style={{ marginTop: 24, textAlign: 'center', fontSize: 14, color: '#57606a' }}>
        Don&apos;t have an account?{' '}
        <a href="/register" style={{ color: '#0b5394' }}>
          Create one
        </a>
      </p>
    </main>
  );
}
