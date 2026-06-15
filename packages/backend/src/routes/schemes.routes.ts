/**
 * HTTP routes for scheme browsing and discovery (Requirement 2).
 *
 * Exposes:
 *   - `GET /api/schemes` — the public scheme listing with filters and
 *     pagination (Requirements 2.1–2.4).
 *   - `GET /api/schemes/search` — keyword-driven search combining
 *     semantic vector retrieval with Elasticsearch full-text matching,
 *     paginated at 20 per page (Requirements 2.6, 2.7).
 *   - `GET /api/schemes/:id` — full scheme detail including the official
 *     description, eligibility criteria, benefits, application steps, the
 *     required-documents checklist, last verified timestamp, and the
 *     compatible / incompatible relationships used by the citizen-facing
 *     detail view (Req 2.5, 7.2).
 *   - `GET /api/schemes/:id/eligibility` — authenticated endpoint that
 *     returns the citizen's eligibility status for a single scheme (Req 4.1).
 *
 * The handlers accept optional `loadSchemes`, `loadSchemeDetail`,
 * `loadRelationships`, `computeEligibility`, `esSearcher`, and
 * `vectorSearcher` dependencies for tests so the routes can be exercised
 * without a live database / ES / Pinecone.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  DocumentRequirement,
  EligibilityResult,
  Scheme,
  SchemeCategory,
  SchemeRelationship,
} from '@bharat-benefits/shared';
import {
  applySchemeFilters,
  countActiveFilters,
  getGovernmentLevel,
  type GovernmentLevel,
  type SchemeFilters,
} from '../services/scheme-browser/scheme-filter';
import {
  SEARCH_MIN_QUERY_LENGTH,
  SEARCH_DEFAULT_PAGE_SIZE,
  SEARCH_MAX_PAGE_SIZE,
  SearchQueryTooShortError,
  searchSchemes,
  type ElasticsearchSearcher,
} from '../services/scheme-search/scheme-search';
import type { VectorSearcher } from '../services/scheme-search/vector-searcher';
import { compatibilityEngine } from '../services/compatibility';
import { eligibilityEngine } from '../services/eligibility';
import {
  ComparisonInputError,
  DuplicateSchemeError,
  TooFewSchemesError,
  TooManySchemesError,
  buildComparisonWithEligibility,
  parseComparisonIds,
  type SchemeComparisonWithEligibility,
} from '../services/comparison';
import { extractBearerToken, InvalidTokenError, verifyAuthToken } from '../lib/auth/jwt';

/** Default and maximum page size for browsing (Requirement 2.3 — 20/page). */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** The 12 official scheme categories (kept here to validate query input). */
const SCHEME_CATEGORIES: ReadonlySet<SchemeCategory> = new Set<SchemeCategory>([
  'Education',
  'Agriculture',
  'Healthcare',
  'Women',
  'Employment',
  'Skill Development',
  'Housing',
  'Startups',
  'MSME',
  'Pension',
  'Scholarships',
  'Financial Assistance',
]);

/** Function that returns all visible schemes for the browse experience. */
export type SchemeLoader = (filters?: SchemeFilters) => Promise<Scheme[]>;

/**
 * Detail row returned by the per-scheme loader.
 *
 * `documents` carries the official document checklist as published by the
 * source (Req 2.5). It is sourced from the `scheme_documents` table since
 * the column-level `Scheme` row does not include the linked rows. Required
 * and optional documents are intermixed here — the UI splits them when
 * rendering, mirroring the shape used by the Document Checklist Generator.
 */
export interface SchemeDetail extends Scheme {
  /**
   * Full document checklist as published by the official source. The list
   * mixes required and optional documents — callers can split on
   * `required` to drive the per-scheme checklist UI (Req 8.1, 8.2).
   */
  documents: DocumentRequirement[];
}

/** Loader for a single scheme's detail row. Returns `null` when not found. */
export type SchemeDetailLoader = (id: string) => Promise<SchemeDetail | null>;

