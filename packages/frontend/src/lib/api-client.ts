/**
 * Typed API client for all backend services.
 *
 * Centralizes communication between the frontend and backend, providing:
 *   - Typed methods for every backend endpoint (schemes, search, comparison,
 *     dashboard, profile, voice, notifications)
 *   - Integrated SWR caching for repeated scheme reads (500ms target)
 *   - Auth token forwarding for protected endpoints
 *
 * Validates: Requirements 18.5 (API response caching), 10.6 (notification delivery).
 */

import type {
  EligibilityResult,
  Scheme,
  SchemeRelationship,
  SupportedLanguage,
  UserProfile,
} from '@bharat-benefits/shared';
import { SWRCache } from './cache';
import type {
  SchemeFilters,
  PaginationOptions,
  SchemeListResponse,
  SchemeSearchResponse,
  SchemeDetailResponse,
  SchemeEligibilityResponse,
  SchemeComparisonResponse,
  SchemeComparisonError,
  SchemeComparisonResult,
} from './api';
import type { VoiceQueryResponse, PostVoiceQueryArgs } from './voice-api';

// ─── Dashboard Types ─────────────────────────────────────────────────────────

export interface DashboardScheme {
  id: string;
  name: string;
  category: string;
  status: 'Eligible' | 'Applied' | 'Saved' | 'Expired';
  benefitType: 'monetary' | 'non-monetary';
  benefitAmount: number | null;
  deadline: string | null;
  savedAt: string;
  appliedAt: string | null;
}

export interface MissedBenefitsSummary {
  count: number;
  totalMonetaryValue: number;
}

export interface DashboardResponse {
  eligible: DashboardScheme[];
  applied: DashboardScheme[];
  saved: DashboardScheme[];
  expired: DashboardScheme[];
  estimatedTotalBenefitValue: number;
  missedBenefitsSummary: MissedBenefitsSummary;
  counts: { eligible: number; applied: number; saved: number; expired: number };
}

// ─── Profile Types ───────────────────────────────────────────────────────────

export interface ProfileResponse {
  profile: UserProfile | null;
}

export interface UpdateProfileInput {
  age?: number;
  gender?: string;
  state?: string;
  district?: string;
  incomeLevel?: number;
  occupation?: string;
  educationLevel?: string;
  casteCategory?: string;
  disabilityStatus?: boolean;
  maritalStatus?: string;
  dependents?: number;
  languagePreference?: SupportedLanguage;
}

export interface ProfileUpdateResponse {
  profile: UserProfile;
}

// ─── Notification Types ──────────────────────────────────────────────────────

export interface NotificationItem {
  id: string;
  type: string;
  channel: string;
  status: string;
  payload: Record<string, unknown>;
  sentAt: string;
  deliveredAt: string | null;
}

export interface NotificationsResponse {
  notifications: NotificationItem[];
  total: number;
  unreadCount: number;
}

// ─── API Client ──────────────────────────────────────────────────────────────

export interface ApiClientOptions {
  baseUrl?: string;
  authToken?: string | null;
  cache?: SWRCache;
}

function getBaseUrl(): string {
  return (
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    'http://localhost:4000'
  );
}

