/**
 * Scheme detail page (Req 2.5, 4.1, 7.2).
 *
 * Server component that:
 *   - Fetches the full scheme detail from `GET /api/schemes/:id`,
 *   - Fetches the citizen's eligibility from
 *     `GET /api/schemes/:id/eligibility` when a NextAuth session is
 *     available (the backend-issued JWT is forwarded as a Bearer token),
 *   - Renders the scheme name, simplified description, eligibility
 *     criteria, benefits, application process, required documents,
 *     official source URL, last verified date, the eligibility status,
 *     and the compatibility relationships.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../../lib/auth';
import { fetchSchemeDetail,
  fetchSchemeEligibility,
  type SchemeDetailResponse,
  type SchemeEligibilityResponse,
} from '../../../../lib/api';
import { SchemeDetail } from '../../../../components/SchemeDetail';
import { EligibilityBadge } from '../../../../components/EligibilityBadge';
import { CompatibilityList } from '../../../../components/CompatibilityList';
import { MAIN_CONTENT_ID } from '../../../../components/SkipLink';

interface PageProps {
  params: { id: string };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  try {
    const detail = await fetchSchemeDetail(params.id);
    if (!detail) return { title: 'Scheme not found — Bharat Benefits AI' };
    return {
      title: `${detail.scheme.name} — Bharat Benefits AI`,
      description: detail.scheme.description.slice(0, 200),
    };
  } catch {
    return { title: 'Scheme — Bharat Benefits AI' };
  }
}

export default async function SchemeDetailPage({ params }: PageProps) {
  const id = params.id?.trim();
  if (!id) notFound();

  let detail: SchemeDetailResponse | null;
  try {
    detail = await fetchSchemeDetail(id);
  } catch (err) {
    return (
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}
      >
        <h1>Could not load scheme</h1>
        <p style={{ color: '#cf222e' }}>
          {err instanceof Error ? err.message : 'Unknown error'}
        </p>
        <p>
          <a href="/schemes" style={{ color: '#0b5394' }}>
            Back to all schemes
          </a>
        </p>
      </main>
    );
  }

  if (!detail) notFound();

  // Best-effort eligibility fetch — only available when a session exists and
  // the backend was able to compute it. Failures collapse to "no eligibility
  // available" rather than a fatal error so the rest of the page still
  // renders.
  let eligibilityResponse: SchemeEligibilityResponse | null = null;
  let isAuthenticated = false;
  try {
    const session = await getServerSession(authOptions);
    const backendToken =
      typeof (session as unknown as { backendToken?: unknown })?.backendToken === 'string'
        ? ((session as unknown as { backendToken: string }).backendToken)
        : null;
    isAuthenticated = backendToken !== null;
    if (backendToken) {
      eligibilityResponse = await fetchSchemeEligibility(
        id,
        `Bearer ${backendToken}`,
      );
    }
  } catch {
    // Treat eligibility failures as non-fatal — the detail page is still useful
    // without the personalised eligibility verdict.
    eligibilityResponse = null;
  }

  return (
    <main
      id={MAIN_CONTENT_ID}
      tabIndex={-1}
      style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}
    >
      <nav style={{ fontSize: 13, color: '#57606a', marginBottom: 8 }}>
        <a href="/schemes" style={{ color: '#0b5394' }}>
          All Schemes
        </a>{' '}
        / {detail.scheme.name}
      </nav>

      <SchemeDetail scheme={detail.scheme} />

      <EligibilityBadge
        eligibility={eligibilityResponse?.eligibility ?? null}
        isAuthenticated={isAuthenticated}
      />

      <CompatibilityList relationships={detail.relationships} />
    </main>
  );
}
