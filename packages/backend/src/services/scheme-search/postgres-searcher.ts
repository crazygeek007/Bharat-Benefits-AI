/**
 * Postgres FTS keyword searcher — replaces the Elasticsearch keyword retriever
 * in the hybrid `searchSchemes` pipeline.
 *
 * Implements the existing {@link ElasticsearchSearcher} interface (kept for
 * historical reasons — the interface is provider-agnostic and only describes
 * "thing that returns ranked hits by keyword") so callers (`schemes.routes.ts`,
 * the in-route hybrid retriever) don't need to know we swapped the backend.
 *
 * How it works
 * ------------
 * The 20260618000000_scheme_fts_tsvector migration adds a STORED generated
 * column `search_doc tsvector` on `schemes`, weighted A=name, B=category,
 * C=description (matching FIELD_WEIGHTS in scheme-search.ts so the hybrid
 * fusion stays consistent). A GIN index on `search_doc` keeps lookups fast.
 *
 * Each query is parsed with `websearch_to_tsquery` — that flavour accepts
 * the kind of input citizens type ("scholarship for OBC students"), handles
 * quoted phrases, OR, and the leading - operator, and never throws on
 * malformed syntax. Unlike `plainto_tsquery` it doesn't AND-combine every
 * token, which would over-filter very short queries.
 *
 * Visibility filter
 * -----------------
 * Only verified schemes with trust_score >= TRUST_SCORE_VISIBILITY_THRESHOLD
 * are returned, matching Req 1.7. Hidden schemes never reach citizens
 * regardless of how the search service merges results, but we apply the
 * filter at the SQL layer too so we don't waste rank slots on rows that
 * the downstream materialiser would drop anyway.
 */

import { TRUST_SCORE_CONFIG } from '@bharat-benefits/shared';
import type {
  ElasticsearchSearcher,
  ElasticsearchSearchHit,
} from './scheme-search';
import { SEARCH_MAX_PAGE_SIZE } from './scheme-search';

/** Subset of the Prisma client we need for raw SQL. Used for test injection. */
export interface PostgresFtsClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface CreatePostgresSearcherOptions {
  /**
   * Minimum trust score for a scheme to surface in keyword search. Defaults
   * to `TRUST_SCORE_CONFIG.minimumForDisplay` (60) from the shared constants
   * — matches Req 1.7. Override only for admin contexts that should see
   * everything.
   */
  minTrustScore?: number;
}

interface RawRow {
  scheme_id: string;
  score: number | string | null;
}

/**
 * Builds an {@link ElasticsearchSearcher} backed by Postgres FTS. The
 * returned object exposes a single `searchSchemeIndex(query, limit)` method
 * compatible with the rest of the search pipeline.
 */
export function createPostgresSearcher(
  prisma: PostgresFtsClient,
  options: CreatePostgresSearcherOptions = {},
): ElasticsearchSearcher {
  const minTrustScore = options.minTrustScore ?? TRUST_SCORE_CONFIG.minimumForDisplay;

  return {
    async searchSchemeIndex(
      query: string,
      limit: number = SEARCH_MAX_PAGE_SIZE,
    ): Promise<ElasticsearchSearchHit[]> {
      const safeLimit = clampLimit(limit);
      const trimmed = query.trim();
      if (trimmed.length === 0) return [];

      // `websearch_to_tsquery` is forgiving with user input — it never
      // raises a syntax error and degrades gracefully when the query is
      // garbled. `ts_rank_cd` weighs term proximity and field weights
      // (the A/B/C labels we set on the generated column).
      //
      // The query is parameterised — never interpolated — so user input
      // can't reach the SQL parser as code.
      const rows = await prisma.$queryRawUnsafe<RawRow[]>(
        `
          SELECT
            id::text AS scheme_id,
            ts_rank_cd(search_doc, websearch_to_tsquery('english', $1)) AS score
          FROM schemes
          WHERE
            search_doc @@ websearch_to_tsquery('english', $1)
            AND verified = TRUE
            AND trust_score >= $2
          ORDER BY score DESC, id ASC
          LIMIT $3
        `,
        trimmed,
        minTrustScore,
        safeLimit,
      );

      const out: ElasticsearchSearchHit[] = [];
      for (const row of rows ?? []) {
        if (typeof row.scheme_id !== 'string' || row.scheme_id.length === 0) {
          continue;
        }
        const score = coerceScore(row.score);
        // Drop rows that the FTS engine matched with a zero rank — they
        // technically satisfy the @@ predicate but contribute nothing to
        // the downstream RRF fusion.
        if (score <= 0) continue;
        out.push({ schemeId: row.scheme_id, score });
      }
      return out;
    },
  };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return SEARCH_MAX_PAGE_SIZE;
  if (limit > SEARCH_MAX_PAGE_SIZE) return SEARCH_MAX_PAGE_SIZE;
  return Math.floor(limit);
}

function coerceScore(raw: number | string | null | undefined): number {
  if (raw == null) return 0;
  // pg returns `real`/`double precision` as JS number, but prisma's
  // `$queryRawUnsafe` sometimes hands back strings for numeric columns on
  // certain drivers. Be lenient.
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}
