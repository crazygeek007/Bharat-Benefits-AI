/**
 * Property-based tests for the Missed_Benefits_Analyzer identification
 * predicate and monetary-value summation helper.
 *
 * **Property 25: Missed Benefits Identification**
 * **Validates: Requirements 15.1, 15.2, 15.5, 15.6**
 *
 * Property statement (from design.md):
 *   "For any citizen, the Missed_Benefits_Analyzer SHALL identify a scheme
 *    as 'missed' if and only if: (a) the citizen was eligible for the
 *    scheme based on their User_Profile at the time of the scheme's
 *    deadline, (b) the citizen did not mark the scheme as 'Applied' before
 *    the deadline, and (c) the deadline has passed. The estimated monetary
 *    value of missed benefits SHALL equal the sum of benefit amounts of
 *    missed schemes with quantifiable monetary benefits only."
 *
 * The properties below exercise the two pure helpers exported from
 * `missed-benefits-analyzer`:
 *
 *   - `isMissed(scheme, savedScheme, eligibility, asOf)` — universal
 *     identification predicate. Driven across the full cross-product of
 *     deadline / saved-status / eligibility-status / asOf inputs.
 *   - `sumMonetaryMissedBenefits(records)` — monetary subtotal helper.
 *     Driven across arbitrary record lists with mixed benefit types and
 *     malformed amounts.
 *
 * Both helpers are pure, so the suite is fully hermetic — no Prisma fakes,
 * no clock mocks, no eligibility engine. Each property runs 200 examples,
 * which is the project convention for fast pure-helper checks.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  EligibilityResult,
  SchemeStatus,
} from '@bharat-benefits/shared';
import {
  isMissed,
  sumMonetaryMissedBenefits,
  type MissedSchemeRecord,
} from './missed-benefits-analyzer';

const NUM_RUNS = 200;

// ─── Domain enumerations ─────────────────────────────────────────────────────

const SCHEME_STATUSES: ReadonlyArray<SchemeStatus> = [
  'Eligible',
  'Applied',
  'Saved',
  'Expired',
];

const ELIGIBILITY_STATUSES: ReadonlyArray<EligibilityResult['status']> = [
  'Eligible',
  'Partially Eligible',
  'Not Eligible',
];

// ─── Time-window constants ───────────────────────────────────────────────────

const MIN_TIME_MS = new Date('1970-01-01T00:00:00Z').getTime();
const MAX_TIME_MS = new Date('2150-01-01T00:00:00Z').getTime();

// ─── Atomic arbitraries ──────────────────────────────────────────────────────

/**
 * Reference timestamp for the "as of" parameter — drawn from a wide
 * window with strict interior bounds so deadlines on either side of it
 * remain representable in the same window.
 */
const arbAsOf: fc.Arbitrary<Date> = fc
  .integer({
    min: new Date('2000-01-01T00:00:00Z').getTime(),
    max: new Date('2100-01-01T00:00:00Z').getTime(),
  })
  .map((ms) => new Date(ms));

/** Saved-scheme arbitrary — `null` means the citizen never saved the scheme. */
const arbSaved: fc.Arbitrary<{ status: SchemeStatus } | null> = fc.option(
  fc.record({
    status: fc.constantFrom<SchemeStatus>(...SCHEME_STATUSES),
  }),
  { freq: 4, nil: null },
);

/** Eligibility-result arbitrary — `null` covers the "no eligibility" branch. */
const arbEligibility: fc.Arbitrary<
  { status: EligibilityResult['status'] } | null
> = fc.option(
  fc.record({
    status: fc.constantFrom<EligibilityResult['status']>(
      ...ELIGIBILITY_STATUSES,
    ),
  }),
  { freq: 4, nil: null },
);

// ─── Deadline arbitraries (parameterised on asOf) ───────────────────────────

/**
 * Deadline arbitrary covering the four cases the predicate must
 * distinguish:
 *   - `null`               → rolling/no-deadline scheme (never missed).
 *   - strictly before asOf → past deadline (eligible to be flagged).
 *   - strictly after asOf  → future deadline (not yet missed).
 *   - exactly equal to asOf → boundary case (must NOT be flagged — the
 *                              predicate uses strict `<`).
 *
 * Built as a function of `asOf` so each branch lands deterministically
 * rather than relying on probability across a wide window.
 */
