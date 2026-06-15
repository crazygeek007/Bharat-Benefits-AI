/**
 * Property-based tests for the Recommendation Engine ranking order.
 *
 * **Property 8: Recommendation Ranking Order**
 * **Validates: Requirements 5.1, 5.3**
 *
 * Property statement (from design.md):
 * "For any list of recommendations returned by the Recommendation_Engine,
 *  the list SHALL be ordered such that:
 *    (a) within the same priority group, schemes are sorted by Match_Score
 *        descending, then by Benefit Amount descending, then by Deadline
 *        proximity ascending, and
 *    (b) schemes with deadlines within 30 days SHALL rank above schemes
 *        with later or no deadlines when Match_Scores are otherwise equal."
 *
 * The `applyStateAwarePrioritization` pure function combines (a) within-group
 * lexicographic ordering with (b) the urgent-deadline boost, so these
 * properties exercise both rules at once. A fixed `now` is supplied to every
 * call so the urgent-boost predicate is deterministic across runs.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Recommendation } from '@bharat-benefits/shared';
import {
  applyStateAwarePrioritization,
  isUrgentDeadline,
  URGENT_DEADLINE_DAYS,
} from './recommendation-engine';

const NUM_RUNS = 200;

// Fixed reference instant so deadline-relative arbitraries and the
// urgent-boost predicate produce reproducible results.
const NOW = new Date('2024-06-01T00:00:00Z');
const ONE_DAY_MS = 86_400_000;

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const arbPriorityGroup = fc.constantFrom<Recommendation['priorityGroup']>(
  'state',
  'central',
  'other',
);

const arbMatchScore = fc.integer({ min: 0, max: 100 });

const arbBenefitAmount = fc.option(
  fc.integer({ min: 0, max: 10_000_000 }),
  { nil: null },
);

/**
 * Deadline drawn from -90 to +365 days relative to `NOW`. The window
 * intentionally straddles the urgent boost threshold (URGENT_DEADLINE_DAYS)
 * so the generated lists exercise both urgent and non-urgent code paths.
 */
const arbDeadline = fc.option(
  fc
    .integer({ min: -90, max: 365 })
    .map((d) => new Date(NOW.getTime() + d * ONE_DAY_MS)),
  { nil: null },
);

function arbRecommendationWithGroup(
  group: fc.Arbitrary<Recommendation['priorityGroup']>,
): fc.Arbitrary<Recommendation> {
  return fc.record<Recommendation>({
    schemeId: fc.uuid(),
    matchScore: arbMatchScore,
    benefitAmount: arbBenefitAmount,
    deadline: arbDeadline,
    explanation: fc.string({ maxLength: 50 }),
    priorityGroup: group,
  });
}

const arbRecommendation = arbRecommendationWithGroup(arbPriorityGroup);

/**
 * Mixed-group list of recommendations with unique schemeIds (so the final
 * tie-breaker in the comparator is total).
 */
const arbRecommendationList = fc.uniqueArray(arbRecommendation, {
  selector: (r) => r.schemeId,
  minLength: 0,
  maxLength: 50,
});

/**
 * Single-group list of recommendations: pick one priorityGroup, then build a
 * list whose entries all live in that group. Used for the within-group
 * ordering property.
 */
const arbSameGroupList = arbPriorityGroup.chain((g) =>
  fc.uniqueArray(arbRecommendationWithGroup(fc.constant(g)), {
    selector: (r) => r.schemeId,
    minLength: 0,
    maxLength: 50,
  }),
);

// ─── Comparator that mirrors the engine's intra-group ordering ───────────────
//
// Used by the within-group property: for adjacent pairs (a, b) in the sorted
// output, `compareWithinGroup(a, b)` must be <= 0.

