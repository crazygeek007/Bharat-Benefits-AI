/**
 * Property-based tests for scheme JSON serialization round-trip.
 *
 * **Property 19: Scheme Serialization Round-Trip**
 * **Validates: Requirements 22.4**
 *
 * Property statement (from design.md):
 * "For any valid Scheme object (containing all mandatory fields: name,
 * description, eligibility criteria, benefits, source URL, ministry; and
 * any combination of optional fields), serializing to JSON and then parsing
 * back SHALL produce an object that is semantically equivalent — all field
 * values are identical regardless of JSON key ordering."
 *
 * Sub-properties verified here:
 *   1. Round-trip semantic equivalence
 *      areSchemesSemanticallyEqual(s, deserializeScheme(serializeScheme(s))) === true
 *   2. Stable serialization (idempotence)
 *      serializeScheme(s) === serializeScheme(deserializeScheme(serializeScheme(s)))
 *   3. Key-order independence
 *      A scheme built with shuffled top-level field insertion order produces
 *      a byte-identical canonical JSON string.
 *   4. Equivalence relation properties
 *      `areSchemesSemanticallyEqual` is reflexive and symmetric.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  ApplicationStep,
  Benefit,
  DocumentRequirement,
  EligibilityCriterion,
  SchemeObject,
} from '@bharat-benefits/shared';
import {
  areSchemesSemanticallyEqual,
  deserializeScheme,
  serializeScheme,
} from './serialization';

const NUM_RUNS = 200;

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * `EligibilityCriterion.value` is typed `unknown`, so we constrain it to
 * JSON-safe primitives (string, integer, boolean, null). Arbitrary values
 * (functions, symbols, undefined) cannot survive JSON serialization, so
 * exercising them in this property would conflate "round-trip works" with
 * "JSON.stringify drops non-serializable values".
 */
const arbCriterionValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

const arbEligibilityCriterion: fc.Arbitrary<EligibilityCriterion> = fc.record({
  field: fc.string(),
  operator: fc.constantFrom<EligibilityCriterion['operator']>(
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'between',
  ),
  value: arbCriterionValue,
  description: fc.string(),
});

/**
 * Finite amounts only. We additionally normalize `-0` to `0` because the
 * JSON encoding emits `0` either way (`JSON.stringify(-0) === '0'`), so
 * `Object.is(-0, 0) === false` would create a spurious round-trip failure.
 */
const arbFiniteAmount: fc.Arbitrary<number> = fc
  .float({ noNaN: true, noDefaultInfinity: true })
  .map((n) => (Object.is(n, -0) ? 0 : n));

const arbBenefit: fc.Arbitrary<Benefit> = fc.record({
  type: fc.constantFrom<Benefit['type']>('monetary', 'non-monetary'),
  amount: fc.option(arbFiniteAmount, { nil: null }),
  description: fc.string(),
});

const arbApplicationStep: fc.Arbitrary<ApplicationStep> = fc.record({
  stepNumber: fc.integer(),
  action: fc.string(),
  expectedOutcome: fc.string(),
});

const arbDocumentRequirement: fc.Arbitrary<DocumentRequirement> = fc.record({
  documentName: fc.string(),
  description: fc.string(),
  format: fc.string(),
  required: fc.boolean(),
});

const arbScheme: fc.Arbitrary<SchemeObject> = fc.record({
  name: fc.string({ minLength: 1 }),
  description: fc.string({ minLength: 1 }),
  eligibilityCriteria: fc.array(arbEligibilityCriterion, { minLength: 1, maxLength: 5 }),
  benefits: fc.array(arbBenefit, { minLength: 1, maxLength: 5 }),
  sourceUrl: fc.string({ minLength: 1 }),
  ministry: fc.string({ minLength: 1 }),
  applicationProcess: fc.option(fc.array(arbApplicationStep, { maxLength: 5 }), { nil: null }),
  requiredDocuments: fc.option(fc.array(arbDocumentRequirement, { maxLength: 5 }), { nil: null }),
  deadline: fc.option(fc.date({ noInvalidDate: true }), { nil: null }),
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 19: Scheme Serialization Round-Trip', () => {
  it('serialize → deserialize yields a semantically equivalent scheme', () => {
    fc.assert(
      fc.property(arbScheme, (scheme) => {
        const roundTripped = deserializeScheme(serializeScheme(scheme));
        expect(areSchemesSemanticallyEqual(scheme, roundTripped)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('serialize → deserialize → serialize is idempotent (stable JSON)', () => {
    fc.assert(
      fc.property(arbScheme, (scheme) => {
        const first = serializeScheme(scheme);
        const second = serializeScheme(deserializeScheme(first));
        expect(second).toBe(first);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('serializeScheme is independent of top-level field insertion order', () => {
    const arbSchemeWithReorder = arbScheme.chain((scheme) => {
      const keys = Object.keys(scheme);
      return fc
        .shuffledSubarray(keys, { minLength: keys.length, maxLength: keys.length })
        .map((permutedKeys) => {
          const reordered: Record<string, unknown> = {};
          for (const key of permutedKeys) {
            reordered[key] = (scheme as unknown as Record<string, unknown>)[key];
          }
          // The reordered object has exactly the same data with a different
          // insertion order — `as SchemeObject` is sound because every key
          // came from the original SchemeObject.
          return [scheme, reordered as unknown as SchemeObject] as const;
        });
    });

    fc.assert(
      fc.property(arbSchemeWithReorder, ([original, reordered]) => {
        expect(serializeScheme(original)).toBe(serializeScheme(reordered));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('areSchemesSemanticallyEqual is reflexive (s ~ s)', () => {
    fc.assert(
      fc.property(arbScheme, (scheme) => {
        expect(areSchemesSemanticallyEqual(scheme, scheme)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('areSchemesSemanticallyEqual is symmetric (a ~ b ⇔ b ~ a)', () => {
    fc.assert(
      fc.property(arbScheme, arbScheme, (a, b) => {
        expect(areSchemesSemanticallyEqual(a, b)).toBe(areSchemesSemanticallyEqual(b, a));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
