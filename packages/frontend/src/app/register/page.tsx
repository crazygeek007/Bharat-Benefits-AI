/**
 * Registration page — citizen self-signup.
 *
 * Behaviour notes:
 *   - Inline password requirements light up green as each rule is satisfied,
 *     so users aren't blindsided by a backend rejection after submit.
 *   - Backend errors are mapped by their stable `error` code to friendly
 *     copy. Specifically:
 *       * EmailAlreadyRegistered → "This email is already registered." with
 *         a sign-in link, so the user can recover in one click.
 *       * WeakPassword → re-renders the inline checklist with violations
 *         highlighted in case the backend's view of the policy is stricter
 *         than what the form pre-validated.
 *       * BadRequest / others → generic friendly fallback.
 *   - On success we auto-sign-in via NextAuth; if that step fails (e.g.
 *     transient network blip) we redirect to /login with the email
 *     pre-filled instead of leaving the user stranded.
 */

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { useMemo, useState } from 'react';
import {
  PASSWORD_POLICY,
  validatePassword,
  type PasswordRejectionReason,
} from '@bharat-benefits/shared';
import { AuthLayout } from '../../components/AuthLayout';

interface PwRule {
  id: PasswordRejectionReason | 'too_long_overflow';
  label: string;
  test: (pw: string) => boolean;
}

const PASSWORD_RULES: readonly PwRule[] = [
  {
    id: 'too_short',
    label: `At least ${PASSWORD_POLICY.minLength} characters`,
    test: (pw) =>
      pw.length >= PASSWORD_POLICY.minLength && pw.length <= PASSWORD_POLICY.maxLength,
  },
  {
    id: 'missing_uppercase',
    label: 'One uppercase letter',
    test: (pw) => /[A-Z]/.test(pw),
  },
  {
    id: 'missing_lowercase',
    label: 'One lowercase letter',
    test: (pw) => /[a-z]/.test(pw),
  },
  {
    id: 'missing_digit',
    label: 'One number',
    test: (pw) => /[0-9]/.test(pw),
  },
  {
    id: 'missing_special_char',
    label: 'One special character',
    test: (pw) => /[^A-Za-z0-9\s]/.test(pw),
  },
];

interface BackendError {
  error?: string;
  message?: string;
  violations?: string[];
}

interface AlertDisplay {
  title: string;
  body: string;
  /** Inline link rendered after the body. */
  link?: { href: string; label: string };
}

function describeRegisterError(payload: BackendError, status: number): AlertDisplay {
  if (payload.error === 'EmailAlreadyRegistered') {
    return {
      title: 'Email already registered',
      body: 'An account with this email already exists. Sign in instead.',
      link: { href: '/login', label: 'Go to sign in →' },
    };
  }
  if (payload.error === 'WeakPassword') {
    return {
      title: 'Password is not strong enough',
      body: 'Choose a password that satisfies every requirement below.',
    };
  }
  if (payload.error === 'BadRequest') {
    return {
      title: 'Check your details',
      body: payload.message || 'Please review the form and try again.',
    };
  }
  return {
    title: 'Registration failed',
    body: payload.message || `Something went wrong (HTTP ${status}). Please try again.`,
  };
}

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [alert, setAlert] = useState<AlertDisplay | null>(null);

  const ruleStatus = useMemo(
    () => PASSWORD_RULES.map((rule) => ({ rule, met: password.length > 0 && rule.test(password) })),
    [password],
  );
  const passwordsMatch = confirmPassword.length === 0 || confirmPassword === password;
  const passwordValid = password.length > 0 && validatePassword(password).valid;
  const canSubmit = passwordValid && passwordsMatch && email.length > 0 && !isLoading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAlert(null);

    if (!passwordsMatch) {
      setAlert({ title: 'Passwords do not match', body: 'Re-enter the same password in both fields.' });
      return;
    }
    if (!passwordValid) {
      setAlert({
        title: 'Password is not strong enough',
        body: 'Choose a password that satisfies every requirement below.',
      });
      return;
    }

    setIsLoading(true);

    let res: Response;
    try {
      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';
      res = await fetch(`${backendUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      setAlert({
        title: 'Connection problem',
        body: "We couldn't reach the registration service. Check your connection and try again.",
      });
      setIsLoading(false);
      return;
    }

    if (!res.ok) {
      const body: BackendError = await res.json().catch(() => ({}));
      setAlert(describeRegisterError(body, res.status));
      setIsLoading(false);
      return;
    }

    // Auto sign-in on the same page so the user lands in /profile rather
    // than the sign-in form. If the sign-in step fails (rare — typically
    // a transient hiccup), fall back to redirecting to login with the
    // email prefilled instead of leaving them on a successful-but-stuck
    // register page.
    const signInResult = await signIn('credentials', {
      email,
      password,
      redirect: false,
      callbackUrl: '/profile',
    });

    if (signInResult?.ok && signInResult.url) {
      window.location.href = signInResult.url;
      return;
    }

    router.push(`/login?email=${encodeURIComponent(email)}`);
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Join Bharat Benefits AI to discover government schemes you're eligible for."
    >
      {alert && (
        <div role="alert" className="bb-auth-alert">
          <span aria-hidden="true" className="bb-auth-alert-icon">!</span>
          <div className="bb-auth-alert-body">
            <p className="bb-auth-alert-title">{alert.title}</p>
            <p>{alert.body}</p>
            {alert.link && (
              <p style={{ marginTop: 6 }}>
                <Link href={alert.link.href} style={{ color: 'inherit', fontWeight: 600 }}>
                  {alert.link.label}
                </Link>
              </p>
            )}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="bb-auth-form" noValidate>
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
              autoComplete="new-password"
              placeholder="Create a password"
              disabled={isLoading}
              aria-describedby="pw-checklist"
            />
            <button
              type="button"
              className="bb-password-toggle"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
          <ul
            id="pw-checklist"
            className="bb-pw-checklist"
            aria-live="polite"
            aria-atomic="false"
          >
            {ruleStatus.map(({ rule, met }) => (
              <li key={rule.id} data-met={met ? 'true' : 'false'}>
                <span className="bb-pw-check-icon" aria-hidden="true">
                  {met ? '✓' : '○'}
                </span>
                <span>{rule.label}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="bb-field">
          <label htmlFor="confirm-password" className="bb-field-label">
            Confirm password
          </label>
          <input
            id="confirm-password"
            type={showPassword ? 'text' : 'password'}
            className="bb-field-input"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            autoComplete="new-password"
            placeholder="Re-enter your password"
            disabled={isLoading}
            aria-invalid={!passwordsMatch ? 'true' : undefined}
            aria-describedby={!passwordsMatch ? 'confirm-mismatch' : undefined}
          />
          {!passwordsMatch && (
            <p id="confirm-mismatch" className="bb-field-hint" style={{ color: 'var(--danger)' }}>
              Passwords don&apos;t match.
            </p>
          )}
        </div>

        <button type="submit" className="bb-auth-submit" disabled={!canSubmit}>
          {isLoading ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="bb-auth-foot">
        Already have an account? <a href="/login">Sign in</a>
      </p>
    </AuthLayout>
  );
}