/** Loader for a scheme's compatibility relationships. */
export type RelationshipLoader = (
  schemeId: string,
) => Promise<SchemeRelationship[]>;

/**
 * Per-citizen eligibility resolver. Implementations look up the user's
 * profile and run `EligibilityEngine.calculateEligibility` against the
 * given scheme. Returning `null` signals "no profile on file" so the route
 * can prompt the citizen to complete their profile before showing
 * eligibility (Req 4.1).
 */
export type EligibilityResolver = (
  userId: string,
  schemeId: string,
) => Promise<EligibilityResult | null>;

export interface SchemeListResponse {
  schemes: Array<Scheme & { governmentLevel: GovernmentLevel }>;
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  appliedFilters: SchemeFilters;
}

/**
 * Response shape for the scheme detail endpoint (Req 2.5, 7.2).
 *
 * The `relationships` field carries every scheme that this scheme can
 * combine with, cannot combine with, or has as a prerequisite. The UI
 * groups relationships by `type` to render compatible / incompatible /
 * prerequisite sections.
 */
export interface SchemeDetailResponse {
  scheme: SchemeDetail & { governmentLevel: GovernmentLevel };
  relationships: SchemeRelationship[];
}

export interface RegisterSchemesRoutesOptions {
  /** Override the scheme listing loader — useful for tests. */
  loadSchemes?: SchemeLoader;
  /** Override the per-scheme detail loader — useful for tests. */
  loadSchemeDetail?: SchemeDetailLoader;
  /** Override the relationship loader — useful for tests. */
  loadRelationships?: RelationshipLoader;
  /** Override the eligibility resolver — useful for tests. */
  computeEligibility?: EligibilityResolver;
  /** Optional Elasticsearch searcher injected into the search route. */
  esSearcher?: ElasticsearchSearcher | null;
  /** Optional vector searcher injected into the search route. */
  vectorSearcher?: VectorSearcher | null;
  /**
   * Override for resolving the user id from the comparison request. By
   * default the route inspects the `Authorization` header (forwarded by
   * the frontend) and decodes the JWT — tests substitute a stub.
   */
  resolveUserIdForComparison?: (
    request: FastifyRequest,
  ) => string | null;
}

// ─── Query parsing helpers ───────────────────────────────────────────────────

interface RawQuery {
  state?: unknown;
  incomeLevel?: unknown;
  income_level?: unknown;
  category?: unknown;
  age?: unknown;
  gender?: unknown;
  occupation?: unknown;
  benefitType?: unknown;
  benefit_type?: unknown;
  page?: unknown;
  pageSize?: unknown;
  page_size?: unknown;
  q?: unknown;
  query?: unknown;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
  const str = readString(value);
  if (str === undefined) return undefined;
  const n = Number(str);
  return Number.isFinite(n) ? n : undefined;
}

function readCategory(value: unknown): SchemeCategory | undefined {
  const str = readString(value);
  if (str === undefined) return undefined;
  return SCHEME_CATEGORIES.has(str as SchemeCategory)
    ? (str as SchemeCategory)
    : undefined;
}

function readBenefitType(value: unknown): 'monetary' | 'non-monetary' | undefined {
  const str = readString(value);
  if (str === 'monetary' || str === 'non-monetary') return str;
  return undefined;
}

export function parseFiltersFromQuery(query: unknown): SchemeFilters {
  const q = (query ?? {}) as RawQuery;
  const filters: SchemeFilters = {};

  const state = readString(q.state);
  if (state !== undefined) filters.state = state;

  const category = readCategory(q.category);
  if (category !== undefined) filters.category = category;

  const benefitType = readBenefitType(q.benefitType ?? q.benefit_type);
  if (benefitType !== undefined) filters.benefitType = benefitType;

  const incomeLevel = readNumber(q.incomeLevel ?? q.income_level);
  if (incomeLevel !== undefined) filters.incomeLevel = incomeLevel;

  const age = readNumber(q.age);
  if (age !== undefined) filters.age = age;

  const gender = readString(q.gender);
  if (gender !== undefined) filters.gender = gender;

  const occupation = readString(q.occupation);
  if (occupation !== undefined) filters.occupation = occupation;

  return filters;
}

