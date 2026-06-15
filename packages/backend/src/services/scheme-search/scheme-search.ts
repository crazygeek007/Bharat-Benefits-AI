/**
 * Scheme Search — keyword-driven discovery for the public scheme catalogue
 * (Requirements 2.6, 2.7).
 *
 * The search experience layers three retrieval strategies:
 *
 *   1. Elasticsearch full-text search across `name`, `category`, and
 *      `description` with field-level weighting that mirrors Property 5
 *      ("non-ascending match relevance score against scheme name, category,
 *      and description").
 *
 *   2. Semantic vector search over scheme-content embeddings (Pinecone),
 *      enabling natural-language and synonym queries that pure full-text
 *      search would miss.
 *
 *   3. An in-memory fallback used when both upstream services are
 *      unreachable. The same `rankSchemesByQuery` function is also
 *      exported so it can power offline previews and act as the canonical
 *      reference for property-based tests of search result ordering
 *      (task 15.4 / Property 5).
 *
 * When both ES and vector hits are available, results are combined using
 * Reciprocal Rank Fusion (RRF), a stable, parameter-light hybrid ranking
 * scheme that does not require score normalisation between heterogeneous
 * scoring systems.
 *
 * The service is intentionally pure where possible: scoring helpers take a
 * Scheme + query and return a number with no I/O. Network access is gated
 * behind injectable dependencies (`esSearcher`, `vectorSearcher`,
 * `loadSchemes`) so unit tests can drive the module without standing up
 * real infrastructure.
 */

import type { Scheme } from '@bharat-benefits/shared';
import {
  getGovernmentLevel,
  type GovernmentLevel,
} from '../scheme-browser/scheme-filter';
import type { VectorSearcher } from './vector-searcher';

// ─── Public constants ────────────────────────────────────────────────────────

/** Minimum query length permitted by the search API (Requirement 2.6). */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/** Default and maximum page sizes for paginated results (Requirement 2.6). */
export const SEARCH_DEFAULT_PAGE_SIZE = 20;
export const SEARCH_MAX_PAGE_SIZE = 100;

/** Field weights applied during in-memory ranking. */
export const FIELD_WEIGHTS = {
  name: 3,
  category: 2,
  description: 1,
} as const;

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown when a caller submits a query shorter than the minimum permitted
 * length (Requirement 2.6 — at least 2 characters).
 */
export class SearchQueryTooShortError extends Error {
  public readonly minimumLength: number;

  constructor(minimumLength: number = SEARCH_MIN_QUERY_LENGTH) {
    super(`Search query must be at least ${minimumLength} characters`);
    this.name = 'SearchQueryTooShortError';
    this.minimumLength = minimumLength;
  }
}

// ─── Result shapes ───────────────────────────────────────────────────────────

/** Scheme with derived government level + match relevance score. */
export interface RankedScheme extends Scheme {
  governmentLevel: GovernmentLevel;
  score: number;
}

