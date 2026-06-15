/**
 * Server-side helper that resolves the citizen's NextAuth-issued
 * backend token for use against the admin API.
 *
 * The admin pages run as server components and need to forward the
 * citizen's bearer token so the backend's `requireAdmin` guard can
 * verify the role. Returning `null` means "no session" — the page
 * renders the unauthenticated state and prompts the user to sign in.
 */

import { getServerSession } from 'next-auth';
import { authOptions } from './auth';

export interface AdminAuthContext {
  authHeader: string | null;
  /** Convenience flag — `true` when a backend token is available. */
  isAuthenticated: boolean;
}

export async function getAdminAuthContext(): Promise<AdminAuthContext> {
  try {
    const session = await getServerSession(authOptions);
    const backendToken =
      typeof (session as unknown as { backendToken?: unknown })?.backendToken ===
      'string'
        ? ((session as unknown as { backendToken: string }).backendToken)
        : null;
    if (!backendToken) return { authHeader: null, isAuthenticated: false };
    return { authHeader: `Bearer ${backendToken}`, isAuthenticated: true };
  } catch {
    return { authHeader: null, isAuthenticated: false };
  }
}