export function parsePaginationFromQuery(query: unknown): {
  page: number;
  pageSize: number;
} {
  const q = (query ?? {}) as RawQuery;
  const rawPage = readNumber(q.page);
  const rawSize = readNumber(q.pageSize ?? q.page_size);

  const page = rawPage !== undefined && rawPage >= 1 ? Math.floor(rawPage) : 1;
  let pageSize =
    rawSize !== undefined && rawSize >= 1 ? Math.floor(rawSize) : DEFAULT_PAGE_SIZE;
  if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

  return { page, pageSize };
}

/**
 * Reads the search query string from `?q=` (or its `?query=` alias) and
 * returns it trimmed. Returns `undefined` when no usable query is
 * present so the caller can branch between browsing vs. searching.
 */
export function parseSearchQueryFromQuery(query: unknown): string | undefined {
  const q = (query ?? {}) as RawQuery;
  return readString(q.q ?? q.query);
}

// ─── Pagination + decoration ─────────────────────────────────────────────────

export function paginateAndDecorate(
  schemes: ReadonlyArray<Scheme>,
  page: number,
  pageSize: number,
  filters: SchemeFilters,
): SchemeListResponse {
  const totalCount = schemes.length;
  const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const slice = schemes.slice(start, end);
  const decorated = slice.map((scheme) => ({
    ...scheme,
    governmentLevel: getGovernmentLevel(scheme),
  }));
  return {
    schemes: decorated,
    page,
    pageSize,
    totalCount,
    totalPages,
    appliedFilters: filters,
  };
}

// ─── Default loader (Prisma-backed) ──────────────────────────────────────────

/**
 * Hard cap on the number of rows returned from Postgres in a single
 * scheme-list query. The browse experience does in-memory pagination
 * after eligibility-criterion filtering, so the loader needs to return
 * enough rows for the current page to be filled. The cap protects
 * against runaway memory use if someone removes all filters at scale.
 *
 * 5000 schemes at ~1KB each is ~5MB — comfortable for a Node process,
 * and in practice the simple-filter push-down (state/category/benefitType)
 * narrows the dataset well below that.
 */
const SCHEME_LOADER_MAX_ROWS = Number(process.env.SCHEME_LOADER_MAX_ROWS) || 5000;

/**
 * Default scheme loader. Lazily imports the Prisma client so test consumers
 * that supply their own loader do not pay the cost of opening a connection.
 *
 * Visibility filter: matches the Crawler System contract — only verified
 * schemes are surfaced to citizens (Requirement 1.7 / Requirement 22).
 *
 * Pushes the cheap, columnar filters (state, category, benefitType) into
 * Postgres `WHERE`. The remaining filters (age, income, gender, occupation)
 * are evaluated in-memory by `applySchemeFilters` because they involve
 * JSON-criterion matching against `eligibilityCriteria` that is awkward
 * to express in SQL. The DB still does most of the heavy lifting.
 */
async function defaultSchemeLoader(filters: SchemeFilters = {}): Promise<Scheme[]> {
  const { default: prisma } = await import('../lib/prisma');
  const where: Record<string, unknown> = { verified: true };
  if (filters.state) where.state = filters.state;
  if (filters.category) where.category = filters.category;
  if (filters.benefitType) where.benefitType = filters.benefitType;

  const rows = await prisma.scheme.findMany({
    where,
    orderBy: [{ updatedAt: 'desc' }],
    take: SCHEME_LOADER_MAX_ROWS,
  });

  if (rows.length === SCHEME_LOADER_MAX_ROWS) {
    console.warn(
      `defaultSchemeLoader: returned the cap of ${SCHEME_LOADER_MAX_ROWS} rows. ` +
        'Some matching schemes may be missing from the page. ' +
        'Tighten filters at the call site or raise SCHEME_LOADER_MAX_ROWS.',
    );
  }

  return rows.map((row) => mapPrismaSchemeRow(row));
}

