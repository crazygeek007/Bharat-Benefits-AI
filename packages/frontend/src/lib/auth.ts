/**
 * NextAuth.js configuration for Bharat Benefits AI.
 *
 * - Strategy: JWT-only sessions (no DB session table).
 * - Inactivity timeout: 30 minutes (Requirement 16.5). `maxAge` enforces a
 *   30-minute session window; `updateAge` slides the token forward whenever
 *   activity is observed.
 * - Providers: Email/password (Credentials) + Google (social). Google is
 *   stubbed via env vars; if unset, the provider is omitted gracefully so the
 *   build works in dev without OAuth credentials.
 * - Password policy is enforced server-side by the backend. The frontend
 *   re-validates with the shared `validatePassword` helper for fast UX.
 *
 * Why two tokens (NextAuth session + backend JWT)
 * -----------------------------------------------
 * NextAuth issues an **encrypted** JWT (JWE, `dir+A256GCM`) for its
 * session cookie, while the backend issues a **signed** JWT (JWS HS256)
 * for `Authorization: Bearer …` headers. The two formats are produced
 * by different libraries (`jose` vs `jsonwebtoken`) and are NOT
 * interchangeable, even when they share the same secret — JWE and JWS
 * are distinct serialisations.
 *
 * To call protected backend APIs from server components, we therefore
 * stash the backend-issued JWS inside the NextAuth session (`backendToken`
 * field). It looks redundant but it's the cheapest path to a working
 * end-to-end flow. The bundled token costs ~700 extra bytes in the
 * cookie and that's fine.
 *
 * If you ever want to drop the bundling, you must either:
 *   1. Switch NextAuth to issue a JWS by overriding `jwt.encode/decode`
 *      (search the NextAuth docs for "custom JWT"), or
 *   2. Switch the backend to verify JWE via `jose` instead of
 *      `jsonwebtoken`.
 * Both options are larger refactors than the bundling is worth today.
 *
 * Validates: Requirements 16.1, 16.2, 16.5.
 */

import type { NextAuthOptions, User as NextAuthUser } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import { SESSION_TIMEOUT_MINUTES } from '@bharat-benefits/shared';

/** Backend base URL — defaults to local dev port 4000. */
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4000';

/** 30-minute session ⇒ matches platform inactivity timeout. */
export const SESSION_MAX_AGE_SECONDS = SESSION_TIMEOUT_MINUTES * 60;

/** Slide the JWT forward on every request to enforce a *sliding* 30-minute window. */
export const SESSION_UPDATE_AGE_SECONDS = 0;

interface BackendAuthResult {
  user: { id: string; email: string; authProvider: string; emailVerified: boolean };
  token: string;
  expiresInSeconds: number;
}

interface BackendErrorBody {
  error?: string;
  message?: string;
  retryAfterSeconds?: number;
}

/**
 * Stable error codes surfaced to the login page via NextAuth's
 * `?error=<code>` redirect param. The login page maps these to friendly
 * messages. New codes added here MUST also be handled in `app/login/page.tsx`'s
 * error message lookup so users don't see a raw token.
 *
 * The numeric portion of `AccountLocked:<seconds>` is parsed back out by
 * the login page to render a countdown; everything else is a plain code.
 */
export const AUTH_ERROR_CODES = {
  invalidCredentials: 'InvalidCredentials',
  accountLocked: 'AccountLocked',
  weakPassword: 'WeakPassword',
  networkError: 'NetworkError',
} as const;

/**
 * Calls the backend `/auth/login` endpoint to authenticate credentials.
 *
 * Returns the NextAuth user on success. On failure THROWS an Error whose
 * message is a stable error code — NextAuth catches this and forwards
 * the message as `?error=<code>` so the login page can render a specific
 * message per cause (Req 16.8 lockout + general UX).
 *
 * Why throw instead of return null? NextAuth's `authorize()` contract
 * collapses `return null` into a single opaque `CredentialsSignin`
 * error. Throwing lets us carry the backend's actual reason (locked,
 * weak password, invalid creds) all the way to the login form, which is
 * what the user needs to see to recover.
 */
