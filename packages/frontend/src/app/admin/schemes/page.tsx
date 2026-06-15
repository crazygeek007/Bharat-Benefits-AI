/**
 * Manage Schemes admin page (Requirement 17.2).
 *
 * Server component that lists every scheme — verified or not — and
 * lets administrators verify, edit, or remove them. Each modification
 * is recorded in the audit log on the backend.
 *
 * Lists are sourced from the public `/api/schemes` browse endpoint
 * for visible schemes; that endpoint already returns the visible
 * dataset. Unverified schemes can still be reached via the flagged
 * schemes page or by entering an id directly into the URL.
 */

import Link from 'next/link';
import { getAdminAuthContext } from '../../../lib/admin-auth';
import { fetchSchemes } from '../../../lib/api';
import { SchemeManagementCard } from './SchemeManagementCard';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

function readSearch(
  searchParams: Record<string, string | string[] | undefined>,
): string {
  const raw = searchParams.q;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

function readPage(
  searchParams: Record<string, string | string[] | undefined>,
): number {
  const raw = searchParams.page;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export default async function ManageSchemesPage({ searchParams = {} }: PageProps) {
  const { isAuthenticated } = await getAdminAuthContext();
  if (!isAuthenticated) {
    return (
      <p>
        <Link href="/api/auth/signin">Sign in as administrator</Link> to manage
        schemes.
      </p>
    );
  }

  const search = readSearch(searchParams);
  const page = readPage(searchParams);

  let schemes: Awaited<ReturnType<typeof fetchSchemes>>['schemes'] = [];
  let totalCount = 0;
  let totalPages = 0;
  let loadError: string | null = null;
  try {
    const result = await fetchSchemes({}, { page, pageSize: 20 });
    schemes = result.schemes;
    totalCount = result.totalCount;
    totalPages = result.totalPages;
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Failed to load schemes';
  }

  // Filter client-side by name if search is supplied — keeps the page
  // simple without standing up a dedicated admin search endpoint.
  const filtered = search
    ? schemes.filter(
        (s) =>
          s.name.toLowerCase().includes(search.toLowerCase()) ||
          s.id.toLowerCase().includes(search.toLowerCase()),
      )
    : schemes;

  return (
    <>
      <h2 style={{ marginTop: 0 }}>Manage schemes</h2>
      <p style={{ color: '#57606a' }}>
        Verify, edit, or remove schemes. Every change records an audit-log
        entry capturing your administrator identity, the action, and the
        timestamp.
      </p>

      <form
        method="get"
        style={{ display: 'flex', gap: 8, marginBottom: 16 }}
      >
        <input
          name="q"
          defaultValue={search}
          placeholder="Search by name or id"
          style={{
            flex: 1,
            padding: 8,
            border: '1px solid #d0d7de',
            borderRadius: 6,
          }}
        />
        <button
          type="submit"
          style={{
            padding: '6px 12px',
            background: '#0b5394',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
          }}
        >
          Filter
        </button>
      </form>

      {loadError && (
        <div
          role="alert"
          style={{
            padding: 12,
            border: '1px solid #d73a49',
            background: '#ffeef0',
            color: '#86181d',
            borderRadius: 4,
            marginBottom: 16,
          }}
        >
          {loadError}
        </div>
      )}

      {filtered.length === 0 ? (
        <p style={{ color: '#57606a' }}>
          No schemes match your filters on this page.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filtered.map((scheme) => (
            <SchemeManagementCard
              key={scheme.id}
              scheme={{
                id: scheme.id,
                name: scheme.name,
                description: scheme.description,
                ministry: scheme.ministry,
                state: scheme.state,
                category: scheme.category,
                sourceUrl: scheme.sourceUrl,
                benefitAmount: scheme.benefitAmount,
                applicationMode: scheme.applicationMode,
                applicationUrl: scheme.applicationUrl,
                trustScore: scheme.trustScore,
                verified: scheme.verified,
                lastVerifiedAt: scheme.lastVerifiedAt instanceof Date
                  ? scheme.lastVerifiedAt.toISOString()
                  : (scheme.lastVerifiedAt as unknown as string | null) ?? null,
              }}
            />
          ))}
        </div>
      )}

      <nav
        aria-label="Pagination"
        style={{
          marginTop: 24,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        {page > 1 && (
          <Link
            href={`/admin/schemes?page=${page - 1}${search ? `&q=${encodeURIComponent(search)}` : ''}`}
            style={{ color: '#0b5394' }}
          >
            ← Previous
          </Link>
        )}
        <span style={{ color: '#57606a', fontSize: 13 }}>
          Page {page} of {Math.max(totalPages, 1)} · {totalCount} total
        </span>
        {page < totalPages && (
          <Link
            href={`/admin/schemes?page=${page + 1}${search ? `&q=${encodeURIComponent(search)}` : ''}`}
            style={{ color: '#0b5394' }}
          >
            Next →
          </Link>
        )}
      </nav>
    </>
  );
}
