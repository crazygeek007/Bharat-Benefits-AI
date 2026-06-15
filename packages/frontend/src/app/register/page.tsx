/**
 * Registration page — allows new citizens to create an account.
 *
 * Calls the backend POST /api/auth/register endpoint, then auto-signs
 * in via NextAuth credentials provider on success.
 */

'use client';

import { signIn } from 'next-auth/react';
import { useState } from 'react';

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setIsLoading(true);

    try {
      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';
      const res = await fetch(`${backendUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || `Registration failed (${res.status})`);
        setIsLoading(false);
        return;
      }

      // Auto sign-in after successful registration
      await signIn('credentials', {
        email,
        password,
        redirect: true,
        callbackUrl: '/profile',
      });
    } catch (err) {
      setError('Unable to connect to the server. Please try again.');
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
      <h1 style={{ marginBottom: 8 }}>Create Account</h1>
      <p style={{ color: '#57606a', marginTop: 0, marginBottom: 24 }}>
        Join Bharat Benefits AI to discover government schemes you&apos;re eligible for.
      </p>

      {error && (
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
          {error}
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
            autoComplete="new-password"
            minLength={8}
            style={{
              width: '100%',
              padding: '10px 12px',
              border: '1px solid #d0d7de',
              borderRadius: 4,
              fontSize: 16,
            }}
          />
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#57606a' }}>
            Min 8 characters with uppercase, lowercase, digit, and special character.
          </p>
        </div>

        <div>
          <label
            htmlFor="confirm-password"
            style={{ display: 'block', marginBottom: 4, fontWeight: 500, fontSize: 14 }}
          >
            Confirm Password
          </label>
          <input
            id="confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            autoComplete="new-password"
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
          {isLoading ? 'Creating account...' : 'Create Account'}
        </button>
      </form>

      <p style={{ marginTop: 24, textAlign: 'center', fontSize: 14, color: '#57606a' }}>
        Already have an account?{' '}
        <a href="/login" style={{ color: '#0b5394' }}>
          Sign in
        </a>
      </p>
    </main>
  );
}
