'use client';

/**
 * Wraps the app in NextAuth's SessionProvider so client components
 * can use `useSession` hook to access session state.
 */

import { SessionProvider } from 'next-auth/react';

export function SessionWrapper({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
