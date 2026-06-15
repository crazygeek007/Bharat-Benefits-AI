/**
 * Unit tests for the typed API client.
 *
 * Verifies that the API client correctly wraps all backend endpoints,
 * forwards auth tokens, integrates the SWR cache, and handles errors.
 *
 * Validates: Requirements 18.5 (caching), 10.6 (notification endpoints).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './api-client';
import { SWRCache } from './cache';

const originalFetch = globalThis.fetch;

function mockFetch(impl: typeof fetch): void {
  globalThis.fetch = impl as typeof fetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ApiClient', () => {
  let client: ApiClient;
  let cache: SWRCache;

  beforeEach(() => {
    cache = new SWRCache({ staleAfterMs: 30_000, maxAgeMs: 300_000 });
    client = new ApiClient({
      baseUrl: 'http://test-backend:4000',
      authToken: 'test-token',
      cache,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ─── Scheme Browsing ─────────────────────────────────────────────────────

  describe('getSchemes', () => {
    it('fetches schemes from /api/schemes with filters', async () => {
      let capturedUrl = '';
      mockFetch(async (url) => {
        capturedUrl = typeof url === 'string' ? url : url.toString();
        return jsonResponse({
          schemes: [],
          page: 1,
          pageSize: 20,
          totalCount: 0,
          totalPages: 0,
          appliedFilters: {},
          activeFilterCount: 0,
        });
      });

      await client.getSchemes({ state: 'Maharashtra', category: 'Education' });
      expect(capturedUrl).toContain('/api/schemes');
      expect(capturedUrl).toContain('state=Maharashtra');
      expect(capturedUrl).toContain('category=Education');
    });

    it('caches scheme list responses', async () => {
      const fetcher = vi.fn().mockImplementation(async () =>
        jsonResponse({ schemes: [{ id: '1' }], page: 1, pageSize: 20, totalCount: 1, totalPages: 1, appliedFilters: {}, activeFilterCount: 0 }),
      );
      mockFetch(fetcher);

      await client.getSchemes({ state: 'Bihar' });
      await client.getSchemes({ state: 'Bihar' });

      // Should only call fetch once due to cache
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it('calls fetch again for different filter combinations', async () => {
      const fetcher = vi.fn().mockImplementation(async () =>
        jsonResponse({ schemes: [], page: 1, pageSize: 20, totalCount: 0, totalPages: 0, appliedFilters: {}, activeFilterCount: 0 }),
      );
      mockFetch(fetcher);

      await client.getSchemes({ state: 'Bihar' });
      await client.getSchemes({ state: 'Kerala' });

      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Search ──────────────────────────────────────────────────────────────

  describe('searchSchemes', () => {
    it('sends the query to /api/schemes/search', async () => {
      let capturedUrl = '';
      mockFetch(async (url) => {
        capturedUrl = typeof url === 'string' ? url : url.toString();
        return jsonResponse({
          query: 'agriculture',
          schemes: [],
          page: 1,
          pageSize: 20,
          totalCount: 0,
          totalPages: 0,
          searchMode: 'hybrid',
        });
      });

      await client.searchSchemes('agriculture');
      expect(capturedUrl).toContain('/api/schemes/search');
      expect(capturedUrl).toContain('q=agriculture');
    });

    it('caches search results', async () => {
      const fetcher = vi.fn().mockImplementation(async () =>
        jsonResponse({ query: 'test', schemes: [], page: 1, pageSize: 20, totalCount: 0, totalPages: 0, searchMode: 'hybrid' }),
      );
      mockFetch(fetcher);

      await client.searchSchemes('test');
      await client.searchSchemes('test');
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });

  // ─── Scheme Detail ───────────────────────────────────────────────────────

  describe('getSchemeDetail', () => {
    it('returns scheme detail from cache on repeated reads', async () => {
      const payload = {
        scheme: { id: 'abc', name: 'Scheme A', documents: [] },
        relationships: [],
      };
      const fetcher = vi.fn().mockImplementation(async () => jsonResponse(payload));
      mockFetch(fetcher);

      const first = await client.getSchemeDetail('abc');
      const second = await client.getSchemeDetail('abc');

      expect(first).toEqual(payload);
      expect(second).toEqual(payload);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it('returns null when the scheme is not found', async () => {
      mockFetch(async () => new Response('not found', { status: 404 }));
      const result = await client.getSchemeDetail('missing');
      expect(result).toBeNull();
    });
  });

  // ─── Eligibility ─────────────────────────────────────────────────────────

  describe('getSchemeEligibility', () => {
    it('forwards auth token and returns eligibility', async () => {
      let capturedHeaders: Record<string, string> = {};
      mockFetch(async (_url, init) => {
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        return jsonResponse({
          schemeId: 'abc',
          eligibility: { status: 'Eligible', metCriteria: [], unmetCriteria: [], unevaluatedCriteria: [], missingProfileFields: [] },
        });
      });

      const result = await client.getSchemeEligibility('abc');
      expect(capturedHeaders.Authorization).toBe('Bearer test-token');
      expect(result!.eligibility!.status).toBe('Eligible');
    });

    it('returns null on 401 (unauthenticated)', async () => {
      mockFetch(async () => new Response('unauth', { status: 401 }));
      const result = await client.getSchemeEligibility('abc');
      expect(result).toBeNull();
    });
  });

  // ─── Comparison ──────────────────────────────────────────────────────────

  describe('compareSchemes', () => {
    it('sends ids as comma-separated query param', async () => {
      let capturedUrl = '';
      mockFetch(async (url) => {
        capturedUrl = typeof url === 'string' ? url : url.toString();
        return jsonResponse({
          schemes: [],
          attributes: [],
          eligibility: [],
          requestedIds: ['a', 'b'],
        });
      });

      await client.compareSchemes(['a', 'b']);
      expect(capturedUrl).toContain('ids=a%2Cb');
    });

    it('returns { ok: false } on error responses', async () => {
      mockFetch(async () =>
        jsonResponse(
          { error: 'BadRequest', code: 'TOO_MANY_SCHEMES', message: 'max 3', maximum: 3 },
          400,
        ),
      );
      const result = await client.compareSchemes(['a', 'b', 'c', 'd']);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('TOO_MANY_SCHEMES');
    });
  });

  // ─── Dashboard ───────────────────────────────────────────────────────────

  describe('getDashboard', () => {
    it('fetches dashboard from /api/dashboard with auth', async () => {
      let capturedHeaders: Record<string, string> = {};
      let capturedUrl = '';
      mockFetch(async (url, init) => {
        capturedUrl = typeof url === 'string' ? url : url.toString();
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        return jsonResponse({
          eligible: [],
          applied: [],
          saved: [],
          expired: [],
          estimatedTotalBenefitValue: 50000,
          missedBenefitsSummary: { count: 0, totalMonetaryValue: 0 },
          counts: { eligible: 0, applied: 0, saved: 0, expired: 0 },
        });
      });

      const result = await client.getDashboard();
      expect(capturedUrl).toContain('/api/dashboard');
      expect(capturedHeaders.Authorization).toBe('Bearer test-token');
      expect(result.estimatedTotalBenefitValue).toBe(50000);
    });
  });

  describe('saveScheme', () => {
    it('posts to /api/dashboard/save and invalidates cache', async () => {
      let capturedBody = '';
      mockFetch(async (_url, init) => {
        capturedBody = init?.body as string ?? '';
        return jsonResponse({ success: true });
      });

      cache.set('schemes:detail:abc', { id: 'abc' });
      await client.saveScheme('abc');
      expect(JSON.parse(capturedBody)).toEqual({ schemeId: 'abc' });
      // Cache should be invalidated
      expect(cache.get('schemes:detail:abc')).toBeUndefined();
    });
  });

  // ─── Profile ─────────────────────────────────────────────────────────────

  describe('getProfile', () => {
    it('fetches profile from /api/profile with auth', async () => {
      let capturedUrl = '';
      mockFetch(async (url) => {
        capturedUrl = typeof url === 'string' ? url : url.toString();
        return jsonResponse({ profile: { age: 30, gender: 'Male', state: 'Bihar' } });
      });

      const result = await client.getProfile();
      expect(capturedUrl).toContain('/api/profile');
      expect(result.profile).toBeDefined();
    });
  });

  describe('updateProfile', () => {
    it('sends PUT to /api/profile and invalidates scheme caches', async () => {
      let capturedMethod = '';
      let capturedBody = '';
      mockFetch(async (_url, init) => {
        capturedMethod = init?.method ?? '';
        capturedBody = init?.body as string ?? '';
        return jsonResponse({ profile: { age: 35, gender: 'Male', state: 'Bihar' } });
      });

      cache.set('schemes:list:{}:{}', { schemes: [] });
      await client.updateProfile({ age: 35 });
      expect(capturedMethod).toBe('PUT');
      expect(JSON.parse(capturedBody)).toEqual({ age: 35 });
      // Cache invalidated
      expect(cache.get('schemes:list:{}:{}')).toBeUndefined();
    });
  });

  // ─── Voice ───────────────────────────────────────────────────────────────

  describe('submitVoiceQuery', () => {
    it('posts audio to /api/voice/query and returns the verdict', async () => {
      let capturedUrl = '';
      mockFetch(async (url) => {
        capturedUrl = typeof url === 'string' ? url : url.toString();
        return jsonResponse({
          status: 'ok',
          transcript: 'hello',
          confidence: 95,
          language: 'en',
          answer: 'test answer',
          sources: [],
          audioBase64: 'abc',
          audioMimeType: 'audio/mp3',
          traceId: 'tr-1',
        });
      });

      const result = await client.submitVoiceQuery({
        audioBase64: 'base64data',
        language: 'en',
        sessionId: 'sess-1',
      });
      expect(capturedUrl).toContain('/api/voice/query');
      expect(result.status).toBe('ok');
    });

    it('returns service_unavailable on unexpected responses', async () => {
      mockFetch(async () => new Response('error', { status: 500 }));
      const result = await client.submitVoiceQuery({
        audioBase64: 'data',
        language: 'hi',
        sessionId: 'sess-2',
      });
      expect(result.status).toBe('service_unavailable');
    });
  });

  // ─── Notifications ───────────────────────────────────────────────────────

  describe('getNotifications', () => {
    it('fetches notifications from /api/notifications with auth', async () => {
      let capturedUrl = '';
      mockFetch(async (url) => {
        capturedUrl = typeof url === 'string' ? url : url.toString();
        return jsonResponse({
          notifications: [{ id: 'n1', type: 'deadline_reminder' }],
          total: 1,
          unreadCount: 1,
        });
      });

      const result = await client.getNotifications();
      expect(capturedUrl).toContain('/api/notifications');
      expect(result.notifications).toHaveLength(1);
    });
  });

  describe('markNotificationRead', () => {
    it('posts to the read endpoint', async () => {
      let capturedUrl = '';
      let capturedMethod = '';
      mockFetch(async (url, init) => {
        capturedUrl = typeof url === 'string' ? url : url.toString();
        capturedMethod = init?.method ?? '';
        return jsonResponse({ success: true });
      });

      await client.markNotificationRead('n1');
      expect(capturedUrl).toContain('/api/notifications/n1/read');
      expect(capturedMethod).toBe('POST');
    });
  });

  // ─── Auth Token Management ───────────────────────────────────────────────

  describe('setAuthToken', () => {
    it('updates the token used for subsequent requests', async () => {
      let capturedHeaders: Record<string, string> = {};
      mockFetch(async (_url, init) => {
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        return jsonResponse({ profile: null });
      });

      client.setAuthToken('new-token');
      await client.getProfile();
      expect(capturedHeaders.Authorization).toBe('Bearer new-token');
    });
  });

  // ─── Error Handling ──────────────────────────────────────────────────────

  describe('error handling', () => {
    it('throws on non-OK responses for fetchJson methods', async () => {
      mockFetch(async () => new Response('Server Error', { status: 503 }));
      await expect(client.getDashboard()).rejects.toThrow(/503/);
    });
  });
});