function arbDeadlineFor(asOf: Date): fc.Arbitrary<Date | null> {
  const asOfMs = asOf.getTime();
  // Guard against the rare case where asOf hits a window boundary so the
  // sub-window collapses to an empty range.
  const arbPast =
    asOfMs - 1 >= MIN_TIME_MS
      ? fc
          .integer({ min: MIN_TIME_MS, max: asOfMs - 1 })
          .map((ms) => new Date(ms))
      : fc.constant(new Date(MIN_TIME_MS));
  const arbFuture =
    asOfMs + 1 <= MAX_TIME_MS
      ? fc
          .integer({ min: asOfMs + 1, max: MAX_TIME_MS })
          .map((ms) => new Date(ms))
      : fc.constant(new Date(MAX_TIME_MS));
  const arbExact = fc.constant(new Date(asOfMs));
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant(null) },
    { weight: 3, arbitrary: arbPast },
    { weight: 3, arbitrary: arbFuture },
    { weight: 1, arbitrary: arbExact },
  );
}

/** Strictly-non-past deadline — null OR `>= asOf`. Used by Property D. */
function arbNonPastDeadlineFor(asOf: Date): fc.Arbitrary<Date | null> {
  const asOfMs = asOf.getTime();
  const arbFuture = fc
    .integer({ min: asOfMs, max: MAX_TIME_MS })
    .map((ms) => new Date(ms));
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant(null) },
    { weight: 3, arbitrary: arbFuture },
  );
}

// ─── Composite case arbitraries ─────────────────────────────────────────────

interface PredicateInput {
  asOf: Date;
  deadline: Date | null;
  saved: { status: SchemeStatus } | null;
  eligibility: { status: EligibilityResult['status'] } | null;
}

/** All four predicate inputs in one arbitrary. */
const arbCase: fc.Arbitrary<PredicateInput> = arbAsOf.chain((asOf) =>
  fc
    .tuple(arbDeadlineFor(asOf), arbSaved, arbEligibility)
    .map(([deadline, saved, eligibility]) => ({
      asOf,
      deadline,
      saved,
      eligibility,
    })),
);

/** Forces savedScheme.status === 'Applied'. */
const arbAppliedCase: fc.Arbitrary<PredicateInput> = arbAsOf.chain((asOf) =>
  fc
    .tuple(
      arbDeadlineFor(asOf),
      fc.record({ status: fc.constant<SchemeStatus>('Applied') }),
      arbEligibility,
    )
    .map(([deadline, saved, eligibility]) => ({
      asOf,
      deadline,
      saved,
      eligibility,
    })),
);

/** Forces eligibility.status !== 'Eligible' (null, Partially Eligible, Not Eligible). */
const arbNonEligibleCase: fc.Arbitrary<PredicateInput> = arbAsOf.chain((asOf) =>
  fc
    .tuple(
      arbDeadlineFor(asOf),
      arbSaved,
      // `fc.oneof` infers the union from its arbitrary arguments — passing
      // an explicit generic causes a `MaybeWeightedArbitrary[]` constraint
      // mismatch in the current fast-check typings. Cast the union back
      // to the desired Arbitrary at the boundary.
      fc.oneof(
        fc.constant(null),
        fc.record({
          status: fc.constantFrom<EligibilityResult['status']>(
            'Partially Eligible',
            'Not Eligible',
          ),
        }),
      ) as fc.Arbitrary<{ status: EligibilityResult['status'] } | null>,
    )
    .map(([deadline, saved, eligibility]) => ({
      asOf,
      deadline,
      saved,
      eligibility,
    })),
);

/** Forces deadline = null OR deadline >= asOf. */
const arbNonPastCase: fc.Arbitrary<PredicateInput> = arbAsOf.chain((asOf) =>
  fc
    .tuple(arbNonPastDeadlineFor(asOf), arbSaved, arbEligibility)
    .map(([deadline, saved, eligibility]) => ({
      asOf,
      deadline,
      saved,
      eligibility,
    })),
);

// ─── Reference predicate ────────────────────────────────────────────────────

/**
 * Reference predicate — the spec restated as an executable boolean. Used
 * by Property A to assert bidirectional equivalence with `isMissed`.
 */
function referenceIsMissed(input: PredicateInput): boolean {
  const { deadline, saved, eligibility, asOf } = input;
  const deadlinePassed =
    deadline !== null && deadline.getTime() < asOf.getTime();
  const notApplied = saved === null || saved.status !== 'Applied';
  const isEligible = eligibility !== null && eligibility.status === 'Eligible';
  return deadlinePassed && notApplied && isEligible;
}