function deadlineSortKey(d: Date | null): number {
  if (d === null) return Number.POSITIVE_INFINITY;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

function compareWithinGroup(a: Recommendation, b: Recommendation): number {
  // Match_Score descending (primary key, Req 5.1).
  if (a.matchScore !== b.matchScore) return b.matchScore - a.matchScore;

  // Urgent-boost (Req 5.3): deadlines within 30 days outrank later/none.
  const ua = isUrgentDeadline(a.deadline, NOW);
  const ub = isUrgentDeadline(b.deadline, NOW);
  if (ua !== ub) return ua ? -1 : 1;

  // Benefit Amount descending (null treated as 0).
  const ba = a.benefitAmount ?? 0;
  const bb = b.benefitAmount ?? 0;
  if (ba !== bb) return bb - ba;

  // Deadline ascending (null treated as +∞ so it sorts last).
  const da = deadlineSortKey(a.deadline);
  const db = deadlineSortKey(b.deadline);
  if (da !== db) return da - db;

  // Final deterministic tie-breaker on schemeId so the comparator is total.
  return a.schemeId < b.schemeId ? -1 : a.schemeId > b.schemeId ? 1 : 0;
}

const PRIORITY_GROUP_RANK: Record<Recommendation['priorityGroup'], number> = {
  state: 0,
  central: 1,
  other: 2,
};

// ─── Property tests ──────────────────────────────────────────────────────────

describe('Property 8: Recommendation Ranking Order', () => {
  // (a) Within-group ordering.
  it('within a single priority group, every adjacent pair respects the comparator (Req 5.1, 5.3)', () => {
    fc.assert(
      fc.property(arbSameGroupList, (list) => {
        const sorted = applyStateAwarePrioritization(list, null, NOW);

        // Every entry stayed in the same group (the fixture only generates one).
        if (sorted.length > 0) {
          const g = sorted[0].priorityGroup;
          for (const r of sorted) {
            expect(r.priorityGroup).toBe(g);
          }
        }

        // For every adjacent pair (a, b), a must rank <= b under the
        // intra-group comparator.
        for (let i = 0; i + 1 < sorted.length; i++) {
          const cmp = compareWithinGroup(sorted[i], sorted[i + 1]);
          expect(cmp).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Group ordering across mixed lists.
  it('orders all state schemes before central, central before other (Req 23.1, 23.2)', () => {
    fc.assert(
      fc.property(arbRecommendationList, (list) => {
        const sorted = applyStateAwarePrioritization(list, null, NOW);
        for (let i = 0; i + 1 < sorted.length; i++) {
          const ra = PRIORITY_GROUP_RANK[sorted[i].priorityGroup];
          const rb = PRIORITY_GROUP_RANK[sorted[i + 1].priorityGroup];
          expect(ra).toBeLessThanOrEqual(rb);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // (b) Urgent-deadline boost at equal Match_Score within the same group.
  it('urgent (≤30d) outranks non-urgent at equal Match_Score in the same group (Req 5.3)', () => {
    fc.assert(
      fc.property(
        arbPriorityGroup,
        arbMatchScore,
        // Urgent: 0 to URGENT_DEADLINE_DAYS days from NOW (inclusive).
        fc.integer({ min: 0, max: URGENT_DEADLINE_DAYS }),
        // Non-urgent: strictly later than URGENT_DEADLINE_DAYS, or null.
        fc.option(
          fc.integer({ min: URGENT_DEADLINE_DAYS + 1, max: 365 }),
          { nil: null },
        ),
        arbBenefitAmount,
        arbBenefitAmount,
        fc.uuid(),
        fc.uuid(),
        (group, score, urgentDays, nonUrgentDaysOrNull, baA, baB, idA, idB) => {
          fc.pre(idA !== idB);
          const urgent: Recommendation = {
            schemeId: idA,
            matchScore: score,
            benefitAmount: baA,
            deadline: new Date(NOW.getTime() + urgentDays * ONE_DAY_MS),
            explanation: '',
            priorityGroup: group,
          };
          const nonUrgent: Recommendation = {
            schemeId: idB,
            matchScore: score,
            benefitAmount: baB,
            deadline:
              nonUrgentDaysOrNull === null
                ? null
                : new Date(NOW.getTime() + nonUrgentDaysOrNull * ONE_DAY_MS),
            explanation: '',
            priorityGroup: group,
          };

          // Sanity-check the precondition we set up.
          expect(isUrgentDeadline(urgent.deadline, NOW)).toBe(true);
          expect(isUrgentDeadline(nonUrgent.deadline, NOW)).toBe(false);

          // Order shouldn't matter — urgent must end up first regardless of
          // benefit amount or deadline distance among the non-urgent side.
          const sortedAB = applyStateAwarePrioritization(
            [urgent, nonUrgent],
            null,
            NOW,
          );
          const sortedBA = applyStateAwarePrioritization(
            [nonUrgent, urgent],
            null,
            NOW,
          );

          expect(sortedAB[0].schemeId).toBe(idA);
          expect(sortedBA[0].schemeId).toBe(idA);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Determinism / stability of the sort across repeated invocations.
  it('is deterministic — same input produces the same ordered output', () => {
    fc.assert(
      fc.property(arbRecommendationList, (list) => {
        const first = applyStateAwarePrioritization([...list], null, NOW);
        const second = applyStateAwarePrioritization([...list], null, NOW);
        const third = applyStateAwarePrioritization([...list], null, NOW);

        expect(first.map((r) => r.schemeId)).toEqual(
          second.map((r) => r.schemeId),
        );
        expect(second.map((r) => r.schemeId)).toEqual(
          third.map((r) => r.schemeId),
        );

        // Length is preserved (no entries dropped or duplicated).
        expect(first).toHaveLength(list.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