export class ApiClient {
  private baseUrl: string;
  private authToken: string | null;
  private cache: SWRCache;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? getBaseUrl();
    this.authToken = options.authToken ?? null;
    this.cache = options.cache ?? new SWRCache({ staleAfterMs: 30_000, maxAgeMs: 300_000 });
  }

  /** Update the auth token (e.g. after login/refresh). */
  setAuthToken(token: string | null): void {
    this.authToken = token;
  }

  /** Clear all cached data. */
  clearCache(): void {
    this.cache.clear();
  }

  // ─── Schemes (Browsing) ──────────────────────────────────────────────────

  /**
   * Fetch paginated, filtered scheme list with SWR caching.
   * Targets 500ms for repeated reads.
   */
  async getSchemes(
    filters: SchemeFilters = {},
    pagination: PaginationOptions = {},
  ): Promise<SchemeListResponse> {
    const cacheKey = `schemes:list:${JSON.stringify(filters)}:${JSON.stringify(pagination)}`;
    return this.cache.getOrFetch(cacheKey, () => this.fetchJson('/api/schemes', {
      params: this.buildSchemeParams(filters, pagination),
    }));
  }

  // ─── Search ──────────────────────────────────────────────────────────────

  /**
   * Search schemes by query with caching for repeated queries.
   */
  async searchSchemes(
    query: string,
    pagination: PaginationOptions = {},
  ): Promise<SchemeSearchResponse> {
    const cacheKey = `schemes:search:${query}:${JSON.stringify(pagination)}`;
    return this.cache.getOrFetch(cacheKey, () => {
      const params = new URLSearchParams();
      params.set('q', query);
      if (pagination.page && pagination.page > 1) params.set('page', String(pagination.page));
      if (pagination.pageSize && pagination.pageSize !== 20) params.set('pageSize', String(pagination.pageSize));
      return this.fetchJson(`/api/schemes/search?${params.toString()}`);
    }, { staleAfterMs: 15_000, maxAgeMs: 120_000 });
  }

  // ─── Scheme Detail ───────────────────────────────────────────────────────

  /**
   * Fetch a single scheme's full detail with caching.
   */
  async getSchemeDetail(id: string): Promise<SchemeDetailResponse | null> {
    const cacheKey = `schemes:detail:${id}`;
    return this.cache.getOrFetch(cacheKey, async () => {
      const res = await this.rawFetch(`/api/schemes/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Failed to load scheme (${res.status})`);
      return res.json() as Promise<SchemeDetailResponse>;
    });
  }

  /**
   * Fetch eligibility for a scheme (authenticated).
   */
  async getSchemeEligibility(schemeId: string): Promise<SchemeEligibilityResponse | null> {
    const res = await this.rawFetch(
      `/api/schemes/${encodeURIComponent(schemeId)}/eligibility`,
      { auth: true },
    );
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`Failed to load eligibility (${res.status})`);
    return res.json() as Promise<SchemeEligibilityResponse>;
  }

  // ─── Comparison ──────────────────────────────────────────────────────────

  /**
   * Compare up to 3 schemes side-by-side.
   */
  async compareSchemes(ids: ReadonlyArray<string>): Promise<SchemeComparisonResult> {
    const params = new URLSearchParams();
    params.set('ids', ids.join(','));
    const res = await this.rawFetch(`/api/schemes/compare?${params.toString()}`, { auth: true });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: res.status, error: body as SchemeComparisonError };
    }
    return { ok: true, data: body as SchemeComparisonResponse };
  }

  // ─── Dashboard ───────────────────────────────────────────────────────────

  /**
   * Fetch the user's benefits dashboard (authenticated).
   */
  async getDashboard(): Promise<DashboardResponse> {
    return this.fetchJson('/api/dashboard', { auth: true });
  }

  /**
   * Save a scheme to the dashboard.
   */
  async saveScheme(schemeId: string): Promise<void> {
    await this.rawFetch('/api/dashboard/save', {
      method: 'POST',
      auth: true,
      body: { schemeId },
    });
    this.cache.invalidatePrefix('schemes:');
  }

  /**
   * Mark a saved scheme as applied.
   */
  async markAsApplied(schemeId: string): Promise<void> {
    await this.rawFetch('/api/dashboard/applied', {
      method: 'POST',
      auth: true,
      body: { schemeId },
    });
    this.cache.invalidatePrefix('schemes:');
  }

  // ─── Profile ─────────────────────────────────────────────────────────────

  /**
   * Fetch the authenticated user's profile.
   */
  async getProfile(): Promise<ProfileResponse> {
    return this.fetchJson('/api/profile', { auth: true });
  }

  /**
   * Update user profile fields.
   */
  async updateProfile(data: UpdateProfileInput): Promise<ProfileUpdateResponse> {
    const result = await this.fetchJson<ProfileUpdateResponse>('/api/profile', {
      method: 'PUT',
      auth: true,
      body: data,
    });
    // Invalidate scheme caches since eligibility may have changed
    this.cache.invalidatePrefix('schemes:');
    return result;
  }

  /**
   * Request account/profile deletion.
   */
  async deleteProfile(): Promise<void> {
    await this.rawFetch('/api/profile', { method: 'DELETE', auth: true });
    this.cache.clear();
  }

  // ─── Voice ───────────────────────────────────────────────────────────────

  /**
   * Submit a voice query (audio blob encoded as base64).
   */
  async submitVoiceQuery(args: {
    audioBase64: string;
    language: SupportedLanguage;
    sessionId: string;
    attempt?: number;
  }): Promise<VoiceQueryResponse> {
    const res = await this.rawFetch('/api/voice/query', {
      method: 'POST',
      body: {
        audio: args.audioBase64,
        language: args.language,
        sessionId: args.sessionId,
        attempt: args.attempt ?? 1,
      },
    });

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (body && typeof body === 'object' && 'status' in (body as Record<string, unknown>)) {
      return body as VoiceQueryResponse;
    }

    return {
      status: 'service_unavailable',
      language: args.language,
      failedStage: 'stt',
      message: `Voice service returned HTTP ${res.status}`,
    } as VoiceQueryResponse;
  }

  // ─── Notifications ───────────────────────────────────────────────────────

  /**
   * Fetch notification history for the authenticated user.
   */
  async getNotifications(page = 1, pageSize = 20): Promise<NotificationsResponse> {
    const params = new URLSearchParams();
    if (page > 1) params.set('page', String(page));
    if (pageSize !== 20) params.set('pageSize', String(pageSize));
    const qs = params.toString();
    return this.fetchJson(`/api/notifications${qs ? `?${qs}` : ''}`, { auth: true });
  }

  /**
   * Mark a notification as read.
   */
  async markNotificationRead(notificationId: string): Promise<void> {
    await this.rawFetch(`/api/notifications/${encodeURIComponent(notificationId)}/read`, {
      method: 'POST',
      auth: true,
    });
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private buildSchemeParams(
    filters: SchemeFilters,
    pagination: PaginationOptions,
  ): URLSearchParams {
    const params = new URLSearchParams();
    if (filters.state) params.set('state', filters.state);
    if (filters.category) params.set('category', filters.category);
    if (filters.benefitType) params.set('benefitType', filters.benefitType);
    if (filters.gender) params.set('gender', filters.gender);
    if (filters.occupation) params.set('occupation', filters.occupation);
    if (filters.age !== undefined && Number.isFinite(filters.age)) params.set('age', String(filters.age));
    if (filters.incomeLevel !== undefined && Number.isFinite(filters.incomeLevel)) {
      params.set('incomeLevel', String(filters.incomeLevel));
    }
    if (pagination.page && pagination.page > 1) params.set('page', String(pagination.page));
    if (pagination.pageSize && pagination.pageSize !== 20) params.set('pageSize', String(pagination.pageSize));
    return params;
  }

  private async rawFetch(
    path: string,
    options: {
      method?: string;
      auth?: boolean;
      body?: unknown;
      params?: URLSearchParams;
    } = {},
  ): Promise<Response> {
    const { method = 'GET', auth = false, body, params } = options;
    let url = `${this.baseUrl}${path}`;
    if (params) {
      const qs = params.toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }

    const headers: Record<string, string> = {};
    if (auth && this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    return fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  }

  private async fetchJson<T>(
    path: string,
    options: {
      method?: string;
      auth?: boolean;
      body?: unknown;
      params?: URLSearchParams;
    } = {},
  ): Promise<T> {
    const res = await this.rawFetch(path, options);
    if (!res.ok) {
      throw new Error(`API request failed: ${options.method ?? 'GET'} ${path} (${res.status})`);
    }
    return res.json() as Promise<T>;
  }
}

/** Create a pre-configured API client instance. */
export function createApiClient(options?: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}