// ─── Arbitraries for sumMonetaryMissedBenefits (Property E) ─────────────────

const arbBenefitType: fc.Arbitrary<'monetary' | 'non-monetary'> =
  fc.constantFrom('monetary', 'non-monetary');

/**
 * Benefit-amount arbitrary covering every shape `sumMonetaryMissedBenefits`
 * must tolerate:
 *   - finite non-negative numbers (the only ones that contribute).
 *   - `null`                       — non-monetary placeholder.
 *   - negative numbers             — malformed; excluded.
 *   - non-finite numbers (NaN, ±∞) — malformed; excluded.
 */
const arbBenefitAmount: fc.Arbitrary<number | null> = fc.oneof(
  { weight: 6, arbitrary: fc.double({ min: 0, max: 1_000_000, noNaN: true }) },
  { weight: 1, arbitrary: fc.constant(null) },
  {
    weight: 1,
    arbitrary: fc.double({ min: -1_000_000, max: -0.01, noNaN: true }),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ),
  },
);

const arbMissedRecord: fc.Arbitrary<
  Pick<MissedSchemeRecord, 'benefitType' | 'benefitAmount'>
> = fc.record({
  benefitType: arbBenefitType,
  benefitAmount: arbBenefitAmount,
});

const arbMissedRecordList = fc.array(arbMissedRecord, {
  minLength: 0,
  maxLength: 50,
});

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Property 25: Missed Benefits Identification', () => {
  // Property A — Bidirectional iff -----------------------------------------
  it('A. isMissed agrees with the reference predicate over all input combinations', () => {
    fc.assert(
      fc.property(arbCase, (input) => {
        const actual = isMissed(
          { deadline: input.deadline },
          input.saved,
          input.eligibility,
          input.asOf,
        );
        const expected = referenceIsMissed(input);
        expect(actual).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Property B — Excludes Applied ------------------------------------------
  it('B. isMissed returns false whenever savedScheme.status === "Applied"', () => {
    fc.assert(
      fc.property(arbAppliedCase, (input) => {
        const actual = isMissed(
          { deadline: input.deadline },
          input.saved,
          input.eligibility,
          input.asOf,
        );
        expect(actual).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Property C — Excludes ineligible ---------------------------------------
  it('C. isMissed returns false whenever eligibility.status !== "Eligible"', () => {
    fc.assert(
      fc.property(arbNonEligibleCase, (input) => {
        const actual = isMissed(
          { deadline: input.deadline },
          input.saved,
          input.eligibility,
          input.asOf,
        );
        expect(actual).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Property D — Excludes future / null deadline ---------------------------
  it('D. isMissed returns false whenever deadline is null or deadline >= asOf', () => {
    fc.assert(
      fc.property(arbNonPastCase, (input) => {
        const actual = isMissed(
          { deadline: input.deadline },
          input.saved,
          input.eligibility,
          input.asOf,
        );
        expect(actual).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Property E — Sum monetary only -----------------------------------------
  it('E. sumMonetaryMissedBenefits sums only finite, non-negative monetary amounts', () => {
    fc.assert(
      fc.property(arbMissedRecordList, (records) => {
        // Reference computation — restate the spec as a straight reduce.
        let expected = 0;
        for (const r of records) {
          if (r.benefitType !== 'monetary') continue;
          const amount = r.benefitAmount;
          if (amount === null || amount === undefined) continue;
          if (typeof amount !== 'number') continue;
          if (!Number.isFinite(amount)) continue;
          if (amount < 0) continue;
          expected += amount;
        }

        const actual = sumMonetaryMissedBenefits(records);
        // Floating-point reduction must round-trip exactly with the
        // reference reduce when iteration order matches.
        expect(actual).toBe(expected);
        // Universal invariants: result is a finite, non-negative number.
        expect(Number.isFinite(actual)).toBe(true);
        expect(actual).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Bonus invariant — Determinism ------------------------------------------
  it('isMissed is deterministic for fixed inputs', () => {
    fc.assert(
      fc.property(arbCase, (input) => {
        const a = isMissed(
          { deadline: input.deadline },
          input.saved,
          input.eligibility,
          input.asOf,
        );
        const b = isMissed(
          { deadline: input.deadline },
          input.saved,
          input.eligibility,
          input.asOf,
        );
        expect(a).toBe(b);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
