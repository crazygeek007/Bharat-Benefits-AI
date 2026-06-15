/**
 * Scheme comparison page (Requirement 24).
 *
 * Server component that:
 *   - Reads the scheme ids from the `?ids=` query string,
 *   - Validates the count locally so the citizen sees a friendly prompt
 *     when they have fewer than 2 selections (Req 24.2) or attempt more
 *     than 3 (Req 24.3) before the request is even issued,
 *   - Calls `GET /api/schemes/compare`, forwarding the citizen's NextAuth
 *     backend token so the response includes per-scheme eligibility
 *     (Req 24.6),
 *   - Renders the side-by-side comparison table.
 */

import type { Metadata } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../lib/auth';
import { fetchSchemeComparison,
  MAX_COMPARISON_SCHEMES,
  MIN_COMPARISON_SCHEMES,
  type SchemeComparisonResult,
} from '../../../lib/api';
import { SchemeComparisonTable } from '../../../components/SchemeComparisonTable';
import { MAIN_CONTENT_ID } from '../../../components/SkipLink';

export const metadata: Metadata = {
  title: 'Compare Schemes — Bharat Benefits AI',
  description:
    'Compare up to 3 government welfare schemes side-by-side across eligibility, benefits, deadlines, documents, and the application process.',
};

interface PageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

/**
 * Reads `?ids=` from the URL. Accepts either a single comma-separated
 * value (`?ids=a,b,c`) or a repeated parameter (`?ids=a&ids=b`). Returns
 * an array of trimmed, non-empty ids in the order the citizen supplied
 * them so the comparison columns match the order they selected the
 * schemes.
 */
function readIds(
  searchParams: Record<string, string | string[] | undefined>,
): string[] {
  const raw = searchParams.ids ?? searchParams.id;
  const sources: string[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) if (typeof v === 'string') sources.push(v);
  } else if (typeof raw === 'string') {
    sources.push(raw);
  }
  const result: string[] = [];
  for (const source of sources) {
    for (const part of source.split(',')) {
      const trimmed = part.trim();
      if (trimmed.length > 0 && !result.includes(trimmed)) {
        result.push(trimmed);
      }
    }
  }
  return result;
}

export default async function ComparePage({ searchParams = {} }: PageProps) {
  const ids = readIds(searchParams);

  if (ids.length < MIN_COMPARISON_SCHEMES) {
    return (
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}
      >
        <h1>Compare schemes</h1>
        <p style={{ color: '#57606a' }}>
          Select at least {MIN_COMPARISON_SCHEMES} schemes from the listing
          page to compare them side by side.
        </p>
        <p>
          <a href="/schemes" style={{ color: '#0b5394' }}>
            Browse schemes →
          </a>
        </p>
      </main>
    );
  }

  if (ids.length > MAX_COMPARISON_SCHEMES) {
    return (
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}
      >
        <h1>Compare schemes</h1>
        <div
          role="alert"
          style={{
            padding: 12,
            border: '1px solid #d4a72c',
            background: '#fff8c5',
            color: '#7d4e00',
            borderRadius: 4,
            marginBottom: 16,
          }}
        >
          You can compare a maximum of {MAX_COMPARISON_SCHEMES} schemes at
          once. Please remove a scheme from your selection before adding
          another.
        </div>
        <p>
          <a href="/schemes" style={{ color: '#0b5394' }}>
            ← Back to schemes
          </a>
        </p>
      </main>
    );
  }

  // Best-effort token forwarding so the response can include per-scheme
  // eligibility (Req 24.6). When no session exists the comparison still
  // renders — the eligibility row simply prompts sign-in.
  let authHeader: string | null = null;
  let isAuthenticated = false;
  try {
    const session = await getServerSession(authOptions);
    const backendToken =
      typeof (session as unknown as { backendToken?: unknown })?.backendToken === 'string'
        ? ((session as unknown as { backendToken: string }).backendToken)
        : null;
    isAuthenticated = backendToken !== null;
    if (backendToken) authHeader = `Bearer ${backendToken}`;
  } catch {
    // Treat session lookup failures as anonymous — the comparison itself
    // is public information.
    authHeader = null;
  }

  let result: SchemeComparisonResult;
  try {
    result = await fetchSchemeComparison(ids, authHeader);
  } catch (err) {
    return (
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}
      >
        <h1>Compare schemes</h1>
        <p style={{ color: '#cf222e' }}>
          {err instanceof Error ? err.message : 'Could not load comparison.'}
        </p>
        <p>
          <a href="/schemes" style={{ color: '#0b5394' }}>
            Back to all schemes
          </a>
        </p>
      </main>
    );
  }

  if (!result.ok) {
    const { error, status } = result;
    let friendly = error.message ?? 'Could not load comparison.';
    if (error.code === 'TOO_FEW_SCHEMES') {
      friendly = `Select at least ${error.minimum ?? MIN_COMPARISON_SCHEMES} schemes to compare.`;
    } else if (error.code === 'TOO_MANY_SCHEMES') {
      friendly = `You can compare a maximum of ${error.maximum ?? MAX_COMPARISON_SCHEMES} schemes at once. Please remove a scheme before adding another.`;
    } else if (error.code === 'DUPLICATE_SCHEME') {
      friendly = `The scheme "${error.schemeId}" was selected more than once.`;
    } else if (status === 404) {
      const missing = error.missingIds?.join(', ') ?? 'one or more schemes';
      friendly = `We couldn't find ${missing}. They may have been removed — please return to the listing and try again.`;
    }
    return (
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}
      >
        <h1>Compare schemes</h1>
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
          {friendly}
        </div>
        <p>
          <a href="/schemes" style={{ color: '#0b5394' }}>
            ← Back to schemes
          </a>
        </p>
      </main>
    );
  }

  return (
    <main
      id={MAIN_CONTENT_ID}
      tabIndex={-1}
      style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}
    >
      <nav style={{ fontSize: 13, color: '#57606a', marginBottom: 8 }}>
        <a href="/schemes" style={{ color: '#0b5394' }}>
          All Schemes
        </a>{' '}
        / Compare
      </nav>
      <h1 style={{ marginBottom: 8 }}>
        Compare {result.data.schemes.length} schemes
      </h1>
      <p style={{ color: '#57606a', marginTop: 0 }}>
        Rows highlighted in yellow show attributes where the selected schemes
        differ. Cells marked “Information not available” mean the official
        source did not publish that detail — use the source link to verify
        directly.
      </p>

      <SchemeComparisonTable
        data={result.data}
        isAuthenticated={isAuthenticated}
      />

      <p style={{ marginTop: 16 }}>
        <a href="/schemes" style={{ color: '#0b5394' }}>
          ← Back to schemes
        </a>
      </p>
    </main>
  );
}
