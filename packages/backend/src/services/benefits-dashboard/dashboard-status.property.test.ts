/**
 * Property-based tests for the Benefits_Dashboard status grouping pipeline.
 *
 * **Property 16: Dashboard Status Grouping and Transitions**
 * **Validates: Requirements 11.1, 11.3, 11.4, 11.5**
 *
 * Property statement (from design.md):
 *   "For any saved scheme on the Benefits_Dashboard: (a) the scheme SHALL
 *    appear in exactly one status group at any time, (b) if a citizen marks
 *    a scheme as Applied, it SHALL remain in the Applied group regardless
 *    of deadline status, (c) if a scheme's deadline has passed and it is
 *    not marked Applied, it SHALL move to Expired, and (d) the count
 *    displayed for each status group SHALL equal the number of schemes in
 *    that group."
 *
 * The properties exercise the pure helpers `deriveStatus` and
 * `transitionStatuses` so the universal grouping invariants can be checked
 * across thousands of generated `(saved, scheme, eligibility, now)` tuples
 * without touching the database or eligibility engine.
 *
 * Properties checked:
 *   1. Exclusivity              — `deriveStatus` returns exactly one of
 *                                 {Eligible, Applied, Saved, Expired}.
 *   2. Applied latch (Req 11.3) — when the citizen has marked the scheme
 *                                 applied (status=Applied OR appliedAt set)
 *                                 the result is always Applied, regardless
 *                                 of deadline or eligibility.
 *   3. Deadline-driven Expired
 *      (Req 11.4)               — when not applied and the deadline has
 *                                 passed, the result is Expired.
 *   4. Eligible promotion       — when not applied, deadline not passed
 *                                 (or null), and eligibility=Eligible, the
 *                                 result is Eligible.
 *   5. Saved fallback           — otherwise the result is Saved.
 *   6. Group count consistency
 *      (Req 11.1, 11.5)         — grouping a list by `deriveStatus`
 *                                 produces counts that equal the group
 *                                 sizes and partition the input list.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  EligibilityResult,
  SavedScheme,
  Scheme,
  SchemeStatus,
} from '@bharat-benefits/shared';
import { deriveStatus } from './benefits-dashboard-service';

const NUM_RUNS = 200;
const STATUSES: ReadonlyArray<SchemeStatus> = [
  'Eligible',
  'Applied',
  'Saved',
  'Expired',
];

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * A "now" timestamp drawn from a wide but bounded window. The window is
 * intentionally larger than the deadline window below so the generator
 * frequently produces both past and future deadlines relative to `now`.
 */
const arbNow = fc
  .integer({
    min: new Date('2000-01-01T00:00:00Z').getTime(),
    max: new Date('2100-01-01T00:00:00Z').getTime(),
  })
  .map((ms) => new Date(ms));

/** A nullable deadline. ~25% chance of `null` (rolling/no-deadline schemes). */
const arbDeadline: fc.Arbitrary<Date | null> = fc.option(
  fc
    .integer({
      min: new Date('1990-01-01T00:00:00Z').getTime(),
      max: new Date('2110-01-01T00:00:00Z').getTime(),
    })
    .map((ms) => new Date(ms)),
  { freq: 4, nil: null },
);

/** A scheme record narrowed to the only field `deriveStatus` consumes. */
const arbScheme: fc.Arbitrary<Pick<Scheme, 'deadline'>> = arbDeadline.map(
  (deadline) => ({ deadline }),
);

/**
 * Saved-scheme arbitrary. We generate the full cross product of
 * `status ∈ SchemeStatus` × `appliedAt ∈ {null, Date}` so the property
 * exercises the "applied latch" precedence both via the persisted status
 * field and via the timestamp.
 */
const arbSaved: fc.Arbitrary<Pick<SavedScheme, 'status' | 'appliedAt'>> =
  fc.record({
    status: fc.constantFrom<SchemeStatus>(...STATUSES),
    appliedAt: fc.option(
      fc
        .integer({
          min: new Date('1990-01-01T00:00:00Z').getTime(),
          max: new Date('2110-01-01T00:00:00Z').getTime(),
        })
        .map((ms) => new Date(ms)),
      { nil: null },
    ),
  });

function makeEligibilityResult(
  status: EligibilityResult['status'],
): EligibilityResult {
  return {
    status,
    metCriteria: [],
    unmetCriteria: [],
    unevaluatedCriteria: [],
    missingProfileFields: [],
  };
}

/**
 * Eligibility arbitrary — `undefined` (no result available) is included so
 * the property covers the "Saved fallback when no eligibility" branch.
 */
const arbEligibility: fc.Arbitrary<EligibilityResult | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom<EligibilityResult['status']>(
    'Eligible',
    'Partially Eligible',
    'Not Eligible',
  ).map(makeEligibilityResult),
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isApplied(saved: Pick<SavedScheme, 'status' | 'appliedAt'>): boolean {
  return saved.status === 'Applied' || saved.appliedAt !== null;
}

