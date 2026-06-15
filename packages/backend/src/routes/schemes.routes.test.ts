/**
 * Integration tests for the scheme browsing route.
 *
 * Validates: Requirements 2.2, 2.3, 2.4, 2.6, 2.7.
 *
 * Builds a minimal Fastify instance, registers the schemes routes with an
 * injected in-memory scheme loader, and exercises:
 *   - Filter parsing from the query string,
 *   - AND-combined filtering (Requirement 2.3),
 *   - Pagination defaults of 20/page (Requirement 2.3, 2.6),
 *   - Central/State `governmentLevel` decoration (Requirement 2.4),
 *   - Search query parsing and minimum length enforcement (Req 2.6),
 *   - Zero-results behaviour (Requirement 2.7).
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { Scheme } from '@bharat-benefits/shared';
import {
  registerSchemesRoutes,
  parseFiltersFromQuery,
  parsePaginationFromQuery,
  parseSearchQueryFromQuery,
  paginateAndDecorate,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from './schemes.routes';
import type { ElasticsearchSearcher } from '../services/scheme-search/scheme-search';
import type { VectorSearcher } from '../services/scheme-search/vector-searcher';

let counter = 0;
function makeScheme(overrides: Partial<Scheme> = {}): Scheme {
  counter += 1;
  return {
    id: `scheme-${counter}`,
    name: `Scheme ${counter}`,
    description: 'Description',
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

function buildTestApp(
  schemes: Scheme[],
  options: {
    esSearcher?: ElasticsearchSearcher | null;
    vectorSearcher?: VectorSearcher | null;
  } = {},
) {
  const app = Fastify({ logger: false });
  registerSchemesRoutes(app, {
    loadSchemes: async () => schemes,
    esSearcher: options.esSearcher,
    vectorSearcher: options.vectorSearcher,
  });
  return app;
}

// ─── parseFiltersFromQuery ───────────────────────────────────────────────────

describe('parseFiltersFromQuery', () => {
  it('returns an empty filter object for an empty query', () => {
    expect(parseFiltersFromQuery({})).toEqual({});
  });

  it('reads and trims string filters', () => {
    expect(
      parseFiltersFromQuery({
        state: '  Karnataka  ',
        gender: 'Female',
        occupation: 'Farmer',
      }),
    ).toEqual({ state: 'Karnataka', gender: 'Female', occupation: 'Farmer' });
  });

  it('parses numeric filters and ignores invalid numbers', () => {
    expect(parseFiltersFromQuery({ age: '25', incomeLevel: '200000' })).toEqual({
      age: 25,
      incomeLevel: 200_000,
    });
    expect(parseFiltersFromQuery({ age: 'not-a-number' })).toEqual({});
  });

  it('rejects unknown categories and benefit types', () => {
    expect(parseFiltersFromQuery({ category: 'NotARealCategory' })).toEqual({});
    expect(parseFiltersFromQuery({ benefitType: 'cash' })).toEqual({});
  });

  it('accepts snake_case aliases for income_level and benefit_type', () => {
    expect(
      parseFiltersFromQuery({ income_level: '300000', benefit_type: 'non-monetary' }),
    ).toEqual({ incomeLevel: 300_000, benefitType: 'non-monetary' });
  });
});

// ─── parsePaginationFromQuery ────────────────────────────────────────────────

describe('parsePaginationFromQuery', () => {
  it('falls back to page=1, pageSize=20 when nothing is supplied', () => {
    expect(parsePaginationFromQuery({})).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it('parses valid page/pageSize values', () => {
    expect(parsePaginationFromQuery({ page: '3', pageSize: '10' })).toEqual({
      page: 3,
      pageSize: 10,
    });
  });

  it('clamps oversized pageSize requests to MAX_PAGE_SIZE', () => {
    expect(parsePaginationFromQuery({ pageSize: '5000' })).toEqual({
      page: 1,
      pageSize: MAX_PAGE_SIZE,
    });
  });

  it('coerces invalid or non-positive values to defaults', () => {
    expect(parsePaginationFromQuery({ page: '0', pageSize: '-5' })).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });
});

// ─── paginateAndDecorate ─────────────────────────────────────────────────────

describe('paginateAndDecorate', () => {
  it('decorates each scheme with its derived governmentLevel', () => {
    const schemes = [makeScheme({ state: null }), makeScheme({ state: 'Karnataka' })];
    const result = paginateAndDecorate(schemes, 1, 20, {});
    expect(result.schemes[0].governmentLevel).toBe('Central');
    expect(result.schemes[1].governmentLevel).toBe('State');
  });

  it('paginates correctly across multiple pages', () => {
    const schemes = Array.from({ length: 45 }, () => makeScheme());
    const page1 = paginateAndDecorate(schemes, 1, 20, {});
    const page3 = paginateAndDecorate(schemes, 3, 20, {});
    expect(page1.schemes).toHaveLength(20);
    expect(page1.totalCount).toBe(45);
    expect(page1.totalPages).toBe(3);
    expect(page3.schemes).toHaveLength(5);
  });

  it('reports zero pages when there are zero results', () => {
    const result = paginateAndDecorate([], 1, 20, {});
    expect(result).toEqual({
      schemes: [],
      page: 1,
      pageSize: 20,
      totalCount: 0,
      totalPages: 0,
      appliedFilters: {},
    });
  });
});

// ─── GET /api/schemes — end-to-end ───────────────────────────────────────────

describe('GET /api/schemes', () => {
  const app = buildTestApp([
    makeScheme({ category: 'Education', state: 'Karnataka' }),
    makeScheme({ category: 'Agriculture', state: null }),
    makeScheme({ category: 'Healthcare', state: 'Tamil Nadu' }),
    makeScheme({ category: 'Education', state: null, benefitType: 'non-monetary' }),
  ]);

  afterAll(async () => {
    await app.close();
  });

  it('returns all schemes (paginated) when no filters are applied', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/schemes' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.totalCount).toBe(4);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    expect(body.totalPages).toBe(1);
    expect(body.schemes).toHaveLength(4);
  });

  it('decorates each returned scheme with governmentLevel', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/schemes' });
    const body = JSON.parse(response.body);
    for (const scheme of body.schemes) {
      expect(['Central', 'State']).toContain(scheme.governmentLevel);
    }
  });

  it('combines filters with AND logic (Requirement 2.3)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes?category=Education&benefitType=non-monetary',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.totalCount).toBe(1);
    expect(body.schemes[0].category).toBe('Education');
    expect(body.schemes[0].benefitType).toBe('non-monetary');
  });

  it('returns zero results with totalCount=0 when no schemes match (Requirement 2.7)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes?category=Pension&state=Maharashtra',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.totalCount).toBe(0);
    expect(body.totalPages).toBe(0);
    expect(body.schemes).toEqual([]);
  });
});

// ─── parseSearchQueryFromQuery ───────────────────────────────────────────────

describe('parseSearchQueryFromQuery', () => {
  it('reads ?q and trims surrounding whitespace', () => {
    expect(parseSearchQueryFromQuery({ q: '  education  ' })).toBe('education');
  });

  it('falls back to ?query when ?q is absent', () => {
    expect(parseSearchQueryFromQuery({ query: 'pension' })).toBe('pension');
  });

  it('returns undefined for empty / missing values', () => {
    expect(parseSearchQueryFromQuery({})).toBeUndefined();
    expect(parseSearchQueryFromQuery({ q: '   ' })).toBeUndefined();
  });
});

// ─── GET /api/schemes/search — end-to-end ────────────────────────────────────

describe('GET /api/schemes/search', () => {
  function makeFixture() {
    return [
      makeScheme({ name: 'PM Education Loan Scheme', category: 'Education' }),
      makeScheme({ name: 'Kisan Credit Card', category: 'Agriculture' }),
      makeScheme({ name: 'Ayushman Bharat', category: 'Healthcare' }),
      makeScheme({
        name: 'National Pension Scheme',
        category: 'Pension',
        description: 'Retirement savings programme',
      }),
    ];
  }

  it('returns 400 for queries shorter than 2 characters (Req 2.6)', async () => {
    const app = buildTestApp(makeFixture());
    const response = await app.inject({ method: 'GET', url: '/api/schemes/search?q=e' });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('BadRequest');
    expect(body.minimumLength).toBe(2);
    await app.close();
  });

  it('returns 400 when no query is supplied', async () => {
    const app = buildTestApp(makeFixture());
    const response = await app.inject({ method: 'GET', url: '/api/schemes/search' });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('searches via the in-memory ranker when no retrievers are configured', async () => {
    const app = buildTestApp(makeFixture());
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/search?q=education',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.searchMode).toBe('in-memory');
    expect(body.query).toBe('education');
    expect(body.pageSize).toBe(20);
    expect(body.schemes[0].name).toContain('Education');
    await app.close();
  });

  it('returns zero results with totalCount=0 when nothing matches (Req 2.7)', async () => {
    const app = buildTestApp(makeFixture());
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/search?q=spaceflight',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.totalCount).toBe(0);
    expect(body.totalPages).toBe(0);
    expect(body.schemes).toEqual([]);
    await app.close();
  });

  it('combines ES and vector results when both retrievers are configured', async () => {
    const fixture = makeFixture();
    const esSearcher: ElasticsearchSearcher = {
      searchSchemeIndex: vi.fn(async () => [
        { schemeId: fixture[0].id, score: 5 },
      ]),
    };
    const vectorSearcher: VectorSearcher = {
      searchByQuery: vi.fn(async () => [
        { schemeId: fixture[3].id, score: 0.9 },
      ]),
    };
    const app = buildTestApp(fixture, { esSearcher, vectorSearcher });
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/search?q=savings',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.searchMode).toBe('hybrid');
    const ids = body.schemes.map((s: { id: string }) => s.id);
    expect(ids).toContain(fixture[0].id);
    expect(ids).toContain(fixture[3].id);
    await app.close();
  });

  it('paginates at 20 results per page', async () => {
    const many = Array.from({ length: 45 }, () =>
      makeScheme({ name: 'Education Plan' }),
    );
    const app = buildTestApp(many);
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/search?q=education',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.schemes).toHaveLength(20);
    expect(body.totalCount).toBe(45);
    expect(body.totalPages).toBe(3);
    await app.close();
  });
});

// ─── GET /api/schemes/:id — detail view ──────────────────────────────────────
//
// Validates Requirements 2.5 and 7.2 — the detail endpoint must surface every
// official field the citizen-facing detail page needs (name, description,
// eligibility criteria, benefits, application process, required documents,
// official source URL, last verified date) plus the compatibility list
// produced by the Compatibility Engine.

import type {
  DocumentRequirement,
  EligibilityResult,
  SchemeRelationship,
} from '@bharat-benefits/shared';
import type { SchemeDetail } from './schemes.routes';

function makeDetail(overrides: Partial<SchemeDetail> = {}): SchemeDetail {
  const base = makeScheme();
  return {
    ...base,
    documents: [],
    ...overrides,
  };
}

function buildDetailApp(args: {
  detail?: SchemeDetail | null;
  relationships?: SchemeRelationship[];
  detailLoader?: (id: string) => Promise<SchemeDetail | null>;
  relationshipLoader?: (id: string) => Promise<SchemeRelationship[]>;
  computeEligibility?: (
    userId: string,
    schemeId: string,
  ) => Promise<EligibilityResult | null>;
}) {
  const app = Fastify({ logger: false });
  registerSchemesRoutes(app, {
    loadSchemes: async () => [],
    loadSchemeDetail:
      args.detailLoader ?? (async () => args.detail ?? null),
    loadRelationships:
      args.relationshipLoader ?? (async () => args.relationships ?? []),
    computeEligibility: args.computeEligibility,
  });
  return app;
}

describe('GET /api/schemes/:id', () => {
  it('returns 404 when the scheme id does not match a row', async () => {
    const app = buildDetailApp({ detail: null });
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/missing-id',
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('NotFound');
    await app.close();
  });

  it('returns the full scheme record decorated with governmentLevel (Req 2.5)', async () => {
    const docs: DocumentRequirement[] = [
      {
        documentName: 'Aadhaar Card',
        description: 'National ID',
        format: 'PDF',
        required: true,
      },
      {
        documentName: 'Income Certificate',
        description: 'Latest year',
        format: 'PDF',
        required: false,
      },
    ];
    const detail = makeDetail({
      id: 'detail-1',
      name: 'Detail Scheme',
      description: 'Plain-language description',
      sourceUrl: 'https://example.gov.in/detail',
      lastVerifiedAt: new Date('2024-06-15T00:00:00Z'),
      eligibilityCriteria: [
        {
          field: 'age',
          operator: 'gte',
          value: 18,
          description: 'Applicant must be at least 18 years old.',
        },
      ],
      benefits: [
        { type: 'monetary', amount: 5000, description: 'One-time grant' },
      ],
      applicationSteps: [
        {
          stepNumber: 1,
          action: 'Visit the official portal',
          expectedOutcome: 'Account created',
        },
      ],
      documents: docs,
      state: 'Karnataka',
    });

    const app = buildDetailApp({
      detail,
      relationships: [],
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/detail-1',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.scheme.id).toBe('detail-1');
    expect(body.scheme.name).toBe('Detail Scheme');
    expect(body.scheme.description).toBe('Plain-language description');
    expect(body.scheme.sourceUrl).toBe('https://example.gov.in/detail');
    expect(body.scheme.lastVerifiedAt).toBe('2024-06-15T00:00:00.000Z');
    expect(body.scheme.governmentLevel).toBe('State');
    expect(body.scheme.eligibilityCriteria).toHaveLength(1);
    expect(body.scheme.benefits).toHaveLength(1);
    expect(body.scheme.applicationSteps).toHaveLength(1);
    expect(body.scheme.documents).toHaveLength(2);
    expect(body.scheme.documents[0].required).toBe(true);
    expect(body.scheme.documents[1].required).toBe(false);
    await app.close();
  });

  it('returns compatibility relationships alongside the scheme (Req 7.2)', async () => {
    const detail = makeDetail({ id: 'with-rels' });
    const relationships: SchemeRelationship[] = [
      {
        relatedSchemeId: 'other-1',
        relatedSchemeName: 'Other Scheme',
        type: 'cannot_combine_with',
        officialRule: 'Cannot avail both schemes simultaneously.',
        sourceUrl: 'https://example.gov.in/rule',
      },
      {
        relatedSchemeId: 'other-2',
        relatedSchemeName: 'Companion Scheme',
        type: 'can_combine_with',
        officialRule: 'Can be claimed alongside.',
        sourceUrl: 'https://example.gov.in/rule2',
      },
    ];

    const app = buildDetailApp({ detail, relationships });
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/with-rels',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.relationships).toHaveLength(2);
    expect(body.relationships.map((r: SchemeRelationship) => r.type)).toEqual([
      'cannot_combine_with',
      'can_combine_with',
    ]);
  });

  it('falls back to an empty relationship list when the loader rejects', async () => {
    const detail = makeDetail({ id: 'rels-fail' });
    const app = buildDetailApp({
      detail,
      relationshipLoader: async () => {
        throw new Error('compatibility engine offline');
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/rels-fail',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.scheme.id).toBe('rels-fail');
    expect(body.relationships).toEqual([]);
    await app.close();
  });

  it('returns 503 when the detail loader throws', async () => {
    const app = buildDetailApp({
      detailLoader: async () => {
        throw new Error('database unavailable');
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/anything',
    });
    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('ServiceUnavailable');
    await app.close();
  });
});

// ─── GET /api/schemes/:id/eligibility ────────────────────────────────────────
//
// Validates Requirement 4.1 — the citizen's eligibility status is computed
// against the scheme's official criteria and returned to the detail page.

describe('GET /api/schemes/:id/eligibility', () => {
  it('returns 401 when no user is authenticated', async () => {
    // No `app.authenticate` decorator is registered, so the route accepts the
    // request but the handler itself rejects when `request.user.sub` is absent.
    const app = buildDetailApp({});
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/some-id/eligibility',
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('returns the computed eligibility for the authenticated user', async () => {
    const eligibility: EligibilityResult = {
      status: 'Eligible',
      metCriteria: [
        {
          criterionName: 'age',
          requirement: 'Applicant must be at least 18 years old.',
          profileValue: 25,
          met: true,
        },
      ],
      unmetCriteria: [],
      unevaluatedCriteria: [],
      missingProfileFields: [],
    };

    // Build a Fastify app with a tiny preHandler that injects `request.user`
    // so the eligibility route can read `sub` without standing up the full
    // JWT plumbing.
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      (request as unknown as { user: { sub: string } }).user = {
        sub: 'user-1',
      };
    });
    registerSchemesRoutes(app, {
      loadSchemes: async () => [],
      computeEligibility: async (userId, schemeId) => {
        expect(userId).toBe('user-1');
        expect(schemeId).toBe('scheme-x');
        return eligibility;
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/scheme-x/eligibility',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.schemeId).toBe('scheme-x');
    expect(body.eligibility.status).toBe('Eligible');
    expect(body.eligibility.metCriteria).toHaveLength(1);
    await app.close();
  });

  it('returns null eligibility when the citizen has no profile yet', async () => {
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      (request as unknown as { user: { sub: string } }).user = {
        sub: 'user-2',
      };
    });
    registerSchemesRoutes(app, {
      loadSchemes: async () => [],
      computeEligibility: async () => null,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/scheme-y/eligibility',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.eligibility).toBeNull();
    await app.close();
  });

  it('returns 503 when the eligibility resolver throws', async () => {
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      (request as unknown as { user: { sub: string } }).user = {
        sub: 'user-3',
      };
    });
    registerSchemesRoutes(app, {
      loadSchemes: async () => [],
      computeEligibility: async () => {
        throw new Error('engine offline');
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/scheme-z/eligibility',
    });
    expect(response.statusCode).toBe(503);
    await app.close();
  });
});

// ─── GET /api/schemes/compare ────────────────────────────────────────────────
//
// Validates Requirement 24 — side-by-side comparison of 2-3 schemes,
// difference highlighting, missing-data handling, eligibility decoration,
// and the 3-scheme maximum.

describe('GET /api/schemes/compare', () => {
  function makeCompareApp(args: {
    details: SchemeDetail[];
    eligibility?: (
      userId: string,
      schemeId: string,
    ) => Promise<EligibilityResult | null>;
    userId?: string | null;
  }) {
    const byId = new Map(args.details.map((d) => [d.id, d]));
    const app = Fastify({ logger: false });
    registerSchemesRoutes(app, {
      loadSchemes: async () => [],
      loadSchemeDetail: async (id: string) => byId.get(id) ?? null,
      computeEligibility: args.eligibility,
      resolveUserIdForComparison: () => args.userId ?? null,
    });
    return app;
  }

  it('returns a 2-scheme comparison with one row per attribute (Req 24.1, 24.4)', async () => {
    const a = makeDetail({ id: 'a', name: 'Alpha' });
    const b = makeDetail({ id: 'b', name: 'Bravo' });
    const app = makeCompareApp({ details: [a, b] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/compare?ids=a,b',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.schemes.map((s: { id: string }) => s.id)).toEqual(['a', 'b']);
    expect(body.attributes).toHaveLength(5);
    expect(body.attributes.map((row: { attributeName: string }) => row.attributeName)).toEqual([
      'eligibilityCriteria',
      'benefits',
      'deadline',
      'requiredDocuments',
      'applicationProcess',
    ]);
    await app.close();
  });

  it('flags rows where values differ and leaves matching rows unflagged (Req 24.4)', async () => {
    const a = makeDetail({
      id: 'a',
      deadline: new Date('2025-05-01T00:00:00Z'),
      benefits: [{ type: 'monetary', amount: 5000, description: 'Cash' }],
    });
    const b = makeDetail({
      id: 'b',
      deadline: new Date('2025-06-15T00:00:00Z'),
      benefits: [{ type: 'monetary', amount: 5000, description: 'Cash' }],
    });
    const app = makeCompareApp({ details: [a, b] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/compare?ids=a,b',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    const deadlineRow = body.attributes.find(
      (r: { attributeName: string }) => r.attributeName === 'deadline',
    );
    const benefitsRow = body.attributes.find(
      (r: { attributeName: string }) => r.attributeName === 'benefits',
    );
    expect(deadlineRow.differs).toBe(true);
    expect(benefitsRow.differs).toBe(false);
    await app.close();
  });

  it('returns 400 with TOO_FEW_SCHEMES when fewer than 2 ids are supplied (Req 24.2)', async () => {
    const app = makeCompareApp({ details: [makeDetail({ id: 'a' })] });
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/compare?ids=a',
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('TOO_FEW_SCHEMES');
    expect(body.minimum).toBe(2);
    await app.close();
  });

  it('returns 400 with TOO_MANY_SCHEMES when more than 3 ids are supplied (Req 24.3)', async () => {
    const app = makeCompareApp({
      details: [
        makeDetail({ id: 'a' }),
        makeDetail({ id: 'b' }),
        makeDetail({ id: 'c' }),
        makeDetail({ id: 'd' }),
      ],
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/compare?ids=a,b,c,d',
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('TOO_MANY_SCHEMES');
    expect(body.maximum).toBe(3);
    expect(body.message).toMatch(/maximum/i);
    await app.close();
  });

  it('returns 400 with DUPLICATE_SCHEME when an id is repeated', async () => {
    const app = makeCompareApp({ details: [makeDetail({ id: 'a' })] });
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/compare?ids=a,a',
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('DUPLICATE_SCHEME');
    expect(body.schemeId).toBe('a');
    await app.close();
  });

  it('returns 404 when one of the requested ids is unknown', async () => {
    const app = makeCompareApp({ details: [makeDetail({ id: 'a' })] });
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/compare?ids=a,missing',
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('NotFound');
    expect(body.missingIds).toEqual(['missing']);
    await app.close();
  });

  it('decorates the comparison with eligibility for authenticated requests (Req 24.6)', async () => {
    const a = makeDetail({ id: 'a' });
    const b = makeDetail({ id: 'b' });
    const eligibility: EligibilityResult = {
      status: 'Eligible',
      metCriteria: [],
      unmetCriteria: [],
      unevaluatedCriteria: [],
      missingProfileFields: [],
    };
    const app = makeCompareApp({
      details: [a, b],
      userId: 'user-1',
      eligibility: async () => eligibility,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/compare?ids=a,b',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.eligibility).toHaveLength(2);
    expect(body.eligibility[0].eligibility.status).toBe('Eligible');
    expect(body.eligibility[1].eligibility.status).toBe('Eligible');
    await app.close();
  });

  it('returns null eligibility rows for unauthenticated requests', async () => {
    const a = makeDetail({ id: 'a' });
    const b = makeDetail({ id: 'b' });
    const app = makeCompareApp({ details: [a, b], userId: null });

    const response = await app.inject({
      method: 'GET',
      url: '/api/schemes/compare?ids=a,b',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.eligibility).toHaveLength(2);
    expect(body.eligibility.every((row: { eligibility: unknown }) => row.eligibility === null)).toBe(
      true,
    );
    await app.close();
  });
});