/** Paginated search response sent to the route handler. */
export interface SchemeSearchResponse {
  query: string;
  schemes: RankedScheme[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  /** Which retrieval path produced the results — useful for observability. */
  searchMode: SearchMode;
}

/** Discriminator describing which retrieval path produced the results. */
export type SearchMode = 'hybrid' | 'elasticsearch' | 'vector' | 'in-memory';

/**
 * Reciprocal Rank Fusion constant. The standard value (60) damps the
 * influence of low-ranked items so each retriever's top hits dominate.
 */
export const RRF_K = 60;

/** Raw hit returned by the Elasticsearch searcher. */
export interface ElasticsearchSearchHit {
  schemeId: string;
  score: number;
}

/** Searches the schemes index in Elasticsearch. */
export interface ElasticsearchSearcher {
  searchSchemeIndex(query: string, limit?: number): Promise<ElasticsearchSearchHit[]>;
}

/** Options accepted by {@link searchSchemes}. */
export interface SchemeSearchOptions {
  page?: number;
  pageSize?: number;
}

/** Dependencies required by {@link searchSchemes}. */
export interface SchemeSearchDeps {
  /**
   * Loads all schemes that should be searchable. Used to materialise full
   * `Scheme` objects from ES IDs and as the dataset for the in-memory
   * fallback. Implementations should already filter to verified/visible
   * schemes (Requirement 1.7).
   */
  loadSchemes: () => Promise<Scheme[]>;
  /**
   * Optional Elasticsearch searcher. When omitted (or set to `null`),
   * full-text retrieval is skipped. ES errors are caught and degrade
   * gracefully to the remaining retrievers.
   */
  esSearcher?: ElasticsearchSearcher | null;
  /**
   * Optional semantic vector searcher (Pinecone-backed). When omitted
   * (or set to `null`), semantic retrieval is skipped. Vector errors are
   * caught and degrade gracefully to the remaining retrievers.
   */
  vectorSearcher?: VectorSearcher | null;
}

// ─── Pure ranking helpers ────────────────────────────────────────────────────

/**
 * Tokenises a query into lowercase, non-empty whitespace-separated tokens.
 * Diacritic-insensitive matching is intentionally not implemented here —
 * scheme content is normalised by the upstream crawler.
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Counts case-insensitive, overlapping-free occurrences of `needle` in
 * `haystack`. Returns 0 for empty strings to avoid degenerate match counts.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  const hay = haystack.toLowerCase();
  const ndl = needle.toLowerCase();
  if (ndl.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (from <= hay.length - ndl.length) {
    const idx = hay.indexOf(ndl, from);
    if (idx === -1) break;
    count += 1;
    from = idx + ndl.length;
  }
  return count;
}

/**
 * Pure ranking helper: returns a non-negative match score for a single
 * scheme against a query. Higher is better.
 *
 * Scoring rules (mirrors Property 5 in design.md):
 *   - Tokens that appear in `name` contribute `FIELD_WEIGHTS.name` per match.
 *   - Tokens that appear in `category` contribute `FIELD_WEIGHTS.category`.
 *   - Tokens that appear in `description` contribute `FIELD_WEIGHTS.description`.
 *   - All matching is case-insensitive and counts each occurrence.
 *
 * Returns 0 when the query has no usable tokens, when the scheme is
 * missing the searched fields, or when no token matches. The function
 * is pure and depends only on its inputs.
 */
export function scoreSchemeAgainstQuery(
  scheme: Pick<Scheme, 'name' | 'category' | 'description'>,
  query: string,
): number {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return 0;

  const name = scheme.name ?? '';
  const category = scheme.category ?? '';
  const description = scheme.description ?? '';

  let score = 0;
  for (const token of tokens) {
    score += countOccurrences(name, token) * FIELD_WEIGHTS.name;
    score += countOccurrences(category, token) * FIELD_WEIGHTS.category;
    score += countOccurrences(description, token) * FIELD_WEIGHTS.description;
  }
  return score;
}

/**
 * Pure ranking helper: returns the schemes that match the query, sorted
 * by descending score. Schemes with a score of 0 are omitted from the
 * result so callers don't need to filter again.
 *
 * Tie-breaker: when two schemes share the same score, the original
 * relative order from the input array is preserved (stable sort).
 */
export function rankSchemesByQuery(
  schemes: ReadonlyArray<Scheme>,
  query: string,
): RankedScheme[] {
  if (schemes.length === 0) return [];
  if (query.trim().length < SEARCH_MIN_QUERY_LENGTH) return [];

  const scored: Array<{ scheme: Scheme; score: number; index: number }> = [];
  for (let i = 0; i < schemes.length; i++) {
    const scheme = schemes[i];
    const score = scoreSchemeAgainstQuery(scheme, query);
    if (score > 0) {
      scored.push({ scheme, score, index: i });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  return scored.map(({ scheme, score }) => ({
    ...scheme,
    score,
    governmentLevel: getGovernmentLevel(scheme),
  }));
}

// ─── Validation + pagination helpers ─────────────────────────────────────────

function normaliseQuery(raw: string): string {
  if (typeof raw !== 'string') {
    throw new SearchQueryTooShortError();
  }
  const trimmed = raw.trim();
  if (trimmed.length < SEARCH_MIN_QUERY_LENGTH) {
    throw new SearchQueryTooShortError();
  }
  return trimmed;
}

function normalisePagination(options: SchemeSearchOptions): {
  page: number;
  pageSize: number;
} {
  const rawPage = options.page;
  const rawSize = options.pageSize;

  const page =
    typeof rawPage === 'number' && Number.isFinite(rawPage) && rawPage >= 1
      ? Math.floor(rawPage)
      : 1;

  let pageSize =
    typeof rawSize === 'number' && Number.isFinite(rawSize) && rawSize >= 1
      ? Math.floor(rawSize)
      : SEARCH_DEFAULT_PAGE_SIZE;
  if (pageSize > SEARCH_MAX_PAGE_SIZE) pageSize = SEARCH_MAX_PAGE_SIZE;

  return { page, pageSize };
}

function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

// ─── Elasticsearch integration ───────────────────────────────────────────────

/**
 * Builds an {@link ElasticsearchSearcher} backed by the live Elasticsearch
 * client. Issues a `multi_match` query with field-level boosts that line
 * up with the in-memory weights, so the two retrieval paths produce
 * comparable orderings.
 *
 * The ES client surface is intentionally typed loosely so callers can
 * pass the official `@elastic/elasticsearch` `Client` (or any compatible
 * stub used in tests).
 */
export interface ElasticsearchLikeSearchClient {
  search(args: {
    index: string;
    size?: number;
    query: unknown;
  }): Promise<{
    hits?: {
      hits?: Array<{
        _id?: string;
        _score?: number | null;
        _source?: { schemeId?: string };
      }>;
    };
  }>;
}

export function createElasticsearchSearcher(
  client: ElasticsearchLikeSearchClient,
  schemesIndex: string,
): ElasticsearchSearcher {
  return {
    async searchSchemeIndex(query, limit = SEARCH_MAX_PAGE_SIZE) {
      const response = await client.search({
        index: schemesIndex,
        size: Math.max(1, Math.min(limit, SEARCH_MAX_PAGE_SIZE)),
        query: {
          multi_match: {
            query,
            // Field boosts mirror FIELD_WEIGHTS so ranking stays
            // semantically consistent with the in-memory fallback.
            fields: [
              `name^${FIELD_WEIGHTS.name}`,
              `category^${FIELD_WEIGHTS.category}`,
              `description^${FIELD_WEIGHTS.description}`,
            ],
            type: 'best_fields',
            operator: 'or',
          },
        },
      });

      const hits = response.hits?.hits ?? [];
      const out: ElasticsearchSearchHit[] = [];
      for (const hit of hits) {
        const schemeId = hit._source?.schemeId ?? hit._id;
        if (typeof schemeId !== 'string' || schemeId.length === 0) continue;
        const score = typeof hit._score === 'number' && Number.isFinite(hit._score)
          ? hit._score
          : 0;
        out.push({ schemeId, score });
      }
      return out;
    },
  };
}

// ─── Hybrid retrieval helpers ────────────────────────────────────────────────

/**
 * Combines ranked hit lists from multiple retrievers using Reciprocal
 * Rank Fusion (RRF). RRF requires no score normalisation — it operates
 * purely on rank positions — which is ideal here because Elasticsearch
 * BM25 scores and cosine-similarity vector scores are not directly
 * comparable.
 *
 * @param hitLists Ordered hit lists, each pre-sorted descending by score.
 * @param k        Damping constant (default {@link RRF_K}).
 * @returns Map from `schemeId` to fused RRF score, plus a record of the
 *          per-list ranks for downstream debugging.
 */
export function reciprocalRankFusion(
  hitLists: ReadonlyArray<ReadonlyArray<{ schemeId: string }>>,
  k: number = RRF_K,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of hitLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank].schemeId;
      if (!id) continue;
      const contribution = 1 / (k + rank + 1);
      fused.set(id, (fused.get(id) ?? 0) + contribution);
    }
  }
  return fused;
}

