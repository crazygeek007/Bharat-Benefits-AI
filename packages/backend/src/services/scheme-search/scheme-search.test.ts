/**
 * Unit tests for the scheme search service (Requirements 2.6, 2.7).
 *
 * Exercises:
 *   - Minimum query length enforcement (Req 2.6 — 2+ characters).
 *   - Pure ranking logic (`scoreSchemeAgainstQuery`, `rankSchemesByQuery`).
 *   - Hybrid retrieval orchestration: ES-only, vector-only, RRF fusion,
 *     and the in-memory fallback when both retrievers fail.
 *   - Pagination at 20 results per page (Req 2.6).
 *   - Zero-results behaviour for non-matching queries (Req 2.7).
 */

import { describe, it, expect, vi } from 'vitest';
import type { Scheme } from '@bharat-benefits/shared';
import {
  FIELD_WEIGHTS,
  RRF_K,
  SEARCH_DEFAULT_PAGE_SIZE,
  SEARCH_MIN_QUERY_LENGTH,
  SearchQueryTooShortError,
  rankSchemesByQuery,
  reciprocalRankFusion,
  scoreSchemeAgainstQuery,
  searchSchemes,
  tokenizeQuery,
  type ElasticsearchSearcher,
} from './scheme-search';
import type { VectorSearcher } from './vector-searcher';

