/**
 * Property-based tests for scheme metadata completeness on ingestion.
 *
 * **Property 3: Scheme Metadata Completeness on Ingestion**
 * **Validates: Requirements 1.3**
 *
 * Property statement (from design.md):
 *
 *   "For any successfully ingested scheme, the stored record SHALL
 *    contain non-null values for source URL, ministry/department name,
 *    date discovered, last verified date, and Trust_Score."
 *
 * "Successfully ingested" means the scheme has cleared
 * {@link enforceMandatoryFields}; at that point `sourceUrl` and
 * `ministry` are non-empty strings. The {@link buildIngestedRecord}
 * helper packages the SchemeObject together with the metadata required
 * by Requirement 1.3 (discoveredAt, lastVerifiedAt, Trust_Score) and
 * this test asserts that every produced record satisfies the
 * completeness invariant for any valid input.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  Benefit,
  EligibilityCriterion,
  SchemeCategory,
  SchemeObject,
} from '@bharat-benefits/shared';
import { TRUST_SCORE_CONFIG } from '@bharat-benefits/shared';

import {
  buildIngestedRecord,
  type BuildIngestedRecordOptions,
} from './ingestion-helpers';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns true iff `value` is a non-empty trimmed string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Returns true iff `value` is a Date with a valid (non-NaN) timestamp. */
function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Non-empty trimmed string suitable for human-readable mandatory text fields. */
const arbNonEmptyString = fc
  .string({ minLength: 1, maxLength: 64 })
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/** A DNS label: starts with a letter, lowercase alphanumerics, max 20 chars. */
const arbDnsLabel = fc.stringMatching(/^[a-z][a-z0-9]{0,19}$/);

/** Optional subdomain prefix: 0-3 labels joined by ".", trailing "." or "". */
const arbSubdomainPrefix = fc
  .array(arbDnsLabel, { minLength: 0, maxLength: 3 })
  .map((labels) => (labels.length === 0 ? '' : labels.join('.') + '.'));

/**
 * Source URL arbitrary covering both gov.in / nic.in (high trust) and
 * non-gov domains, http and https. Always syntactically valid.
 *
 * Mixing trusted and untrusted hosts ensures the property holds across
 * the full Trust_Score range, not only at the high end.
 */
const arbSourceUrl = fc
  .tuple(
    fc.constantFrom('https', 'http'),
    arbSubdomainPrefix,
    fc.constantFrom('gov.in', 'nic.in', 'mygov.in', 'india.gov.in', 'example.com', 'state.in'),
    fc.oneof(fc.constant(''), fc.constant('/'), fc.constant('/scheme/x'), fc.constant('/a/b?ref=1')),
  )
  .map(([scheme, sub, host, suffix]) => `${scheme}://${sub}${host}${suffix}`);

const arbCriterionOperator = fc.constantFrom(
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'between',
) as fc.Arbitrary<EligibilityCriterion['operator']>;

const arbEligibilityCriterion: fc.Arbitrary<EligibilityCriterion> = fc.record({
  field: arbNonEmptyString,
  operator: arbCriterionOperator,
  value: fc.oneof(fc.integer(), arbNonEmptyString, fc.boolean()),
  description: arbNonEmptyString,
});

const arbBenefit: fc.Arbitrary<Benefit> = fc.oneof(
  fc.record({
    type: fc.constant('monetary' as const),
    amount: fc.integer({ min: 0, max: 1_000_000_000 }),
    description: arbNonEmptyString,
  }),
  fc.record({
    type: fc.constant('non-monetary' as const),
    amount: fc.constant(null),
    description: arbNonEmptyString,
  }),
);

/**
 * SchemeObject arbitrary — every instance has all six mandatory fields
 * populated with non-empty values, mirroring the post-condition of
 * {@link enforceMandatoryFields}. Optional fields are always null in
 * this arbitrary; their values are irrelevant to Requirement 1.3.
 */
const arbValidSchemeObject: fc.Arbitrary<SchemeObject> = fc.record({
  name: arbNonEmptyString,
  description: arbNonEmptyString,
  eligibilityCriteria: fc.array(arbEligibilityCriterion, { minLength: 1, maxLength: 4 }),
  benefits: fc.array(arbBenefit, { minLength: 1, maxLength: 3 }),
  sourceUrl: arbSourceUrl,
  ministry: arbNonEmptyString,
  applicationProcess: fc.constant(null),
  requiredDocuments: fc.constant(null),
  deadline: fc.constant(null),
});

const arbCategory: fc.Arbitrary<SchemeCategory | null> = fc.option(
  fc.constantFrom<SchemeCategory>(
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
  ),
  { nil: null },
);

const arbState: fc.Arbitrary<string | null> = fc.option(arbNonEmptyString, { nil: null });

/**
 * Bounded valid Date arbitrary, covering ~1970 .. ~2100. Avoids the
 * extreme ends of the JS Date range (which fast-check can produce by
 * default) so timestamp arithmetic stays well-defined.
 */
const arbBoundedDate = fc
  .integer({
    min: 0, // 1970-01-01
    max: 4_102_444_800_000, // 2100-01-01
  })
  .map((ms) => new Date(ms));

const arbBuildOptions: fc.Arbitrary<BuildIngestedRecordOptions> = fc.record(
  {
    discoveredAt: fc.option(arbBoundedDate, { nil: undefined }),
    lastVerifiedAt: fc.option(arbBoundedDate, { nil: undefined }),
    category: arbCategory,
    state: arbState,
    now: fc.option(arbBoundedDate, { nil: undefined }),
  },
  { requiredKeys: [] },
);

