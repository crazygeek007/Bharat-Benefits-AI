/**
 * Property-based tests for trust score bounds and citizen visibility.
 *
 * **Property 2: Trust Score Bounds and Visibility**
 * **Validates: Requirements 1.6, 1.7**
 *
 * Property statement (from design.md):
 * "For any scheme processed by the Crawler_System, the assigned Trust_Score
 * SHALL be an integer in the range [0, 100], and the scheme SHALL be visible
 * to citizens if and only if its Trust_Score is greater than or equal to 60."
 *
 * The suite is organised around five sub-properties:
 *
 *   1. Bounds                    — `calculateTrustScore` always returns an
 *                                  integer in [0, 100], even for partial,
 *                                  malformed, or hostile inputs.
 *   2. Bidirectional visibility  — `isSchemeVisibleToCitizens(n)` agrees
 *                                  with `n >= 60` on every finite number.
 *   3. Composition               — Visibility on calculated scores equals
 *                                  the threshold predicate on the score.
 *   4. Boundary                  — Exact behaviour at 59 / 60.
 *   5. Non-finite handling       — NaN, ±Infinity, and non-numeric inputs
 *                                  are never visible.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { TRUST_SCORE_CONFIG } from '@bharat-benefits/shared';
import {
  calculateTrustScore,
  isSchemeVisibleToCitizens,
  type TrustScoreInput,
} from './source-validator';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * Source URL arbitrary covering the full input space the crawler is likely
 * to feed into `calculateTrustScore`:
 *   - real gov.in / nic.in subdomain URLs
 *   - additional configured portal URLs
 *   - non-official https URLs (example.com etc.)
 *   - http (non-https) variants
 *   - syntactically valid but unusual URLs
 *   - malformed strings, empty strings, non-string sentinels
 */
const arbSourceUrl: fc.Arbitrary<string | null | undefined> = fc.oneof(
  // Valid official URLs
  fc.constantFrom(
    'https://scholarships.gov.in',
    'https://pmkisan.gov.in/',
    'https://india.gov.in/scheme/x',
    'https://state.nic.in/',
    'https://mygov.in/',
    'http://scholarships.gov.in/insecure',
  ),
  // Non-official URLs
  fc.constantFrom(
    'https://example.com/',
    'https://example.org/path',
    'http://example.net',
    'https://evilgov.in/',
    'https://gov.in.attacker.com/',
  ),
  // Random http/https URLs
  fc.webUrl(),
  // Malformed / non-URL strings
  fc.constantFrom('', 'not-a-url', '://broken', 'gov.in', 'http://'),
  fc.string({ minLength: 0, maxLength: 32 }),
  // Non-string sentinels (cast to satisfy the type — the function is
  // deliberately defensive about runtime garbage).
  fc.constant(null),
  fc.constant(undefined),
);

/** Ministry / department name: realistic, empty, whitespace, missing. */
const arbMinistry: fc.Arbitrary<string | null | undefined> = fc.oneof(
  fc.constantFrom(
    'Ministry of Education',
    'Ministry of Agriculture and Farmers Welfare',
    'Department of Health & Family Welfare',
    'Ministry of Women and Child Development',
  ),
  fc.string({ minLength: 1, maxLength: 80 }),
  fc.constantFrom('', '   ', '\t\n'),
  fc.constant(null),
  fc.constant(undefined),
);

/**
 * `lastVerifiedAt` arbitrary: recent dates (within 30 days), old dates,
 * future dates, undefined / null, and malformed Date instances.
 */
const arbLastVerifiedAt: fc.Arbitrary<Date | null | undefined> = fc.oneof(
  // Recent: 0–29 days ago
  fc.integer({ min: 0, max: 29 }).map((d) => new Date(Date.now() - d * 24 * 60 * 60 * 1000)),
  // Old: 31–365 days ago
  fc.integer({ min: 31, max: 365 }).map((d) => new Date(Date.now() - d * 24 * 60 * 60 * 1000)),
  // Future
  fc.integer({ min: 1, max: 365 }).map((d) => new Date(Date.now() + d * 24 * 60 * 60 * 1000)),
  // Invalid Date
  fc.constant(new Date(NaN)),
  fc.constant(null),
  fc.constant(undefined),
);

/** Eligibility criteria arbitrary — empty, populated, missing. */
const arbCriteria: fc.Arbitrary<ReadonlyArray<unknown> | null | undefined> = fc.oneof(
  fc.constant([]),
  fc.array(fc.record({ field: fc.string(), value: fc.anything() }), { minLength: 1, maxLength: 5 }),
  fc.constant(null),
  fc.constant(undefined),
);