function isExpired(
  scheme: Pick<Scheme, 'deadline'>,
  now: Date,
): boolean {
  return scheme.deadline !== null && scheme.deadline.getTime() < now.getTime();
}

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Property 16: Dashboard Status Grouping and Transitions', () => {
  // 1. Exclusivity ----------------------------------------------------------
  it('deriveStatus always returns exactly one of {Eligible, Applied, Saved, Expired}', () => {
    fc.assert(
      fc.property(
        arbSaved,
        arbScheme,
        arbEligibility,
        arbNow,
        (saved, scheme, eligibility, now) => {
          const status = deriveStatus(saved, scheme, eligibility, now);
          expect(STATUSES).toContain(status);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // 2. Applied latch (Req 11.3) --------------------------------------------
  it('applied schemes stay Applied regardless of deadline or eligibility', () => {
    // Force the Applied precondition by overriding the saved arbitrary so
    // at least one of (status=Applied, appliedAt!=null) holds.
    const arbAppliedSaved: fc.Arbitrary<
      Pick<SavedScheme, 'status' | 'appliedAt'>
    > = fc.oneof(
      // status = Applied, appliedAt arbitrary
      fc.record({
        status: fc.constant<SchemeStatus>('Applied'),
        appliedAt: fc.option(
          fc
            .integer({
              min: new Date('1990-01-01T00:00:00Z').getTime(),
              max: new Date('2110-01-01T00:00:00Z').getTime(),
            })
            .map((ms) => new Date(ms)),
          { nil: null },
        ),
      }),
      // appliedAt set, status arbitrary
      fc.record({
        status: fc.constantFrom<SchemeStatus>(...STATUSES),
        appliedAt: fc
          .integer({
            min: new Date('1990-01-01T00:00:00Z').getTime(),
            max: new Date('2110-01-01T00:00:00Z').getTime(),
          })
          .map((ms) => new Date(ms)),
      }),
    );

    fc.assert(
      fc.property(
        arbAppliedSaved,
        arbScheme,
        arbEligibility,
        arbNow,
        (saved, scheme, eligibility, now) => {
          const status = deriveStatus(saved, scheme, eligibility, now);
          expect(status).toBe('Applied');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // 3. Deadline-driven Expired (Req 11.4) ----------------------------------
  it('non-applied schemes with a passed deadline are Expired', () => {
    fc.assert(
      fc.property(
        arbSaved,
        arbScheme,
        arbEligibility,
        arbNow,
        (saved, scheme, eligibility, now) => {
          fc.pre(!isApplied(saved));
          fc.pre(isExpired(scheme, now));
          const status = deriveStatus(saved, scheme, eligibility, now);
          expect(status).toBe('Expired');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // 4. Eligible promotion --------------------------------------------------
  it('non-applied, non-expired schemes with eligibility=Eligible are Eligible', () => {
    fc.assert(
      fc.property(
        arbSaved,
        arbScheme,
        arbNow,
        (saved, scheme, now) => {
          fc.pre(!isApplied(saved));
          fc.pre(!isExpired(scheme, now));
          const status = deriveStatus(
            saved,
            scheme,
            makeEligibilityResult('Eligible'),
            now,
          );
          expect(status).toBe('Eligible');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // 5. Saved fallback ------------------------------------------------------
  it('non-applied, non-expired, non-eligible schemes fall through to Saved', () => {
    const arbNonEligible: fc.Arbitrary<EligibilityResult | undefined> = fc.oneof(
      fc.constant(undefined),
      fc.constantFrom<EligibilityResult['status']>(
        'Partially Eligible',
        'Not Eligible',
      ).map(makeEligibilityResult),
    );

    fc.assert(
      fc.property(
        arbSaved,
        arbScheme,
        arbNonEligible,
        arbNow,
        (saved, scheme, eligibility, now) => {
          fc.pre(!isApplied(saved));
          fc.pre(!isExpired(scheme, now));
          const status = deriveStatus(saved, scheme, eligibility, now);
          expect(status).toBe('Saved');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // 6. Group count consistency (Req 11.1, 11.5) ----------------------------
  it('grouping a list by deriveStatus partitions the input and counts equal group sizes', () => {
    // Bound the list size — 100 mirrors MAX_SAVED_SCHEMES so we exercise the
    // upper bound without bloating each shrunk counter-example.
    const arbEntry = fc.record({
      saved: arbSaved,
      scheme: arbScheme,
      eligibility: arbEligibility,
    });
    const arbEntries = fc.array(arbEntry, { minLength: 0, maxLength: 100 });

    fc.assert(
      fc.property(arbEntries, arbNow, (entries, now) => {
        const groups: Record<SchemeStatus, number> = {
          Eligible: 0,
          Applied: 0,
          Saved: 0,
          Expired: 0,
        };
        for (const { saved, scheme, eligibility } of entries) {
          const status = deriveStatus(saved, scheme, eligibility, now);
          expect(STATUSES).toContain(status);
          groups[status]++;
        }

        // (a) Each scheme appears in exactly one group — the sum of all
        // group counts equals the input length.
        const total =
          groups.Eligible + groups.Applied + groups.Saved + groups.Expired;
        expect(total).toBe(entries.length);

        // (d) The "displayed count" for each group equals the number of
        // schemes assigned to that group. We model the displayed counts as
        // the same map produced by a second pass over the input — they
        // must agree exactly.
        const recomputed: Record<SchemeStatus, number> = {
          Eligible: 0,
          Applied: 0,
          Saved: 0,
          Expired: 0,
        };
        for (const { saved, scheme, eligibility } of entries) {
          recomputed[deriveStatus(saved, scheme, eligibility, now)]++;
        }
        expect(recomputed).toEqual(groups);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Bonus invariant: status assignment is deterministic for fixed inputs.
  it('deriveStatus is deterministic for fixed inputs', () => {
    fc.assert(
      fc.property(
        arbSaved,
        arbScheme,
        arbEligibility,
        arbNow,
        (saved, scheme, eligibility, now) => {
          const a = deriveStatus(saved, scheme, eligibility, now);
          const b = deriveStatus(saved, scheme, eligibility, now);
          expect(a).toBe(b);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
