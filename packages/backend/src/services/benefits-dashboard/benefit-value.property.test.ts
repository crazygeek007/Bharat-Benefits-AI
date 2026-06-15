/**
 * Property-based tests for the Estimated Total Benefit Value calculation.
 *
 * **Property 17: Estimated Benefit Value Calculation**
 * **Validates: Requirements 11.2, 11.6**
 *
 * Property statement (from design.md):
 *   "For any set of schemes in the 'Eligible' status on a citizen's
 *    dashboard, the Estimated Total Benefit Value SHALL equal the sum of
 *    monetary benefit amounts of only those schemes that have a
 *    quantifiable monetary benefit (type = 'monetary'), excluding all
 *    schemes with non-monetary or unquantifiable benefits."
 *
 * The properties exercise the pure helpers `calculateEstimatedBenefitValue`
 * (sum-only) and `computeEstimatedBenefitValue` (status-filter then sum) so
 * the universal valuation invariants can be checked across hundreds of
 * generated scheme lists without touching the database.
 *
 * Properties checked:
 *   1. Reference equivalence       — the helper agrees with a naive
 *                                    reference summation over schemes that
 *                                    are monetary AND have a finite,
 *                                    non-null, non-negative amount.
 *   2. Non-monetary exclusion      — removing every non-monetary scheme
 *                                    from the input does not change the
 *                                    result.
 *   3. Null-amount exclusion       — schemes with `benefitAmount === null`
 *                                    contribute zero regardless of type.
 *   4. Empty list                  — `calculateEstimatedBenefitValue([])`
 *                                    returns 0.
 *   5. Status filtering            — for `computeEstimatedBenefitValue`,
 *                                    only schemes with `status === 'Eligible'`
 *                                    contribute; Applied / Saved / Expired
 *                                    are excluded even when monetary.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { SchemeStatus } from '@bharat-benefits/shared';
import {
  calculateEstimatedBenefitValue,
  computeEstimatedBenefitValue,
} from './benefits-dashboard-service';

const NUM_RUNS = 200;

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Either of the two valid benefit types defined on `Scheme.benefitType`. */
const arbBenefitType: fc.Arbitrary<'monetary' | 'non-monetary'> =
  fc.constantFrom('monetary', 'non-monetary');

/**
 * A nullable, non-negative integer amount. Bounded at 1_000_000 (1M INR per
 * scheme) which is realistic for the Indian benefits domain and keeps
 * accumulated sums well within `Number.MAX_SAFE_INTEGER` even at the
 * MAX_SAVED_SCHEMES (100) cap.
 */
const arbBenefitAmount: fc.Arbitrary<number | null> = fc.option(
  fc.integer({ min: 0, max: 1_000_000 }),
  { nil: null },
);

/** Minimal scheme shape consumed by `calculateEstimatedBenefitValue`. */
const arbScheme: fc.Arbitrary<{
  benefitType: 'monetary' | 'non-monetary';
  benefitAmount: number | null;
}> = fc.record({
  benefitType: arbBenefitType,
  benefitAmount: arbBenefitAmount,
});

/** Same as `arbScheme` but tagged with one of the four dashboard statuses. */
const arbSchemeWithStatus: fc.Arbitrary<{
  status: SchemeStatus;
  benefitType: 'monetary' | 'non-monetary';
  benefitAmount: number | null;
}> = fc.record({
  status: fc.constantFrom<SchemeStatus>(
    'Eligible',
    'Applied',
    'Saved',
    'Expired',
  ),
  benefitType: arbBenefitType,
  benefitAmount: arbBenefitAmount,
});

// ─── Reference summation (used by Property 1) ────────────────────────────────

/**
 * Naive reference implementation derived directly from the design-doc
 * property statement. The helper under test must agree with this for any
 * input list. Kept separate so the property test does not double-implement
 * the production logic.
 */
function referenceSum(
  schemes: ReadonlyArray<{
    benefitType: 'monetary' | 'non-monetary';
    benefitAmount: number | null;
  }>,
): number {
  let total = 0;
  for (const s of schemes) {
    if (s.benefitType !== 'monetary') continue;
    if (s.benefitAmount === null) continue;
    if (!Number.isFinite(s.benefitAmount)) continue;
    if (s.benefitAmount < 0) continue;
    total += s.benefitAmount;
  }
  return total;
}

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Property 17: Estimated Benefit Value Calculation', () => {
  // 1. Reference equivalence -----------------------------------------------
  it('calculateEstimatedBenefitValue equals the reference monetary-only sum', () => {
    fc.assert(
      fc.property(fc.array(arbScheme, { maxLength: 100 }), (schemes) => {
        const actual = calculateEstimatedBenefitValue(schemes);
        const expected = referenceSum(schemes);
        expect(actual).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // 2. Non-monetary exclusion ----------------------------------------------
  it('removing non-monetary schemes does not change the result', () => {
    fc.assert(
      fc.property(fc.array(arbScheme, { maxLength: 100 }), (schemes) => {
        const withMixed = calculateEstimatedBenefitValue(schemes);
        const monetaryOnly = calculateEstimatedBenefitValue(
          schemes.filter((s) => s.benefitType === 'monetary'),
        );
        expect(withMixed).toBe(monetaryOnly);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // 3. Null-amount exclusion -----------------------------------------------
  it('schemes with null benefitAmount contribute 0 regardless of benefitType', () => {
    fc.assert(
      fc.property(fc.array(arbScheme, { maxLength: 100 }), (schemes) => {
        const baseline = calculateEstimatedBenefitValue(schemes);

        // Inject extra schemes with `benefitAmount === null` of both types.
        const extras: Array<{
          benefitType: 'monetary' | 'non-monetary';
          benefitAmount: number | null;
        }> = [
          { benefitType: 'monetary', benefitAmount: null },
          { benefitType: 'non-monetary', benefitAmount: null },
        ];
        const augmented = [...schemes, ...extras];

        expect(calculateEstimatedBenefitValue(augmented)).toBe(baseline);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // 4. Empty list ----------------------------------------------------------
  it('calculateEstimatedBenefitValue([]) === 0', () => {
    expect(calculateEstimatedBenefitValue([])).toBe(0);
  });

  // 5. Status filtering ----------------------------------------------------
  it('computeEstimatedBenefitValue only sums schemes with status === Eligible', () => {
    fc.assert(
      fc.property(
        fc.array(arbSchemeWithStatus, { maxLength: 100 }),
        (schemes) => {
          const actual = computeEstimatedBenefitValue(schemes);

          // Reference: filter to Eligible first, then run the monetary-only
          // reference summation over the result. This mirrors the design-doc
          // property statement word-for-word.
          const expected = referenceSum(
            schemes.filter((s) => s.status === 'Eligible'),
          );
          expect(actual).toBe(expected);

          // Cross-check: re-tagging non-Eligible schemes' amounts should not
          // change the total, since they are excluded by the status filter.
          const mutated = schemes.map((s) =>
            s.status === 'Eligible'
              ? s
              : { ...s, benefitAmount: 999_999, benefitType: 'monetary' as const },
          );
          expect(computeEstimatedBenefitValue(mutated)).toBe(actual);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