let counter = 0;
function makeScheme(overrides: Partial<Scheme> = {}): Scheme {
  counter += 1;
  return {
    id: `scheme-${counter}`,
    name: `Scheme ${counter}`,
    description: 'Generic description',
    ministry: 'Ministry of Test',
    state: null,
    category: 'Education',
    sourceUrl: 'https://example.gov.in/scheme',
    benefitType: 'monetary',
    benefitAmount: 1000,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: null,
    eligibilityCriteria: [],
    benefits: [],
    applicationSteps: null,
    requiredDocuments: null,
    trustScore: 80,
    verified: true,
    discoveredAt: new Date('2024-01-01T00:00:00Z'),
    lastVerifiedAt: new Date('2024-01-02T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

// ─── tokenizeQuery / scoreSchemeAgainstQuery ────────────────────────────────

describe('tokenizeQuery', () => {
  it('lowercases and splits on whitespace', () => {
    expect(tokenizeQuery('  Education Loan  ')).toEqual(['education', 'loan']);
  });

  it('returns an empty array for empty input', () => {
    expect(tokenizeQuery('')).toEqual([]);
    expect(tokenizeQuery('   ')).toEqual([]);
  });
});

describe('scoreSchemeAgainstQuery', () => {
  const scheme: Pick<Scheme, 'name' | 'category' | 'description'> = {
    name: 'Pradhan Mantri Education Loan',
    category: 'Education',
    description: 'Provides education loans for underprivileged students.',
  };

  it('weights name > category > description', () => {
    const score = scoreSchemeAgainstQuery(scheme, 'education');
    // 1× name + 1× category + 1× description (all contain "education")
    expect(score).toBe(
      FIELD_WEIGHTS.name + FIELD_WEIGHTS.category + FIELD_WEIGHTS.description,
    );
  });

  it('returns 0 for non-matching queries', () => {
    expect(scoreSchemeAgainstQuery(scheme, 'agriculture')).toBe(0);
  });

  it('returns 0 for empty queries', () => {
    expect(scoreSchemeAgainstQuery(scheme, '')).toBe(0);
  });

  it('counts each occurrence of a token', () => {
    const repeated: Pick<Scheme, 'name' | 'category' | 'description'> = {
      name: 'Loan Loan',
      category: 'Education',
      description: '',
    };
    expect(scoreSchemeAgainstQuery(repeated, 'loan')).toBe(2 * FIELD_WEIGHTS.name);
  });
});

describe('rankSchemesByQuery', () => {
  it('sorts schemes by descending score', () => {
    const a = makeScheme({
      id: 'a',
      name: 'Education Loan',
      description: 'edu',
      category: 'Agriculture',
    });
    const b = makeScheme({
      id: 'b',
      name: 'Healthcare Subsidy',
      description: 'health education for all',
      category: 'Healthcare',
    });
    const c = makeScheme({
      id: 'c',
      name: 'Agriculture Pension',
      description: 'farm',
      category: 'Agriculture',
    });

    const ranked = rankSchemesByQuery([a, b, c], 'education');
    expect(ranked.map((r) => r.id)).toEqual(['a', 'b']);
    // 'a' contains education in name (3), 'b' only in description (1).
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('returns an empty array for queries below the minimum length', () => {
    const a = makeScheme({ name: 'edu' });
    expect(rankSchemesByQuery([a], 'e')).toEqual([]);
  });

  it('omits schemes with score 0', () => {
    const a = makeScheme({ name: 'Agriculture' });
    expect(rankSchemesByQuery([a], 'healthcare')).toEqual([]);
  });

  it('decorates results with governmentLevel', () => {
    const central = makeScheme({ name: 'Education', state: null });
    const state = makeScheme({ name: 'Education', state: 'Karnataka' });
    const ranked = rankSchemesByQuery([central, state], 'education');
    expect(ranked[0].governmentLevel).toBe('Central');
    expect(ranked[1].governmentLevel).toBe('State');
  });
});

// ─── reciprocalRankFusion ────────────────────────────────────────────────────

describe('reciprocalRankFusion', () => {
  it('rewards documents that rank highly in both lists', () => {
    const es = [{ schemeId: 'a' }, { schemeId: 'b' }, { schemeId: 'c' }];
    const vec = [{ schemeId: 'b' }, { schemeId: 'a' }, { schemeId: 'd' }];
    const fused = reciprocalRankFusion([es, vec]);
    // 'a' and 'b' appear in both lists; 'c' and 'd' only once.
    expect(fused.get('a')).toBeGreaterThan(fused.get('c') ?? 0);
    expect(fused.get('b')).toBeGreaterThan(fused.get('d') ?? 0);
  });

  it('uses 1/(k+rank+1) per occurrence', () => {
    const fused = reciprocalRankFusion([[{ schemeId: 'a' }]]);
    expect(fused.get('a')).toBeCloseTo(1 / (RRF_K + 1));
  });

  it('returns an empty map for empty input', () => {
    expect(reciprocalRankFusion([])).toEqual(new Map());
  });
});

// ─── searchSchemes — orchestration ───────────────────────────────────────────

function buildSchemes(): Scheme[] {
  return [
    makeScheme({ id: 's1', name: 'PM Education Loan Scheme', category: 'Education' }),
    makeScheme({
      id: 's2',
      name: 'Kisan Credit Card',
      category: 'Agriculture',
      description: 'Loans for farmers',
    }),
    makeScheme({
      id: 's3',
      name: 'Ayushman Bharat',
      category: 'Healthcare',
      description: 'Health coverage',
    }),
    makeScheme({
      id: 's4',
      name: 'National Pension Scheme',
      category: 'Pension',
      description: 'Retirement savings',
    }),
  ];
}

describe('searchSchemes', () => {
  it('rejects queries shorter than the minimum length', async () => {
    await expect(
      searchSchemes('e', {}, { loadSchemes: async () => buildSchemes() }),
    ).rejects.toBeInstanceOf(SearchQueryTooShortError);
  });

  it('uses the in-memory ranker when no retrievers are configured', async () => {
    const result = await searchSchemes(
      'education',
      {},
      { loadSchemes: async () => buildSchemes() },
    );
    expect(result.searchMode).toBe('in-memory');
    expect(result.schemes[0].id).toBe('s1');
    expect(result.totalCount).toBe(1);
  });

  it('uses Elasticsearch when only ES is configured and returns hits', async () => {
    const esSearcher: ElasticsearchSearcher = {
      searchSchemeIndex: vi.fn(async () => [
        { schemeId: 's3', score: 9 },
        { schemeId: 's1', score: 7 },
      ]),
    };
    const result = await searchSchemes(
      'health',
      {},
      { loadSchemes: async () => buildSchemes(), esSearcher },
    );
    expect(result.searchMode).toBe('elasticsearch');
    expect(result.schemes.map((s) => s.id)).toEqual(['s3', 's1']);
  });

  it('uses the vector searcher when only vector is configured', async () => {
    const vectorSearcher: VectorSearcher = {
      searchByQuery: vi.fn(async () => [
        { schemeId: 's4', score: 0.9 },
        { schemeId: 's2', score: 0.7 },
      ]),
    };
    const result = await searchSchemes(
      'retire',
      {},
      { loadSchemes: async () => buildSchemes(), vectorSearcher },
    );
    expect(result.searchMode).toBe('vector');
    expect(result.schemes.map((s) => s.id)).toEqual(['s4', 's2']);
  });

  it('combines ES and vector results with RRF when both are configured', async () => {
    const esSearcher: ElasticsearchSearcher = {
      searchSchemeIndex: vi.fn(async () => [
        { schemeId: 's1', score: 5 },
        { schemeId: 's3', score: 4 },
      ]),
    };
    const vectorSearcher: VectorSearcher = {
      searchByQuery: vi.fn(async () => [
        { schemeId: 's3', score: 0.9 },
        { schemeId: 's1', score: 0.5 },
      ]),
    };
    const result = await searchSchemes(
      'education',
      {},
      { loadSchemes: async () => buildSchemes(), esSearcher, vectorSearcher },
    );
    expect(result.searchMode).toBe('hybrid');
    // Both schemes appear in both lists; their fused scores should be
    // strictly positive and ranked deterministically.
    expect(new Set(result.schemes.map((s) => s.id))).toEqual(new Set(['s1', 's3']));
    expect(esSearcher.searchSchemeIndex).toHaveBeenCalledTimes(1);
    expect(vectorSearcher.searchByQuery).toHaveBeenCalledTimes(1);
  });

  it('falls back to in-memory when ES throws and vector is absent', async () => {
    const esSearcher: ElasticsearchSearcher = {
      searchSchemeIndex: vi.fn(async () => {
        throw new Error('cluster unavailable');
      }),
    };
    const result = await searchSchemes(
      'education',
      {},
      { loadSchemes: async () => buildSchemes(), esSearcher },
    );
    expect(result.searchMode).toBe('in-memory');
    expect(result.totalCount).toBeGreaterThan(0);
  });

  it('falls back to in-memory when both ES and vector throw', async () => {
    const esSearcher: ElasticsearchSearcher = {
      searchSchemeIndex: vi.fn(async () => {
        throw new Error('es boom');
      }),
    };
    const vectorSearcher: VectorSearcher = {
      searchByQuery: vi.fn(async () => {
        throw new Error('vector boom');
      }),
    };
    const result = await searchSchemes(
      'education',
      {},
      { loadSchemes: async () => buildSchemes(), esSearcher, vectorSearcher },
    );
    expect(result.searchMode).toBe('in-memory');
    expect(result.schemes[0].id).toBe('s1');
  });

  it('skips ES hits that no longer exist in the visible scheme set', async () => {
    const esSearcher: ElasticsearchSearcher = {
      searchSchemeIndex: vi.fn(async () => [
        { schemeId: 'unknown', score: 10 },
        { schemeId: 's1', score: 5 },
      ]),
    };
    const result = await searchSchemes(
      'education',
      {},
      { loadSchemes: async () => buildSchemes(), esSearcher },
    );
    expect(result.schemes.map((s) => s.id)).toEqual(['s1']);
  });

  it('paginates at the default 20 per page', async () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      makeScheme({ id: `m-${i}`, name: 'Education Plan' }),
    );
    const page1 = await searchSchemes(
      'education',
      {},
      { loadSchemes: async () => many },
    );
    expect(page1.schemes).toHaveLength(SEARCH_DEFAULT_PAGE_SIZE);
    expect(page1.pageSize).toBe(SEARCH_DEFAULT_PAGE_SIZE);
    expect(page1.totalCount).toBe(45);
    expect(page1.totalPages).toBe(3);

    const page3 = await searchSchemes(
      'education',
      { page: 3 },
      { loadSchemes: async () => many },
    );
    expect(page3.schemes).toHaveLength(45 - 2 * SEARCH_DEFAULT_PAGE_SIZE);
    expect(page3.page).toBe(3);
  });

  it('returns totalCount=0 for non-matching queries (Req 2.7)', async () => {
    const result = await searchSchemes(
      'spaceflight',
      {},
      { loadSchemes: async () => buildSchemes() },
    );
    expect(result.totalCount).toBe(0);
    expect(result.totalPages).toBe(0);
    expect(result.schemes).toEqual([]);
  });

  it('preserves the minimum query length constant', () => {
    expect(SEARCH_MIN_QUERY_LENGTH).toBe(2);
  });
});
