/**
 * Internal API helpers for talking to the backend service.
 *
 * The browse experience (Requirement 2) is driven by the backend's
 * `GET /api/schemes` endpoint. This module centralises:
 *   - resolving the backend base URL from environment configuration,
 *   - serialising filter inputs to a query string,
 *   - typing the response shape so server components can stay strict.
 */

import type {
  DocumentRequirement,
  EligibilityResult,
  Scheme,
  SchemeCategory,
  SchemeRelationship,
} from '@bharat-benefits/shared';

export type GovernmentLevel = 'Central' | 'State';

export interface SchemeFilters {
  state?: string;
  incomeLevel?: number;
  category?: SchemeCategory;
  age?: number;
  gender?: string;
  occupation?: string;
  benefitType?: 'monetary' | 'non-monetary';
}

export interface PaginationOptions {
  page?: number;
  pageSize?: number;
}

export interface SchemeWithLevel extends Scheme {
  governmentLevel: GovernmentLevel;
}

/** Scheme with a derived match-relevance score, returned by search. */
export interface RankedSchemeWithLevel extends SchemeWithLevel {
  score: number;
}

export interface SchemeListResponse {
  schemes: SchemeWithLevel[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  appliedFilters: SchemeFilters;
  activeFilterCount: number;
}

export type SchemeSearchMode = 'hybrid' | 'elasticsearch' | 'vector' | 'in-memory';

export interface SchemeSearchResponse {
  query: string;
  schemes: RankedSchemeWithLevel[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  searchMode: SchemeSearchMode;
}

function getBackendBaseUrl(): string {
  return (
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    'http://localhost:4000'
  );
}

/** Serialises filters + pagination into a `URLSearchParams` instance. */
export function buildSchemeQueryString(
  filters: SchemeFilters,
  pagination: PaginationOptions = {},
): string {
  const params = new URLSearchParams();
  if (filters.state) params.set('state', filters.state);
  if (filters.category) params.set('category', filters.category);
  if (filters.benefitType) params.set('benefitType', filters.benefitType);
  if (filters.gender) params.set('gender', filters.gender);
  if (filters.occupation) params.set('occupation', filters.occupation);
  if (filters.age !== undefined && Number.isFinite(filters.age)) {
    params.set('age', String(filters.age));
  }
  if (filters.incomeLevel !== undefined && Number.isFinite(filters.incomeLevel)) {
    params.set('incomeLevel', String(filters.incomeLevel));
  }
  if (pagination.page && pagination.page > 1) {
    params.set('page', String(pagination.page));
  }
  if (pagination.pageSize && pagination.pageSize !== 20) {
    params.set('pageSize', String(pagination.pageSize));
  }
  return params.toString();
}

/**
 * Fetches a paginated, filtered list of schemes from the backend. Uses
 * `no-store` because the listing should reflect the latest crawl results
 * (Requirement 1.3) — caching is handled at the data layer, not here.
 */
export async function fetchSchemes(
  filters: SchemeFilters,
  pagination: PaginationOptions = {},
): Promise<SchemeListResponse> {
  const qs = buildSchemeQueryString(filters, pagination);
  const url = `${getBackendBaseUrl()}/api/schemes${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to load schemes (${res.status})`);
  }
  return (await res.json()) as SchemeListResponse;
}

// ─── Scheme detail (Req 2.5, 7.2) ────────────────────────────────────────────

/**
 * Detail row returned by the backend. Mirrors `SchemeDetail` on the server —
 * the citizen-facing scheme entity plus the official document checklist.
 */
export interface SchemeDetail extends Scheme {
  documents: DocumentRequirement[];
}

/**
 * Wire-format scheme detail. The server serialises Date objects as ISO
 * strings so we keep them as `string` here and convert on read where
 * needed (e.g. for the `lastVerifiedAt` display).
 */
export interface SchemeDetailWithLevel extends Omit<
  SchemeDetail,
  'discoveredAt' | 'lastVerifiedAt' | 'updatedAt' | 'deadline'
> {
  governmentLevel: GovernmentLevel;
  discoveredAt: string;
  lastVerifiedAt: string;
  updatedAt: string;
  deadline: string | null;
}

/** Response from `GET /api/schemes/:id`. */
export interface SchemeDetailResponse {
  scheme: SchemeDetailWithLevel;
  relationships: SchemeRelationship[];
}

/** Response from `GET /api/schemes/:id/eligibility`. */
export interface SchemeEligibilityResponse {
  schemeId: string;
  eligibility: EligibilityResult | null;
  /**
   * Set when `eligibility` is null so the UI can render a specific message
   * instead of the catch-all "complete your profile" prompt. Kept narrow to
   * the cases the backend route actually emits.
   */
  reason?: 'profile-missing' | 'scheme-missing' | 'computation-failed';
}

/**
 * Fetches the full scheme detail used by the citizen-facing detail page
 * (Req 2.5, 7.2). Returns `null` when the backend returns 404 so server
 * components can render a not-found state without throwing.
 */
export async function fetchSchemeDetail(
  id: string,
): Promise<SchemeDetailResponse | null> {
  const url = `${getBackendBaseUrl()}/api/schemes/${encodeURIComponent(id)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to load scheme (${res.status})`);
  }
  return (await res.json()) as SchemeDetailResponse;
}