async function authenticateAgainstBackend(
  email: string,
  password: string,
): Promise<NextAuthUser> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    // Network-level failure (DNS, TLS, backend down). Distinct from
    // 4xx/5xx so the login page can suggest a retry rather than a fix.
    throw new Error(AUTH_ERROR_CODES.networkError);
  }

  if (res.ok) {
    const data = (await res.json()) as BackendAuthResult;
    return {
      id: data.user.id,
      email: data.user.email,
      // Store backend-issued JWT so server components can call protected APIs.
      // NextAuth allows extra fields on User; they propagate to `jwt` callback.
      ...({ backendToken: data.token } as Record<string, unknown>),
    };
  }

  // Parse the structured error envelope set by routes/auth.routes.ts.
  // Be defensive: a misbehaving proxy or 5xx without JSON should still
  // surface a sensible code rather than crash the auth flow.
  const body: BackendErrorBody = await res.json().catch(() => ({}));

  if (body.error === 'AccountLocked') {
    const seconds = typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : 0;
    // Pack the retry-after into the code so the login page can render a
    // countdown without a second round trip. NextAuth treats the whole
    // string as opaque, so the colon is safe.
    throw new Error(`${AUTH_ERROR_CODES.accountLocked}:${seconds}`);
  }
  if (body.error === 'WeakPassword') {
    throw new Error(AUTH_ERROR_CODES.weakPassword);
  }
  // Default — covers InvalidCredentials (401), BadRequest (400), and any
  // unmapped 4xx. Returning the generic code rather than leaking the raw
  // backend error matches the security guidance to never disclose
  // whether an email exists.
  throw new Error(AUTH_ERROR_CODES.invalidCredentials);
}

/** Builds the providers list. Google is included only when configured. */
function buildProviders(): NextAuthOptions['providers'] {
  const providers: NextAuthOptions['providers'] = [
    CredentialsProvider({
      name: 'Email and password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(creds) {
        if (!creds?.email || !creds?.password) {
          throw new Error(AUTH_ERROR_CODES.invalidCredentials);
        }
        // Don't pre-validate the password here: an existing user whose
        // password was set under an older policy would be locked out of
        // their own account if we did. The backend is the policy source
        // of truth (Req 16.2) — if it accepted the password at registration
        // it must accept it at sign-in. Auth errors from the backend
        // bubble up as typed codes via authenticateAgainstBackend.
        return authenticateAgainstBackend(creds.email, creds.password);
      },
    }),
  ];

  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (googleClientId && googleClientSecret) {
    providers.push(
      GoogleProvider({
        clientId: googleClientId,
        clientSecret: googleClientSecret,
      }),
    );
  }
  return providers;
}

export const authOptions: NextAuthOptions = {
  providers: buildProviders(),
  session: {
    strategy: 'jwt',
    maxAge: SESSION_MAX_AGE_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
  },
  jwt: {
    maxAge: SESSION_MAX_AGE_SECONDS,
  },
  pages: {
    signIn: '/login',
  },
  callbacks: {
    async jwt({ token, user }: { token: JWT; user?: NextAuthUser }) {
      if (user) {
        const backendToken = (user as unknown as Record<string, unknown>).backendToken;
        if (typeof backendToken === 'string') {
          (token as Record<string, unknown>).backendToken = backendToken;
        }
        if (user.id) token.sub = user.id;
        if (user.email) token.email = user.email;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user = {
          ...session.user,
          // expose user id so client code can correlate with backend user
          id: typeof token.sub === 'string' ? token.sub : undefined,
        } as typeof session.user & { id?: string };
      }
      const backendToken = (token as Record<string, unknown>).backendToken;
      if (typeof backendToken === 'string') {
        (session as unknown as Record<string, unknown>).backendToken = backendToken;
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};

export type { NextAuthOptions };
