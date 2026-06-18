/**
 * Login page — credentials form rendered inside the split-screen AuthLayout.
 *
 * Handles four distinct error states surfaced via NextAuth's `?error=<code>`
 * redirect param (see `lib/auth.ts` → `authenticateAgainstBackend`):
 *
 *   - `InvalidCredentials` — wrong email/password OR missing fields.
 *     Intentionally indistinguishable from "no such account" so we never
 *     leak which emails are registered.
 *   - `AccountLocked:<seconds>` — Req 16.8 lockout. Shows a countdown so
 *     the citizen knows when they can retry.
 *   - `WeakPassword` — backend's password policy rejected the input on
 *     login. Rare (would only happen for an account whose hash predates
 *     the current policy) but handled.
 *   - `NetworkError` — backend unreachable. We tell the user to retry
 *     rather than blame their credentials.
 *
 * Anything we don't recognise falls back to a polite generic message rather
 * than leaking the raw token.
 */

'use client';

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthLayout } from '../../components/AuthLayout';

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginFallback() {
  return (
    <AuthLayout title="Sign in" subtitle="Loading sign-in form…">
      <div aria-live="polite" />
    </AuthLayout>
  );
}

interface ErrorDisplay {
  title: string;
  body: string;
}

/**
 * Maps the NextAuth `?error=<code>` URL param (or a local form error) to a
 * user-friendly title + body. Codes that pack data (e.g. `AccountLocked:120`)
 * are parsed here so the message can include specifics like a countdown.
 */
function describeError(code: string | null): ErrorDisplay | null {
  if (!code) return null;

  // AccountLocked:<remainingSeconds>
  if (code.startsWith('AccountLocked')) {
    const seconds = Number(code.split(':')[1] ?? '0');
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return {
      title: 'Account temporarily locked',
      body: `Too many failed sign-in attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    };
  }

  switch (code) {
    case 'InvalidCredentials':
    case 'CredentialsSignin':
      return {
        title: 'Sign-in failed',
        body: 'Email or password is incorrect. Please check and try again.',
      };
    case 'WeakPassword':
      return {
        title: 'Password no longer meets policy',
        body: 'Your password no longer satisfies our security policy. Please reset it to sign in.',
      };
    case 'NetworkError':
      return {
        title: 'Connection problem',
        body: "We couldn't reach the sign-in service. Check your connection and try again in a moment.",
      };
    default:
      return {
        title: 'Sign-in failed',
        body: 'Something went wrong. Please try again.',
      };
  }
}

function LoginForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';
  const urlError = searchParams.get('error');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [formErrorCode, setFormErrorCode] = useState<string | null>(null);

  const errorDisplay = describeError(formErrorCode ?? urlError);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) {
      setFormErrorCode('InvalidCredentials');
      return;
    }
    setIsLoading(true);
    setFormErrorCode(null);

    // Use `redirect: false` so we can inspect the result and render a
    // specific message in-place rather than landing back here through
    // a URL roundtrip.
    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
      callbackUrl,
    });

    if (result?.ok && result.url) {
      window.location.href = result.url;
      return;
    }

    setFormErrorCode(result?.error ?? 'CredentialsSignin');
    setIsLoading(false);
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Access your personalised scheme recommendations and benefits dashboard."
    >
      {errorDisplay && (
        <div role="alert" className="bb-auth-alert">
          <span aria-hidden="true" className="bb-auth-alert-icon">!</span>
          <div className="bb-auth-alert-body">
            <p className="bb-auth-alert-title">{errorDisplay.title}</p>
            <p>{errorDisplay.body}</p>
          </div>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="bb-auth-form"
        noValidate
        aria-describedby={errorDisplay ? 'login-error-summary' : undefined}
      >
        <div className="bb-field">
          <label htmlFor="email" className="bb-field-label">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="bb-field-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="you@example.com"
            aria-invalid={errorDisplay ? 'true' : undefined}
            disabled={isLoading}
          />
        </div>

        <div className="bb-field">
          <label htmlFor="password" className="bb-field-label">
            Password
          </label>
          <div className="bb-password-wrap">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              className="bb-field-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              placeholder="••••••••"
              aria-invalid={errorDisplay ? 'true' : undefined}
              disabled={isLoading}
            />
            <button
              type="button"
              className="bb-password-toggle"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              tabIndex={0}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        <button type="submit" className="bb-auth-submit" disabled={isLoading}>
          {isLoading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="bb-auth-foot">
        Don&apos;t have an account? <a href="/register">Create one</a>
      </p>
    </AuthLayout>
  );
}