/**
 * Fetches the per-citizen eligibility for a scheme (Req 4.1). Forwards the
 * caller-supplied `Authorization` / cookie header so the protected route
 * sees the citizen's session. Returns `null` when the citizen is not
 * authenticated — the calling page handles that case by showing a sign-in
 * prompt rather than a fatal error.
 */
export async function fetchSchemeEligibility(
  id: string,
  authHeader: string | null,
): Promise<SchemeEligibilityResponse | null> {
  const url = `${getBackendBaseUrl()}/api/schemes/${encodeURIComponent(id)}/eligibility`;
  const headers: Record<string, string> = {};
  if (authHeader) headers.Authorization = authHeader;
  const res = await fetch(url, { cache: 'no-store', headers });
  if (res.status === 401) return null;
  if (!res.ok) {
    throw new Error(`Failed to load eligibility (${res.status})`);
  }
  return (await res.json()) as SchemeEligibilityResponse;
}

/** Minimum query length enforced by the search endpoint (Requirement 2.6). */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/** Default page size returned by the search endpoint (Requirement 2.6). */
export const SEARCH_DEFAULT_PAGE_SIZE = 20;

/**
 * Fetches paginated scheme search results from the backend. The endpoint
 * combines semantic vector retrieval with Elasticsearch full-text matching
 * and ranks results by name / category / description (Requirement 2.6).
 *
 * Throws when the query is too short (the backend returns 400 for
 * sub-2-character queries — callers should validate beforehand).
 */
export async function fetchSchemeSearch(
  query: string,
  pagination: PaginationOptions = {},
): Promise<SchemeSearchResponse> {
  const params = new URLSearchParams();
  params.set('q', query);
  if (pagination.page && pagination.page > 1) {
    params.set('page', String(pagination.page));
  }
  if (pagination.pageSize && pagination.pageSize !== SEARCH_DEFAULT_PAGE_SIZE) {
    params.set('pageSize', String(pagination.pageSize));
  }
  const url = `${getBackendBaseUrl()}/api/schemes/search?${params.toString()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to search schemes (${res.status})`);
  }
  return (await res.json()) as SchemeSearchResponse;
}

// ─── Scheme comparison (Req 24) ──────────────────────────────────────────────

/**
 * Maximum number of schemes the platform allows in a single comparison
 * (Req 24.1, 24.3). Mirrored on the server — the constant is duplicated
 * here so the comparison page can surface the limit without doing a
 * round-trip just to learn it.
 */
export const MAX_COMPARISON_SCHEMES = 3;

/** Minimum number of schemes the comparison view requires (Req 24.2). */
export const MIN_COMPARISON_SCHEMES = 2;

/** Stable list of attributes returned in `attributes[]` order (Req 24.4). */
export type ComparisonAttributeKey =
  | 'eligibilityCriteria'
  | 'benefits'
  | 'deadline'
  | 'requiredDocuments'
  | 'applicationProcess';

/** Wire-format attribute row returned by the comparison endpoint. */
export interface ComparisonAttributeRow {
  attributeName: ComparisonAttributeKey;
  values: Array<{ schemeId: string; value: unknown }>;
  differs: boolean;
}

/** Per-scheme eligibility row attached to a comparison response. */
export interface SchemeEligibilityRow {
  schemeId: string;
  eligibility: EligibilityResult | null;
}

/** Wire-format response from `GET /api/schemes/compare`. */
export interface SchemeComparisonResponse {
  schemes: SchemeDetailWithLevel[];
  attributes: ComparisonAttributeRow[];
  eligibility: SchemeEligibilityRow[];
  requestedIds: string[];
}

/**
 * Discriminated error response from the comparison endpoint. The route
 * uses `code` to flag the precise validation failure so the citizen-facing
 * page can render a friendly message tailored to each case
 * (Req 24.2 — "select more schemes", Req 24.3 — "max reached").
 */
export interface SchemeComparisonError {
  error: string;
  code?: 'TOO_FEW_SCHEMES' | 'TOO_MANY_SCHEMES' | 'DUPLICATE_SCHEME';
  message: string;
  minimum?: number;
  maximum?: number;
  schemeId?: string;
  missingIds?: string[];
}

export type SchemeComparisonResult =
  | { ok: true; data: SchemeComparisonResponse }
  | { ok: false; status: number; error: SchemeComparisonError };

/**
 * Fetches a scheme comparison from the backend (Req 24).
 *
 * Forwards the optional `Authorization` header so the response includes
 * per-scheme eligibility for the authenticated citizen (Req 24.6). When
 * the call succeeds the wrapper returns `{ ok: true, data }`; otherwise
 * it returns the parsed error body so the page can map `code` to the
 * appropriate UI message rather than crashing.
 */
export async function fetchSchemeComparison(
  ids: ReadonlyArray<string>,
  authHeader: string | null = null,
): Promise<SchemeComparisonResult> {
  const params = new URLSearchParams();
  // Pass ids as a comma-separated value so the URL stays compact even at
  // the 3-scheme maximum.
  params.set('ids', ids.join(','));
  const url = `${getBackendBaseUrl()}/api/schemes/compare?${params.toString()}`;
  const headers: Record<string, string> = {};
  if (authHeader) headers.Authorization = authHeader;
  const res = await fetch(url, { cache: 'no-store', headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: body as SchemeComparisonError,
    };
  }
  return { ok: true, data: body as SchemeComparisonResponse };
}
