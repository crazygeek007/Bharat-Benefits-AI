/**
 * Admin Dashboard layout (Requirement 17).
 *
 * Provides a shared header + secondary navigation across the admin
 * sub-routes (overview, flags, schemes, analytics). Server component —
 * keeps everything renderable on the server so the citizen-facing
 * bundle never ships admin code.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { MAIN_CONTENT_ID } from '../../components/SkipLink';

export const metadata: Metadata = {
  title: 'Admin Dashboard — Bharat Benefits AI',
  description:
    'Manage scheme verification, flagged content, and system health for Bharat Benefits AI.',
};

const NAV_ITEMS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/flags', label: 'Flagged Schemes' },
  { href: '/admin/schemes', label: 'Manage Schemes' },
  { href: '/admin/analytics', label: 'Analytics' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: '#f6f8fa' }}>
      <header
        style={{
          background: '#0b5394',
          color: '#fff',
          padding: '16px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 18 }}>
          <Link href="/admin" style={{ color: '#fff', textDecoration: 'none' }}>
            Bharat Benefits AI · Admin
          </Link>
        </h1>
        <Link href="/schemes" style={{ color: '#fff', fontSize: 13 }}>
          Back to citizen view
        </Link>
      </header>
      <nav
        aria-label="Admin sections"
        style={{
          background: '#fff',
          borderBottom: '1px solid #d0d7de',
          padding: '0 24px',
        }}
      >
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            gap: 24,
            fontSize: 14,
          }}
        >
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                style={{
                  display: 'inline-block',
                  padding: '12px 0',
                  color: '#24292f',
                  textDecoration: 'none',
                  borderBottom: '2px solid transparent',
                }}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}
      >
        {children}
      </main>
    </div>
  );
}