/**
 * Default per-scheme detail loader. Loads the scheme row plus the linked
 * `scheme_documents` rows in a single round-trip, then maps both into the
 * citizen-facing types so handlers can render the official description,
 * eligibility criteria, application steps, and document checklist together
 * (Req 2.5).
 *
 * Returns `null` when the id does not match a verified scheme — unverified
 * schemes are hidden from citizens per Req 1.7.
 */
async function defaultSchemeDetailLoader(id: string): Promise<SchemeDetail | null> {
  const { default: prisma } = await import('../lib/prisma');
  const row = await prisma.scheme.findUnique({
    where: { id },
    include: { documents: true },
  });
  if (!row || row.verified !== true) return null;
  const scheme = mapPrismaSchemeRow(row as unknown as Record<string, unknown>);
  const documents = mapPrismaSchemeDocuments(
    (row as unknown as { documents?: unknown }).documents,
  );
  return { ...scheme, documents };
}

/** Default relationship loader — defers to the shared `compatibilityEngine`. */
async function defaultRelationshipLoader(
  schemeId: string,
): Promise<SchemeRelationship[]> {
  return compatibilityEngine.getRelationships(schemeId);
}

/**
 * Default eligibility resolver. Loads the citizen's profile and runs the
 * shared `eligibilityEngine` against the supplied scheme. Returns `null`
 * when the citizen has no profile yet so the UI can prompt them to fill in
 * their details before showing an eligibility verdict (Req 4.1).
 */
async function defaultEligibilityResolver(
  userId: string,
  schemeId: string,
): Promise<EligibilityResult | null> {
  const { default: prisma } = await import('../lib/prisma');
  const [profile, schemeRow] = await Promise.all([
    prisma.userProfile.findUnique({ where: { userId } }),
    prisma.scheme.findUnique({ where: { id: schemeId } }),
  ]);
  if (!profile || !schemeRow) return null;
  const scheme = mapPrismaSchemeRow(schemeRow as unknown as Record<string, unknown>);
  return eligibilityEngine.calculateEligibility(
    profile as unknown as Parameters<typeof eligibilityEngine.calculateEligibility>[0],
    scheme,
  );
}

function mapPrismaSchemeDocuments(raw: unknown): DocumentRequirement[] {
  if (!Array.isArray(raw)) return [];
  const out: DocumentRequirement[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== 'object') continue;
    out.push({
      documentName: String(entry.documentName ?? ''),
      description: typeof entry.description === 'string' ? entry.description : '',
      format: typeof entry.format === 'string' ? entry.format : '',
      required: entry.required === true,
    });
  }
  return out;
}

function mapPrismaSchemeRow(row: Record<string, unknown>): Scheme {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    ministry: String(row.ministry),
    state: (row.state as string | null) ?? null,
    category: row.category as SchemeCategory,
    sourceUrl: String(row.sourceUrl ?? ''),
    benefitType: (row.benefitType as 'monetary' | 'non-monetary') ?? 'monetary',
    benefitAmount:
      row.benefitAmount === null || row.benefitAmount === undefined
        ? null
        : Number(row.benefitAmount),
    deadline: row.deadline ? new Date(row.deadline as string) : null,
    applicationMode: (row.applicationMode as 'online' | 'offline' | 'hybrid') ?? 'online',
    applicationUrl: (row.applicationUrl as string | null) ?? null,
    eligibilityCriteria: Array.isArray(row.eligibilityCriteria)
      ? (row.eligibilityCriteria as Scheme['eligibilityCriteria'])
      : [],
    benefits: Array.isArray((row as { benefits?: unknown }).benefits)
      ? ((row as { benefits: Scheme['benefits'] }).benefits)
      : [],
    applicationSteps: Array.isArray(row.applicationSteps)
      ? (row.applicationSteps as Scheme['applicationSteps'])
      : null,
    requiredDocuments: Array.isArray((row as { requiredDocuments?: unknown }).requiredDocuments)
      ? ((row as { requiredDocuments: Scheme['requiredDocuments'] }).requiredDocuments)
      : null,
    trustScore: Number(row.trustScore ?? 0),
    verified: Boolean(row.verified),
    discoveredAt: new Date(row.discoveredAt as string),
    lastVerifiedAt: row.lastVerifiedAt
      ? new Date(row.lastVerifiedAt as string)
      : new Date(row.discoveredAt as string),
    updatedAt: new Date(row.updatedAt as string),
  };
}

