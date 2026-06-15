/**
 * Typed fetchers for the admin dashboard endpoints (Requirement 17).
 *
 * Centralises all `Authorization`-bearing calls so the per-page server
 * components stay focused on rendering. Every fetcher returns a
 * discriminated `{ ok, data | error }` so pages can render a friendly
 * error state rather than throwing on a 503.
 *
 * The base URL resolution mirrors `lib/api.ts` — dev defaults to
 * `http://localhost:4000`, overridable via `BACKEND_URL` /
 * `NEXT_PUBLIC_BACKEND_URL`.
 */

export interface AdminApiOk<T> {
  ok: true;
  data: T;
}

export interface AdminApiError {
  ok: false;
  status: number;
  message: string;
}

export type AdminApiResult<T> = AdminApiOk<T> | AdminApiError;

function getBackendBaseUrl(): string {
  return (
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    'http://localhost:4000'
  );
}

async function adminFetch<T>(
  path: string,
  authHeader: string | null,
  init: RequestInit = {},
): Promise<AdminApiResult<T>> {
  const url = `${getBackendBaseUrl()}${path}`;
  const headers = new Headers(init.headers ?? {});
  headers.set('content-type', 'application/json');
  if (authHeader) headers.set('Authorization', authHeader);
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, cache: 'no-store' });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? err.message : 'Network error',
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message =
      (body as { message?: string } | null)?.message ??
      `Request failed with status ${res.status}`;
    return { ok: false, status: res.status, message };
  }
  return { ok: true, data: body as T };
}

// ─── Wire-format types ──────────────────────────────────────────────────────

export interface SystemHealthSnapshot {
  crawler: {
    status: 'running' | 'stopped' | 'error' | 'unknown';
    lastExecutionAt: string | null;
    errorMessage: string | null;
  };
  database: { sizeMb: number };
  api: {
    averageResponseTimeMs: number;
    sampleCount: number;
    windowMs: number;
  };
  generatedAt: string;
}

export interface AnalyticsSnapshot {
  totalSchemes: number;
  activeCitizens: number;
  queriesPerDay: number;
  eligibilityCalculationsPerDay: number;
  windowDays: number;
  generatedAt: string;
}

export interface SchemeFlagSummary {
  id: string;
  name: string;
  ministry: string;
  state: string | null;
  trustScore: number;
  verified: boolean;
  lastVerifiedAt: string | null;
}

export type FlagStatus = 'pending' | 'approved' | 'rejected';
export type FlagSource = 'crawler' | 'change_detector' | 'admin';

export interface SchemeFlagRecord {
  id: string;
  schemeId: string;
  reason: string;
  flagSource: FlagSource;
  sourceUrl: string | null;
  status: FlagStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  flaggedAt: string;
  scheme: SchemeFlagSummary | null;
}

export interface ListFlagsResponse {
  flags: SchemeFlagRecord[];
  totalCount: number;
}

// ─── Fetchers ────────────────────────────────────────────────────────────────

export function fetchAdminHealth(
  authHeader: string | null,
): Promise<AdminApiResult<SystemHealthSnapshot>> {
  return adminFetch<SystemHealthSnapshot>('/api/admin/health', authHeader);
}

export function fetchAdminAnalytics(
  authHeader: string | null,
): Promise<AdminApiResult<AnalyticsSnapshot>> {
  return adminFetch<AnalyticsSnapshot>('/api/admin/analytics', authHeader);
}

export function fetchAdminFlags(
  authHeader: string | null,
  filter: { status?: FlagStatus | 'all'; limit?: number; offset?: number } = {},
): Promise<AdminApiResult<ListFlagsResponse>> {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.limit !== undefined) params.set('limit', String(filter.limit));
  if (filter.offset !== undefined) params.set('offset', String(filter.offset));
  const qs = params.toString();
  return adminFetch<ListFlagsResponse>(
    `/api/admin/flags${qs ? `?${qs}` : ''}`,
    authHeader,
  );
}

export function approveAdminFlag(
  authHeader: string | null,
  flagId: string,
  note?: string,
): Promise<AdminApiResult<{ flag: SchemeFlagRecord }>> {
  return adminFetch<{ flag: SchemeFlagRecord }>(
    `/api/admin/flags/${encodeURIComponent(flagId)}/approve`,
    authHeader,
    { method: 'POST', body: JSON.stringify({ note }) },
  );
}

export function rejectAdminFlag(
  authHeader: string | null,
  flagId: string,
  reason: string,
): Promise<AdminApiResult<{ flag: SchemeFlagRecord }>> {
  return adminFetch<{ flag: SchemeFlagRecord }>(
    `/api/admin/flags/${encodeURIComponent(flagId)}/reject`,
    authHeader,
    { method: 'POST', body: JSON.stringify({ reason }) },
  );
}

export function verifyAdminScheme(
  authHeader: string | null,
  schemeId: string,
  note?: string,
): Promise<AdminApiResult<{ scheme: { id: string; verified: boolean } }>> {
  return adminFetch(
    `/api/admin/schemes/${encodeURIComponent(schemeId)}/verify`,
    authHeader,
    { method: 'POST', body: JSON.stringify({ note }) },
  );
}

export function editAdminScheme(
  authHeader: string | null,
  schemeId: string,
  patch: Record<string, unknown>,
  note?: string,
): Promise<AdminApiResult<{ scheme: Record<string, unknown> }>> {
  return adminFetch(
    `/api/admin/schemes/${encodeURIComponent(schemeId)}`,
    authHeader,
    { method: 'PATCH', body: JSON.stringify({ patch, note }) },
  );
}

export function removeAdminScheme(
  authHeader: string | null,
  schemeId: string,
  reason: string,
): Promise<AdminApiResult<{ removed: true; schemeId: string }>> {
  return adminFetch(
    `/api/admin/schemes/${encodeURIComponent(schemeId)}`,
    authHeader,
    { method: 'DELETE', body: JSON.stringify({ reason }) },
  );
}