interface RetrievalOutcome {
  hits: Array<{ schemeId: string; score: number }> | null;
  failed: boolean;
}

async function runEsRetrieval(
  searcher: ElasticsearchSearcher | null | undefined,
  query: string,
): Promise<RetrievalOutcome> {
  if (!searcher) return { hits: null, failed: false };
  try {
    const hits = await searcher.searchSchemeIndex(query, SEARCH_MAX_PAGE_SIZE);
    const sorted = [...hits].sort((a, b) => b.score - a.score);
    return { hits: sorted, failed: false };
  } catch {
    return { hits: null, failed: true };
  }
}

async function runVectorRetrieval(
  searcher: VectorSearcher | null | undefined,
  query: string,
): Promise<RetrievalOutcome> {
  if (!searcher) return { hits: null, failed: false };
  try {
    const hits = await searcher.searchByQuery(query, SEARCH_MAX_PAGE_SIZE);
    const sorted = [...hits].sort((a, b) => b.score - a.score);
    return { hits: sorted, failed: false };
  } catch {
    return { hits: null, failed: true };
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Executes a paginated scheme search.
 *
 * Validates the query length (Requirement 2.6), then runs the configured
 * retrievers (Elasticsearch, vector) in parallel. When both return hits,
 * the lists are combined with Reciprocal Rank Fusion. When only one
 * retriever succeeds (or is configured), its results are used directly.
 * When both fail or are unavailable, the pure in-memory ranker is used
 * so the UI still receives results during partial outages.
 *
 * Returns a `SchemeSearchResponse` with `score`-decorated schemes, page
 * metadata, and a `searchMode` discriminator that downstream telemetry
 * can use to track fallback frequency.
 */
export async function searchSchemes(
  rawQuery: string,
  options: SchemeSearchOptions = {},
  deps: SchemeSearchDeps,
): Promise<SchemeSearchResponse> {
  const query = normaliseQuery(rawQuery);
  const { page, pageSize } = normalisePagination(options);

  // Materialise the candidate set up front. The dataset is bounded by the
  // visible scheme universe (already filtered by the loader) so this is
  // O(N) over schemes and acceptable at India-scheme scale.
  const allSchemes = await deps.loadSchemes();
  const schemesById = new Map<string, Scheme>();
  for (const scheme of allSchemes) {
    schemesById.set(scheme.id, scheme);
  }

  // Run ES and vector retrievers in parallel so the slower one does not
  // serialise the request (Requirement 2.6 — return within 2 seconds).
  const [esOutcome, vectorOutcome] = await Promise.all([
    runEsRetrieval(deps.esSearcher, query),
    runVectorRetrieval(deps.vectorSearcher, query),
  ]);

  const esHits = esOutcome.hits;
  const vectorHits = vectorOutcome.hits;

  // Determine which retrieval path drove the final ordering. Used purely
  // for observability; downstream consumers should not branch on it.
  let mode: SearchMode;
  let ranked: RankedScheme[];

  if (esHits && esHits.length > 0 && vectorHits && vectorHits.length > 0) {
    const fused = reciprocalRankFusion([esHits, vectorHits]);
    ranked = materialiseRanked(fused, schemesById);
    mode = 'hybrid';
  } else if (esHits && esHits.length > 0) {
    ranked = materialiseRanked(esHits, schemesById);
    mode = 'elasticsearch';
  } else if (vectorHits && vectorHits.length > 0) {
    ranked = materialiseRanked(vectorHits, schemesById);
    mode = 'vector';
  } else {
    // Neither retriever produced hits (or both failed / are absent). Fall
    // back to in-memory ranking so the citizen still gets a response.
    ranked = rankSchemesByQuery(allSchemes, query);
    mode = 'in-memory';
  }

  const totalCount = ranked.length;
  const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize);
  const pageSlice = paginate(ranked, page, pageSize);

  return {
    query,
    schemes: pageSlice,
    page,
    pageSize,
    totalCount,
    totalPages,
    searchMode: mode,
  };
}

/**
 * Materialises an ordered list of `(schemeId, score)` pairs (or a fused
 * RRF map) into `RankedScheme` objects. Pairs whose `schemeId` is no
 * longer present in the visible scheme set are skipped — this mirrors
 * how stale ES/vector entries are handled elsewhere.
 */
function materialiseRanked(
  source:
    | ReadonlyArray<{ schemeId: string; score: number }>
    | ReadonlyMap<string, number>,
  schemesById: ReadonlyMap<string, Scheme>,
): RankedScheme[] {
  const entries: Array<{ schemeId: string; score: number }> =
    source instanceof Map
      ? Array.from(source.entries())
          .map(([schemeId, score]) => ({ schemeId, score }))
          .sort((a, b) => b.score - a.score)
      : (source as ReadonlyArray<{ schemeId: string; score: number }>).slice();

  const out: RankedScheme[] = [];
  for (const entry of entries) {
    const scheme = schemesById.get(entry.schemeId);
    if (!scheme) continue;
    out.push({
      ...scheme,
      score: entry.score,
      governmentLevel: getGovernmentLevel(scheme),
    });
  }
  return out;
}