/**
 * Default resolver that pulls the citizen's user id off an inbound
 * `Authorization: Bearer <token>` header. The comparison route uses the
 * id to look up eligibility (Req 24.6) without rejecting unauthenticated
 * traffic — comparisons are public information; eligibility is the only
 * personalised slice.
 *
 * Returns `null` when no token is present, when the token is malformed,
 * or when verification fails for any reason — eligibility simply collapses
 * to "Sign in to see eligibility" in those cases.
 */
function defaultResolveUserIdForComparison(
  request: FastifyRequest,
): string | null {
  const headerValue = request.headers.authorization;
  if (typeof headerValue !== 'string') return null;
  const token = extractBearerToken(headerValue);
  if (!token) return null;
  try {
    const claims = verifyAuthToken(token);
    return claims.sub ?? null;
  } catch (err) {
    if (err instanceof InvalidTokenError) return null;
    return null;
  }
}

// ─── Route registration ──────────────────────────────────────────────────────

export function registerSchemesRoutes(
  app: FastifyInstance,
  options: RegisterSchemesRoutesOptions = {},
): void {
  const loader: SchemeLoader = options.loadSchemes ?? defaultSchemeLoader;
  const detailLoader: SchemeDetailLoader =
    options.loadSchemeDetail ?? defaultSchemeDetailLoader;
  const relationshipLoader: RelationshipLoader =
    options.loadRelationships ?? defaultRelationshipLoader;
  const eligibilityResolver: EligibilityResolver =
    options.computeEligibility ?? defaultEligibilityResolver;
  const esSearcher = options.esSearcher ?? null;
  const vectorSearcher = options.vectorSearcher ?? null;
  const resolveUserIdForComparison: (
    request: FastifyRequest,
  ) => string | null =
    options.resolveUserIdForComparison ?? defaultResolveUserIdForComparison;

  app.get('/api/schemes', async (request: FastifyRequest, reply) => {
    const filters = parseFiltersFromQuery(request.query);
    const { page, pageSize } = parsePaginationFromQuery(request.query);

    let schemes: Scheme[];
    try {
      schemes = await loader(filters);
    } catch (err) {
      request.log.error({ err }, 'failed to load schemes');
      return reply
        .code(503)
        .send({ error: 'ServiceUnavailable', message: 'Unable to load schemes right now' });
    }

    const filtered = applySchemeFilters(schemes, filters);
    const response = paginateAndDecorate(filtered, page, pageSize, filters);
    return reply.code(200).send({
      ...response,
      activeFilterCount: countActiveFilters(filters),
    });
  });

  app.get('/api/schemes/search', async (request: FastifyRequest, reply) => {
    const rawQuery = parseSearchQueryFromQuery(request.query);
    const { page, pageSize } = parsePaginationFromQuery(request.query);

    if (rawQuery === undefined || rawQuery.length < SEARCH_MIN_QUERY_LENGTH) {
      return reply.code(400).send({
        error: 'BadRequest',
        message: `Search query must be at least ${SEARCH_MIN_QUERY_LENGTH} characters`,
        minimumLength: SEARCH_MIN_QUERY_LENGTH,
      });
    }

    try {
      const result = await searchSchemes(
        rawQuery,
        { page, pageSize },
        { loadSchemes: loader, esSearcher, vectorSearcher },
      );
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof SearchQueryTooShortError) {
        return reply.code(400).send({
          error: 'BadRequest',
          message: err.message,
          minimumLength: err.minimumLength,
        });
      }
      request.log.error({ err }, 'failed to execute scheme search');
      return reply
        .code(503)
        .send({ error: 'ServiceUnavailable', message: 'Unable to run search right now' });
    }
  });

  // ── Comparison ────────────────────────────────────────────────────────────
  //
  // Returns a side-by-side comparison of 2-3 schemes (Requirement 24).
  // Public — the comparison itself is built from public scheme data — but
  // the per-scheme eligibility cell is decorated only when the request
  // forwards a valid bearer token (Req 24.6). Registered before the
  // `/api/schemes/:id` parametric route so Fastify always matches the
  // static path here.
  app.get('/api/schemes/compare', async (request, reply) => {
    const rawIds =
      (request.query as { ids?: unknown; id?: unknown } | null | undefined)
        ?.ids ??
      (request.query as { ids?: unknown; id?: unknown } | null | undefined)
        ?.id;

    let ids: string[];
    try {
      ids = parseComparisonIds(rawIds);
    } catch (err) {
      if (err instanceof TooFewSchemesError) {
        return reply.code(400).send({
          error: 'BadRequest',
          code: 'TOO_FEW_SCHEMES',
          message: err.message,
          minimum: err.minimum,
        });
      }
      if (err instanceof TooManySchemesError) {
        return reply.code(400).send({
          error: 'BadRequest',
          code: 'TOO_MANY_SCHEMES',
          message: err.message,
          maximum: err.maximum,
        });
      }
      if (err instanceof DuplicateSchemeError) {
        return reply.code(400).send({
          error: 'BadRequest',
          code: 'DUPLICATE_SCHEME',
          message: err.message,
          schemeId: err.schemeId,
        });
      }
      if (err instanceof ComparisonInputError) {
        return reply
          .code(400)
          .send({ error: 'BadRequest', message: err.message });
      }
      throw err;
    }

    // Load every requested scheme in parallel using the per-scheme detail
    // loader so we get the document checklist alongside the core record
    // (Req 24.4). Missing ids surface as 404 — the citizen-facing UI can
    // recover by removing the offending scheme from their selection.
    let details: Array<SchemeDetail | null>;
    try {
      details = await Promise.all(ids.map((id) => detailLoader(id)));
    } catch (err) {
      request.log.error({ err, ids }, 'failed to load schemes for comparison');
      return reply.code(503).send({
        error: 'ServiceUnavailable',
        message: 'Unable to load schemes for comparison right now',
      });
    }

    const missing = ids.filter((_, idx) => details[idx] === null);
    if (missing.length > 0) {
      return reply.code(404).send({
        error: 'NotFound',
        message: `One or more schemes were not found: ${missing.join(', ')}`,
        missingIds: missing,
      });
    }

    const schemes: Scheme[] = details.map((d, idx) => {
      // documents live on the detail row but the comparison reads them via
      // `requiredDocuments` on the Scheme — splice the documents into that
      // field so the comparison logic stays scheme-only.
      const detail = d as SchemeDetail;
      const cloned: Scheme & { requiredDocuments: DocumentRequirement[] | null } = {
        ...detail,
        requiredDocuments:
          detail.requiredDocuments ??
          (Array.isArray(detail.documents) && detail.documents.length > 0
            ? detail.documents
            : null),
      };
      // `idx` is unused but kept to make ordering explicit — comparison
      // attribute order must match the request order.
      void idx;
      return cloned;
    });

    const userId = resolveUserIdForComparison(request);
    let payload: SchemeComparisonWithEligibility;
    try {
      payload = await buildComparisonWithEligibility(schemes, async (schemeId) => {
        if (!userId) return null;
        try {
          return await eligibilityResolver(userId, schemeId);
        } catch (err) {
          // Eligibility is decorative (Req 24.6) — degrade rather than
          // fail the whole comparison.
          request.log.warn(
            { err, schemeId, userId },
            'eligibility lookup failed during comparison',
          );
          return null;
        }
      });
    } catch (err) {
      request.log.error({ err }, 'failed to build comparison payload');
      return reply.code(503).send({
        error: 'ServiceUnavailable',
        message: 'Unable to build comparison right now',
      });
    }

    // Decorate each Scheme with `governmentLevel` for the UI badge — the
    // listing route does the same for consistency.
    const decoratedSchemes = payload.comparison.schemes.map((scheme) => ({
      ...scheme,
      governmentLevel: getGovernmentLevel(scheme),
    }));

    return reply.code(200).send({
      schemes: decoratedSchemes,
      attributes: payload.comparison.attributes,
      eligibility: payload.eligibility,
      requestedIds: ids,
    });
  });

  // ── Per-citizen eligibility ───────────────────────────────────────────────
  //
  // Authenticated endpoint that returns the citizen's eligibility status for
  // a single scheme (Req 4.1). When the user has no profile yet the handler
  // returns `{ eligibility: null }` so the UI can prompt the citizen to
  // complete their profile rather than show "Not Eligible".
  //
  // Registered before `/api/schemes/:id` so Fastify's static-vs-parametric
  // matcher consistently routes it to the more specific handler.
  app.get<{ Params: { id: string } }>(
    '/api/schemes/:id/eligibility',
    {
      preHandler:
        typeof (app as unknown as { authenticate?: unknown }).authenticate ===
        'function'
          ? (app as FastifyInstance & {
              authenticate: (
                ...args: unknown[]
              ) => unknown;
            }).authenticate
          : undefined,
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!id || typeof id !== 'string' || id.trim() === '') {
        return reply
          .code(400)
          .send({ error: 'BadRequest', message: 'scheme id is required' });
      }

      const userId = request.user?.sub;
      if (!userId) {
        return reply
          .code(401)
          .send({ error: 'Unauthorized', message: 'Authentication required' });
      }

      let result: EligibilityResult | null;
      try {
        result = await eligibilityResolver(userId, id);
      } catch (err) {
        request.log.error(
          { err, schemeId: id, userId },
          'failed to compute eligibility',
        );
        return reply.code(503).send({
          error: 'ServiceUnavailable',
          message: 'Unable to compute eligibility right now',
        });
      }

      return reply.code(200).send({ schemeId: id, eligibility: result });
    },
  );

  // ── Detail view ───────────────────────────────────────────────────────────
  //
  // Returns the full scheme record together with its compatibility
  // relationships so the citizen-facing detail page can render every field
  // listed in Req 2.5 plus the compatible / incompatible scheme list (Req
  // 7.2). Public — no auth — because schemes are public information and the
  // page is reachable from search engines and the unauthenticated browsing
  // surface.
  app.get<{ Params: { id: string } }>(
    '/api/schemes/:id',
    async (request, reply) => {
      const { id } = request.params;
      if (!id || typeof id !== 'string' || id.trim() === '') {
        return reply
          .code(400)
          .send({ error: 'BadRequest', message: 'scheme id is required' });
      }

      let detail: SchemeDetail | null;
      let relationships: SchemeRelationship[];
      try {
        // Run the two reads in parallel — they touch independent tables.
        [detail, relationships] = await Promise.all([
          detailLoader(id),
          relationshipLoader(id).catch((err) => {
            request.log.warn({ err, schemeId: id }, 'failed to load relationships');
            return [] as SchemeRelationship[];
          }),
        ]);
      } catch (err) {
        request.log.error({ err, schemeId: id }, 'failed to load scheme detail');
        return reply.code(503).send({
          error: 'ServiceUnavailable',
          message: 'Unable to load scheme right now',
        });
      }

      if (!detail) {
        return reply
          .code(404)
          .send({ error: 'NotFound', message: `Scheme not found: ${id}` });
      }

      const response: SchemeDetailResponse = {
        scheme: { ...detail, governmentLevel: getGovernmentLevel(detail) },
        relationships,
      };
      return reply.code(200).send(response);
    },
  );
}

export { SEARCH_DEFAULT_PAGE_SIZE, SEARCH_MAX_PAGE_SIZE };