// ─── Property 3: Scheme Metadata Completeness on Ingestion ───────────────────

describe('Property 3: Scheme Metadata Completeness on Ingestion', () => {
  // ── Core completeness invariant ──────────────────────────────────────────

  it('produces a record with non-null source URL, ministry, discoveredAt, lastVerifiedAt, and Trust_Score for any valid scheme and any options', () => {
    fc.assert(
      fc.property(arbValidSchemeObject, arbBuildOptions, (scheme, options) => {
        const record = buildIngestedRecord(scheme, options);

        // sourceUrl: non-null, non-empty
        expect(record.sourceUrl).not.toBeNull();
        expect(isNonEmptyString(record.sourceUrl)).toBe(true);
        expect(record.sourceUrl).toBe(scheme.sourceUrl);

        // ministry: non-null, non-empty
        expect(record.ministry).not.toBeNull();
        expect(isNonEmptyString(record.ministry)).toBe(true);
        expect(record.ministry).toBe(scheme.ministry);

        // discoveredAt: valid Date
        expect(record.discoveredAt).not.toBeNull();
        expect(isValidDate(record.discoveredAt)).toBe(true);

        // lastVerifiedAt: valid Date
        expect(record.lastVerifiedAt).not.toBeNull();
        expect(isValidDate(record.lastVerifiedAt)).toBe(true);

        // trustScore: integer in [0, 100]
        expect(record.trustScore).not.toBeNull();
        expect(Number.isInteger(record.trustScore)).toBe(true);
        expect(record.trustScore).toBeGreaterThanOrEqual(TRUST_SCORE_CONFIG.range.min);
        expect(record.trustScore).toBeLessThanOrEqual(TRUST_SCORE_CONFIG.range.max);
      }),
      { numRuns: 200 },
    );
  });

  // ── Defaulting behaviour ─────────────────────────────────────────────────

  it('defaults discoveredAt and lastVerifiedAt to options.now when no explicit date is given', () => {
    fc.assert(
      fc.property(arbValidSchemeObject, arbBoundedDate, (scheme, now) => {
        const record = buildIngestedRecord(scheme, { now });
        expect(record.discoveredAt.getTime()).toBe(now.getTime());
        expect(record.lastVerifiedAt.getTime()).toBe(now.getTime());
      }),
      { numRuns: 200 },
    );
  });

  it('uses options.discoveredAt and options.lastVerifiedAt verbatim when provided', () => {
    fc.assert(
      fc.property(
        arbValidSchemeObject,
        arbBoundedDate,
        arbBoundedDate,
        arbBoundedDate,
        (scheme, discoveredAt, lastVerifiedAt, now) => {
          const record = buildIngestedRecord(scheme, {
            discoveredAt,
            lastVerifiedAt,
            now,
          });
          expect(record.discoveredAt.getTime()).toBe(discoveredAt.getTime());
          expect(record.lastVerifiedAt.getTime()).toBe(lastVerifiedAt.getTime());
        },
      ),
      { numRuns: 200 },
    );
  });

  it('defaults discoveredAt and lastVerifiedAt to a valid current Date when no options are supplied', () => {
    fc.assert(
      fc.property(arbValidSchemeObject, (scheme) => {
        const before = Date.now();
        const record = buildIngestedRecord(scheme);
        const after = Date.now();

        expect(isValidDate(record.discoveredAt)).toBe(true);
        expect(isValidDate(record.lastVerifiedAt)).toBe(true);

        // Default timestamps land within the wall-clock window of the call.
        expect(record.discoveredAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(record.discoveredAt.getTime()).toBeLessThanOrEqual(after);
        expect(record.lastVerifiedAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(record.lastVerifiedAt.getTime()).toBeLessThanOrEqual(after);
      }),
      { numRuns: 50 },
    );
  });

  // ── Trust_Score derivation ───────────────────────────────────────────────

  it('always computes Trust_Score as an integer in [0, 100], matching the configured range', () => {
    fc.assert(
      fc.property(arbValidSchemeObject, arbBuildOptions, (scheme, options) => {
        const record = buildIngestedRecord(scheme, options);
        expect(Number.isInteger(record.trustScore)).toBe(true);
        expect(record.trustScore).toBeGreaterThanOrEqual(TRUST_SCORE_CONFIG.range.min);
        expect(record.trustScore).toBeLessThanOrEqual(TRUST_SCORE_CONFIG.range.max);
      }),
      { numRuns: 200 },
    );
  });

  // ── Optional categorisation fields stay nullable but the record is well-formed ──

  it('carries category and state through unchanged (null when omitted)', () => {
    fc.assert(
      fc.property(arbValidSchemeObject, arbCategory, arbState, (scheme, category, state) => {
        const record = buildIngestedRecord(scheme, { category, state });
        expect(record.category).toBe(category);
        expect(record.state).toBe(state);
      }),
      { numRuns: 200 },
    );
  });

  it('treats omitted category and state as null without affecting the five required metadata fields', () => {
    fc.assert(
      fc.property(arbValidSchemeObject, (scheme) => {
        const record = buildIngestedRecord(scheme, {});
        expect(record.category).toBeNull();
        expect(record.state).toBeNull();

        // Required-by-Requirement-1.3 fields remain populated.
        expect(isNonEmptyString(record.sourceUrl)).toBe(true);
        expect(isNonEmptyString(record.ministry)).toBe(true);
        expect(isValidDate(record.discoveredAt)).toBe(true);
        expect(isValidDate(record.lastVerifiedAt)).toBe(true);
        expect(Number.isInteger(record.trustScore)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
