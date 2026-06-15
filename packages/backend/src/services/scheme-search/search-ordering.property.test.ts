/**
 * Property-based tests for Scheme Search result ordering.
 *
 * **Property 5: Search Result Ordering**
 * **Validates: Requirements 2.6**
 *
 * Property statement (from design.md):
 * "For any search query of at least 2 characters and any scheme dataset,
 *  the returned result list SHALL be sorted in non-ascending order by
 *  match relevance score against scheme name, category, and description."
 *
 * The pure ranking helpers `rankSchemesByQuery` and `scoreSchemeAgainstQuery`
 * (in `scheme-search.ts`) are the canonical, in-memory reference for this
 * property — they back the search-orchestrator's offline fallback and apply
 * the field-weighted ordering that Requirement 2.6 mandates over scheme
 * `name`, `category`, and `description`. The same scoring rules are mirrored
 * in the live Elasticsearch `multi_match` field boosts, so verifying the
 * pure helpers also pins down the contract every retrieval path must
 * uphold.
 *
 * The tests below exercise the ordering and supporting invariants over
 * arbitrary scheme corpora and arbitrary 2+ character queries.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Scheme, SchemeCategory } from '@bharat-benefits/shared';
import {
  SEARCH_MIN_QUERY_LENGTH,
  rankSchemesByQuery,
  scoreSchemeAgainstQuery,
} from './scheme-search';

const NUM_RUNS = 200;

// ─── Scheme construction helper ─────────────────────────────────────────────

let counter = 0;

/**
 * Builds a fully-typed `Scheme` from a partial override. Only `name`,
 * `category`, and `description` participate in match scoring; the rest
 * of the fields are filled with stable, valid defaults so the helper
 * accepts any `Pick<Scheme, 'name' | 'category' | 'description'>`-shaped
 * input from a fast-check generator.
 */
function makeScheme(overrides: Partial<Scheme>): Scheme {
  counter += 1;
  return {
    id: `scheme-${counter}`,
    name: 'Generic Scheme',
    description: '',
    ministry: 'Ministry of Test',
    state: null,
    category: 'Education',
    sourceUrl: 'https://example.gov.in/scheme',
    benefitType: 'monetary',
    benefitAmount: 0,
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
    lastVerifiedAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const SCHEME_CATEGORIES: readonly SchemeCategory[] = [
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
] as const;

const arbCategory: fc.Arbitrary<SchemeCategory> =
  fc.constantFrom(...SCHEME_CATEGORIES);

/**
 * Lower-case alphabetic word, length 2..8. The bounded alphabet keeps
 * vocabulary small enough that scheme content and queries collide
 * frequently — without that, almost every generated case would yield
 * an empty result and fail to exercise the ordering property.
 */
const arbWord: fc.Arbitrary<string> = fc.stringMatching(/^[a-z]{2,8}$/);

/** A short text field built from 0..6 words separated by single spaces. */
const arbText: fc.Arbitrary<string> = fc
  .array(arbWord, { minLength: 0, maxLength: 6 })
  .map((words) => words.join(' '));

/** A non-empty name field built from 1..4 words. */
const arbName: fc.Arbitrary<string> = fc
  .array(arbWord, { minLength: 1, maxLength: 4 })
  .map((words) => words.join(' '));

/**
 * Arbitrary scheme: only the fields used by the ranker vary; everything
 * else is filled by `makeScheme` with stable defaults.
 */
const arbScheme: fc.Arbitrary<Scheme> = fc
  .record({
    id: fc
      .string({ minLength: 1, maxLength: 16 })
      .map((s) => `scheme-${s.replace(/\s+/g, '_')}`),
    name: arbName,
    category: arbCategory,
    description: arbText,
  })
  .map((parts) => makeScheme(parts));

/**
 * Corpus of 0..30 schemes with unique ids. The lower bound is 0 so the
 * empty-corpus case is also exercised (the ranker should return `[]`).
 */
const arbSchemeList: fc.Arbitrary<Scheme[]> = fc.uniqueArray(arbScheme, {
  selector: (s) => s.id,
  minLength: 0,
  maxLength: 30,
});

/**
 * Search query with at least {@link SEARCH_MIN_QUERY_LENGTH} characters
 * (Requirement 2.6 / Property 5 precondition). Built from the same
 * alphabet as scheme content to maximise the chance of producing
 * non-empty result lists.
 */
const arbQuery: fc.Arbitrary<string> = fc
  .array(arbWord, { minLength: 1, maxLength: 4 })
  .map((words) => words.join(' '))
  .filter((q) => q.trim().length >= SEARCH_MIN_QUERY_LENGTH);

// ─── Property tests ──────────────────────────────────────────────────────────

describe('Property 5: Search Result Ordering', () => {
  // Core property: results are non-ascending by match relevance score.
  it('returns results in non-ascending score order (Req 2.6)', () => {
    fc.assert(
      fc.property(arbSchemeList, arbQuery, (schemes, query) => {
        const ranked = rankSchemesByQuery(schemes, query);
        for (let i = 0; i + 1 < ranked.length; i++) {
          expect(ranked[i].score).toBeGreaterThanOrEqual(ranked[i + 1].score);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Score consistency: the score attached to each ranked entry is exactly
  // the score the pure helper computes from (name, category, description).
  // This pins the "match relevance score against scheme name, category,
  // and description" half of Property 5.
  it("each entry's score equals scoreSchemeAgainstQuery on the same fields (Req 2.6)", () => {
    fc.assert(
      fc.property(arbSchemeList, arbQuery, (schemes, query) => {
        const ranked = rankSchemesByQuery(schemes, query);
        for (const r of ranked) {
          const expected = scoreSchemeAgainstQuery(
            { name: r.name, category: r.category, description: r.description },
            query,
          );
          expect(r.score).toBe(expected);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Only matching schemes appear in the ranked output. A score of 0 means
  // the query did not match any of the searched fields, so such schemes
  // would be ordering-noise and are explicitly omitted.
  it('only includes schemes whose match score is strictly positive', () => {
    fc.assert(
      fc.property(arbSchemeList, arbQuery, (schemes, query) => {
        const ranked = rankSchemesByQuery(schemes, query);
        for (const r of ranked) {
          expect(r.score).toBeGreaterThan(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // The score sequence is determined by the corpus + query, not by the
  // order schemes appear in the input. This is what callers rely on when
  // the in-memory ranker handles a partial outage of ES/vector retrievers.
  it('score sequence is invariant under input permutation', () => {
    fc.assert(
      fc.property(arbSchemeList, arbQuery, (schemes, query) => {
        const direct = rankSchemesByQuery(schemes, query).map((r) => r.score);
        const reversed = rankSchemesByQuery([...schemes].reverse(), query).map(
          (r) => r.score,
        );
        expect(direct).toEqual(reversed);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