/** Benefits arbitrary — empty, populated, missing. */
const arbBenefits: fc.Arbitrary<ReadonlyArray<unknown> | null | undefined> = fc.oneof(
  fc.constant([]),
  fc.array(fc.record({ type: fc.string(), amount: fc.option(fc.integer()) }), {
    minLength: 1,
    maxLength: 5,
  }),
  fc.constant(null),
  fc.constant(undefined),
);

/** Free-text arbitrary used for `name` and `description`. */
const arbFreeText: fc.Arbitrary<string | null | undefined> = fc.oneof(
  fc.string({ minLength: 0, maxLength: 200 }),
  fc.constantFrom('', '   '),
  fc.constant(null),
  fc.constant(undefined),
);

/**
 * Composite TrustScoreInput arbitrary. `fc.record` with `withDeletedKeys`
 * exercises the "field omitted entirely" case in addition to explicit
 * null/undefined values, matching how real partial parses look.
 */
const arbTrustScoreInput: fc.Arbitrary<TrustScoreInput> = fc.record(
  {
    sourceUrl: arbSourceUrl,
    ministry: arbMinistry,
    lastVerifiedAt: arbLastVerifiedAt,
    name: arbFreeText,
    description: arbFreeText,
    eligibilityCriteria: arbCriteria,
    benefits: arbBenefits,
  },
  { withDeletedKeys: true },
) as fc.Arbitrary<TrustScoreInput>;

// ─── Property 2: Trust Score Bounds and Visibility ───────────────────────────

describe('Property 2: Trust Score Bounds and Visibility', () => {
  // ── 1. Bounds: calculateTrustScore ∈ ℤ ∩ [0, 100] ────────────────────────

  it('returns an integer in [0, 100] for any partial / malformed input', () => {
    fc.assert(
      fc.property(arbTrustScoreInput, (input) => {
        const score = calculateTrustScore(input);
        expect(Number.isInteger(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(TRUST_SCORE_CONFIG.range.min);
        expect(score).toBeLessThanOrEqual(TRUST_SCORE_CONFIG.range.max);
      }),
      { numRuns: 200 },
    );
  });

  it('returns an integer in [0, 100] for the empty input object', () => {
    const score = calculateTrustScore({});
    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  // ── 2. Bidirectional visibility (iff): isSchemeVisibleToCitizens(n) ⇔ n ≥ 60

  it('isSchemeVisibleToCitizens(n) === (n >= 60) for any integer in [-50, 200]', () => {
    fc.assert(
      fc.property(fc.integer({ min: -50, max: 200 }), (n) => {
        expect(isSchemeVisibleToCitizens(n)).toBe(n >= TRUST_SCORE_CONFIG.minimumForDisplay);
      }),
      { numRuns: 200 },
    );
  });

  it('isSchemeVisibleToCitizens(n) === (n >= 60) for any finite double', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, min: -1e6, max: 1e6 }),
        (n) => {
          expect(isSchemeVisibleToCitizens(n)).toBe(n >= TRUST_SCORE_CONFIG.minimumForDisplay);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ── 3. Composition: visibility on calculated scores ──────────────────────

  it('isSchemeVisibleToCitizens(calculateTrustScore(input)) === (calculateTrustScore(input) >= 60)', () => {
    fc.assert(
      fc.property(arbTrustScoreInput, (input) => {
        const score = calculateTrustScore(input);
        expect(isSchemeVisibleToCitizens(score)).toBe(
          score >= TRUST_SCORE_CONFIG.minimumForDisplay,
        );
      }),
      { numRuns: 200 },
    );
  });

  // ── 4. Boundary: behaviour at exactly 59 and 60 ──────────────────────────

  it('at exactly 60 the scheme is visible; at 59 it is not', () => {
    expect(isSchemeVisibleToCitizens(60)).toBe(true);
    expect(isSchemeVisibleToCitizens(59)).toBe(false);
    // And at the rest of the documented boundaries:
    expect(isSchemeVisibleToCitizens(0)).toBe(false);
    expect(isSchemeVisibleToCitizens(100)).toBe(true);
  });

  // ── 5. Non-finite & non-numeric handling ─────────────────────────────────

  it('returns false for NaN, +Infinity, -Infinity', () => {
    expect(isSchemeVisibleToCitizens(Number.NaN)).toBe(false);
    expect(isSchemeVisibleToCitizens(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSchemeVisibleToCitizens(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it('returns false for any non-numeric input', () => {
    const arbNonNumeric = fc.oneof<fc.Arbitrary<unknown>[]>(
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
      fc.boolean(),
      fc.array(fc.integer()),
      fc.object(),
    );
    fc.assert(
      fc.property(arbNonNumeric, (value) => {
        expect(isSchemeVisibleToCitizens(value as unknown as number)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
