/**
 * Unit tests for the frontend API client helpers used by the scheme detail
 * page (Req 2.5, 4.1, 7.2).
 *
 * Stubs `globalThis.fetch` so the tests are hermetic — no network calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSchemeDetail, fetchSchemeEligibility } from './api';

const originalFetch = globalThis.fetch;

function mockFetch(impl: typeof fetch): void {
  globalThis.fetch = impl as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('fetchSchemeDetail', () => {
  it('returns the parsed body when the backend responds 200', async () => {
    const payload = {
      scheme: {
        id: 'abc',
        name: 'Test Scheme',
        governmentLevel: 'Central',
        description: 'plain text',
        documents: [],
      },
      relationships: [],
    };
    mockFetch(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await fetchSchemeDetail('abc');
    expect(result).toEqual(payload);
  });

  it('returns null when the backend responds 404', async () => {
    mockFetch(async () => new Response('not found', { status: 404 }));
    const result = await fetchSchemeDetail('missing');
    expect(result).toBeNull();
  });

  it('throws when the backend responds with an unexpected error', async () => {
    mockFetch(async () => new Response('boom', { status: 503 }));
    await expect(fetchSchemeDetail('any')).rejects.toThrow(/503/);
  });

  it('encodes the id segment so unusual ids do not break the URL', async () => {
    let capturedUrl: string | null = null;
    mockFetch(async (url) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return new Response(
        JSON.stringify({ scheme: { id: 'x', documents: [] }, relationships: [] }),
        { status: 200 },
      );
    });
    await fetchSchemeDetail('id with spaces');
    expect(capturedUrl).toContain('id%20with%20spaces');
  });
});

describe('fetchSchemeEligibility', () => {
  it('returns null when the backend responds 401', async () => {
    mockFetch(async () => new Response('unauth', { status: 401 }));
    const result = await fetchSchemeEligibility('abc', null);
    expect(result).toBeNull();
  });

  it('forwards the supplied auth header verbatim', async () => {
    let captured: HeadersInit | undefined;
    mockFetch(async (_url, init) => {
      captured = init?.headers;
      return new Response(
        JSON.stringify({ schemeId: 'abc', eligibility: null }),
        { status: 200 },
      );
    });

    await fetchSchemeEligibility('abc', 'Bearer token-123');
    const asRecord = captured as Record<string, string> | undefined;
    expect(asRecord?.Authorization).toBe('Bearer token-123');
  });

  it('parses the eligibility payload on success', async () => {
    const payload = {
      schemeId: 'abc',
      eligibility: {
        status: 'Eligible',
        metCriteria: [],
        unmetCriteria: [],
        unevaluatedCriteria: [],
        missingProfileFields: [],
      },
    };
    mockFetch(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await fetchSchemeEligibility('abc', 'Bearer x');
    expect(result).toEqual(payload);
  });
});

// ─── Comparison (Req 24) ─────────────────────────────────────────────────────

import { fetchSchemeComparison } from './api';

describe('fetchSchemeComparison', () => {
  it('serialises ids as a comma-separated query parameter', async () => {
    let capturedUrl: string | null = null;
    mockFetch(async (url) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return new Response(
        JSON.stringify({
          schemes: [],
          attributes: [],
          eligibility: [],
          requestedIds: ['a', 'b'],
        }),
        { status: 200 },
      );
    });
    await fetchSchemeComparison(['a', 'b']);
    expect(capturedUrl).toContain('ids=a%2Cb');
  });

  it('forwards the auth header when supplied', async () => {
    let captured: HeadersInit | undefined;
    mockFetch(async (_url, init) => {
      captured = init?.headers;
      return new Response(
        JSON.stringify({
          schemes: [],
          attributes: [],
          eligibility: [],
          requestedIds: ['a', 'b'],
        }),
        { status: 200 },
      );
    });
    await fetchSchemeComparison(['a', 'b'], 'Bearer my-token');
    const asRecord = captured as Record<string, string> | undefined;
    expect(asRecord?.Authorization).toBe('Bearer my-token');
  });

  it('returns the parsed body wrapped in { ok: true } on success', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          schemes: [{ id: 'a' }],
          attributes: [],
          eligibility: [],
          requestedIds: ['a'],
        }),
        { status: 200 },
      ),
    );
    const result = await fetchSchemeComparison(['a', 'b']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.requestedIds).toEqual(['a']);
  });

  it('returns the parsed error body wrapped in { ok: false } on failure', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          error: 'BadRequest',
          code: 'TOO_MANY_SCHEMES',
          message: 'too many',
          maximum: 3,
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    const result = await fetchSchemeComparison(['a', 'b', 'c', 'd']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error.code).toBe('TOO_MANY_SCHEMES');
      expect(result.error.maximum).toBe(3);
    }
  });
});
