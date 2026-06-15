/**
 * Property-based tests for state-aware recommendation prioritization.
 *
 * **Property 21: State-Aware Recommendation Prioritization**
 * **Validates: Requirements 23.1, 23.2, 23.4**
 *
 * Property statement (from design.md):
 * "For any recommendation list generated for a citizen with a set state of
 * residence, the recommendations SHALL be grouped such that:
 *   (a) all schemes from the citizen's state appear before all Central
 *       Government schemes,
 *   (b) all Central Government schemes appear before schemes from other
 *       states, and
 *   (c) within each group, schemes are ordered by Match_Score, Benefit
 *       Amount, and Deadline proximity.
 * A state scheme with a lower Match_Score SHALL still rank above a Central
 * scheme with an equal or higher Match_Score."
 *
 * The tests below exercise the pure helpers exposed by the recommendation
 * engine — `applyStateAwarePrioritization`, `assignPriorityGroup`, and
 * `buildRecommendation` — across mixed-group recommendation lists. We avoid
 * mocks: every call passes through the real ordering function.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  INDIAN_STATES,
  type Recommendation,
  type Scheme,
  type EligibilityCriterion,
  type UserProfile,
} from '@bharat-benefits/shared';
import {
  applyStateAwarePrioritization,
  assignPriorityGroup,
  buildRecommendation,
  isUrgentDeadline,
} from './recommendation-engine';

const NUM_RUNS = 200;

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const arbState = fc.constantFrom(...INDIAN_STATES);
const arbUserState = arbState;

const arbMatchScore = fc.integer({ min: 0, max: 100 });
const arbBenefitAmount = fc.option(fc.integer({ min: 0, max: 10_000_000 }), {
  nil: null,
});

/**
 * Anchor "now" we use everywhere. Deadlines are drawn from a window centred
 * on this anchor so that the urgent-deadline boost (≤ 30 days from now) gets
 * meaningfully exercised across runs.
 */
const NOW = new Date('2024-06-01T00:00:00Z');

/** Deadlines spanning ~120 days before and ~365 days after `NOW`, plus null. */
const arbDeadline: fc.Arbitrary<Date | null> = fc.option(
  fc
    .integer({ min: -120, max: 365 })
    .map((days) => new Date(NOW.getTime() + days * 86_400_000)),
  { nil: null },
);

/**
 * Schema-id arbitrary: bounded length keeps shrinking tractable while still
 * exercising the lexicographic tie-breaker the engine uses.
 */
const arbSchemeId = fc.string({ minLength: 1, maxLength: 12 });

const arbPriorityGroup = fc.constantFrom<Recommendation['priorityGroup']>(
  'state',
  'central',
  'other',
);

/**
 * Synthesises a `Recommendation` with an explicitly-tagged `priorityGroup`.
 * Explanation is a fixed empty string — `applyStateAwarePrioritization` does
 * not look at it, and constraining it keeps shrunk counter-examples readable.
 */
const arbRecommendation: fc.Arbitrary<Recommendation> = fc.record({
  schemeId: arbSchemeId,
  matchScore: arbMatchScore,
  benefitAmount: arbBenefitAmount,
  deadline: arbDeadline,
  explanation: fc.constant(''),
  priorityGroup: arbPriorityGroup,
});

/** A list of 0–25 mixed-group recommendations. */
const arbRecommendationList = fc.array(arbRecommendation, {
  minLength: 0,
  maxLength: 25,
});

// ─── Scheme arbitraries (for assignPriorityGroup) ────────────────────────────

let schemeCounter = 0;
function makeScheme(state: string | null): Scheme {
  const id = `scheme-${++schemeCounter}`;
  return {
    id,
    name: id,
    description: 'desc',
    ministry: 'm',
    state,
    category: 'Agriculture',
    sourceUrl: `https://example.gov.in/${id}`,
    benefitType: 'monetary',
    benefitAmount: null,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: null,
    eligibilityCriteria: [],
    benefits: [],
    applicationSteps: null,
    requiredDocuments: null,
    trustScore: 80,
    verified: true,
    discoveredAt: new Date(0),
    lastVerifiedAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** Scheme bound to the citizen's state. */
function arbStateScheme(userState: string): fc.Arbitrary<Scheme> {
  return fc.constant(null).map(() => makeScheme(userState));
}

/** Central scheme (state === null). */
const arbCentralScheme: fc.Arbitrary<Scheme> = fc
  .constant(null)
  .map(() => makeScheme(null));

/** Other-state scheme: any Indian state that is NOT `userState`. */
function arbOtherScheme(userState: string): fc.Arbitrary<Scheme> {
  return fc
    .constantFrom(...INDIAN_STATES)
    .filter((s) => s !== userState)
    .map((s) => makeScheme(s));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Replays the engine's within-group comparator. Returns a negative number if
 * `a` should sort before `b`, positive if after, zero if interchangeable.
 *
 * Property 3 (within-group ordering) checks that adjacent same-group
 * recommendations in the sorted output never violate this comparator.
 */
function compareWithinGroup(
  a: Recommendation,
  b: Recommendation,
  now: Date,
): number {
  if (a.matchScore !== b.matchScore) return b.matchScore - a.matchScore;

  const ua = isUrgentDeadline(a.deadline, now);
  const ub = isUrgentDeadline(b.deadline, now);
  if (ua !== ub) return ua ? -1 : 1;

  const ba = a.benefitAmount ?? 0;
  const bb = b.benefitAmount ?? 0;
  if (ba !== bb) return bb - ba;

  const da = a.deadline === null ? Number.POSITIVE_INFINITY : a.deadline.getTime();
  const db = b.deadline === null ? Number.POSITIVE_INFINITY : b.deadline.getTime();
  if (da !== db) return da - db;

  if (a.schemeId < b.schemeId) return -1;
  if (a.schemeId > b.schemeId) return 1;
  return 0;
}

/** Indices in `recs` where `priorityGroup === group`. */
function indicesOfGroup(
  recs: Recommendation[],
  group: Recommendation['priorityGroup'],
): number[] {
  const out: number[] = [];
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].priorityGroup === group) out.push(i);
  }
  return out;
}

// ─── Property 1: Group ordering invariant (a, b) ─────────────────────────────

describe('Property 21a/21b: Group ordering invariant', () => {
  it('all state indices < all central indices < all other indices', () => {
    fc.assert(
      fc.property(arbRecommendationList, arbUserState, (recs, userState) => {
        const sorted = applyStateAwarePrioritization(recs, userState, NOW);

        const stateIdx = indicesOfGroup(sorted, 'state');
        const centralIdx = indicesOfGroup(sorted, 'central');
        const otherIdx = indicesOfGroup(sorted, 'other');

        const maxState = stateIdx.length === 0 ? -1 : Math.max(...stateIdx);
        const minCentral =
          centralIdx.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...centralIdx);
        const maxCentral = centralIdx.length === 0 ? -1 : Math.max(...centralIdx);
        const minOther =
          otherIdx.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...otherIdx);

        // (a) every state index < every central index
        expect(maxState).toBeLessThan(minCentral);
        // (b) every central index < every other index
        expect(maxCentral).toBeLessThan(minOther);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('preserves the multiset of recommendations', () => {
    // Sanity: sorting is a permutation. Without this guarantee, an
    // implementation could "satisfy" the ordering by dropping rows.
    fc.assert(
      fc.property(arbRecommendationList, arbUserState, (recs, userState) => {
        const sorted = applyStateAwarePrioritization(recs, userState, NOW);
        expect(sorted).toHaveLength(recs.length);

        const tally = (xs: Recommendation[]) => {
          const m = new Map<string, number>();
          for (const r of xs) {
            const key = `${r.schemeId}|${r.matchScore}|${r.benefitAmount}|${
              r.deadline === null ? 'null' : r.deadline.getTime()
            }|${r.priorityGroup}`;
            m.set(key, (m.get(key) ?? 0) + 1);
          }
          return m;
        };
        const before = tally(recs);
        const after = tally(sorted);
        expect(after).toEqual(before);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── Property 2: State dominates Match_Score (Req 23.4) ──────────────────────

describe('Property 21 (Req 23.4): State dominates Match_Score', () => {
  it('every state rec precedes every central or other rec, regardless of score', () => {
    fc.assert(
      fc.property(arbRecommendationList, arbUserState, (recs, userState) => {
        const sorted = applyStateAwarePrioritization(recs, userState, NOW);
        const positions = new Map<Recommendation, number>();
        sorted.forEach((r, i) => positions.set(r, i));

        for (const a of sorted) {
          if (a.priorityGroup !== 'state') continue;
          for (const b of sorted) {
            if (b.priorityGroup === 'state') continue;
            // a is in 'state', b is in 'central' or 'other'. State must
            // come first even when a.matchScore < b.matchScore.
            expect(positions.get(a)!).toBeLessThan(positions.get(b)!);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('counter-pressure case: state with low score still beats central with high score', () => {
    // Force the adversarial pairing every run (no soft "if there exist"
    // guard), so the property genuinely exercises the dominance rule.
    const arbAdversarialPair = fc
      .tuple(
        arbSchemeId,
        arbSchemeId,
        fc.integer({ min: 0, max: 49 }),
        fc.integer({ min: 50, max: 100 }),
        arbBenefitAmount,
        arbBenefitAmount,
        arbDeadline,
        arbDeadline,
      )
      .filter(([sa, sb]) => sa !== sb);

    fc.assert(
      fc.property(arbAdversarialPair, arbUserState, (tuple, userState) => {
        const [sa, sb, lowScore, highScore, ba, bb, da, db] = tuple;
        const stateRec: Recommendation = {
          schemeId: sa,
          matchScore: lowScore,
          benefitAmount: ba,
          deadline: da,
          explanation: '',
          priorityGroup: 'state',
        };
        const centralRec: Recommendation = {
          schemeId: sb,
          matchScore: highScore,
          benefitAmount: bb,
          deadline: db,
          explanation: '',
          priorityGroup: 'central',
        };
        const sorted = applyStateAwarePrioritization(
          [centralRec, stateRec],
          userState,
          NOW,
        );
        expect(sorted[0]).toBe(stateRec);
        expect(sorted[1]).toBe(centralRec);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── Property 3: Within-group ordering (c) ───────────────────────────────────

describe('Property 21c: Within-group ordering follows engine comparator', () => {
  it('adjacent same-group pairs satisfy compareWithinGroup ≤ 0', () => {
    fc.assert(
      fc.property(arbRecommendationList, arbUserState, (recs, userState) => {
        const sorted = applyStateAwarePrioritization(recs, userState, NOW);
        for (let i = 0; i < sorted.length - 1; i++) {
          const a = sorted[i];
          const b = sorted[i + 1];
          if (a.priorityGroup !== b.priorityGroup) continue;
          // Same group → engine's within-group comparator must say a ≤ b.
          expect(compareWithinGroup(a, b, NOW)).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('all same-group pairs (not just adjacent) respect the comparator', () => {
    // Adjacency alone is enough for a total order, but checking every pair
    // catches subtle stability bugs and is still cheap at this list size.
    fc.assert(
      fc.property(arbRecommendationList, arbUserState, (recs, userState) => {
        const sorted = applyStateAwarePrioritization(recs, userState, NOW);
        for (let i = 0; i < sorted.length; i++) {
          for (let j = i + 1; j < sorted.length; j++) {
            const a = sorted[i];
            const b = sorted[j];
            if (a.priorityGroup !== b.priorityGroup) continue;
            expect(compareWithinGroup(a, b, NOW)).toBeLessThanOrEqual(0);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── Property 4: assignPriorityGroup correctness ─────────────────────────────

describe('Property 21 (assignPriorityGroup): tag correctness', () => {
  it("scheme.state === userState (non-null) → 'state'", () => {
    fc.assert(
      fc.property(arbUserState, (userState) => {
        const scheme = makeScheme(userState);
        expect(assignPriorityGroup(scheme, userState)).toBe('state');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("scheme.state === null → 'central'", () => {
    fc.assert(
      fc.property(fc.option(arbUserState, { nil: null }), (userState) => {
        const scheme = makeScheme(null);
        expect(assignPriorityGroup(scheme, userState)).toBe('central');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("scheme.state non-null and != userState → 'other'", () => {
    const arbDistinctStates = fc
      .tuple(arbUserState, arbUserState)
      .filter(([a, b]) => a !== b);

    fc.assert(
      fc.property(arbDistinctStates, ([userState, schemeState]) => {
        const scheme = makeScheme(schemeState);
        expect(assignPriorityGroup(scheme, userState)).toBe('other');
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── End-to-end: buildRecommendation tags survive sorting ────────────────────

describe('Property 21 end-to-end via buildRecommendation', () => {
  function makeProfile(state: string): UserProfile {
    return {
      id: 'p',
      userId: 'u',
      age: 30,
      gender: 'Female',
      state,
      district: null,
      incomeLevel: 250_000,
      occupation: 'Farmer',
      educationLevel: 'Graduate',
      casteCategory: 'General',
      disabilityStatus: false,
      maritalStatus: 'Married',
      dependents: 1,
      languagePreference: 'en',
      updatedAt: new Date(0),
    };
  }

  // Eligibility-trivial criterion so every Scheme yields an Eligible result
  // — keeps the test focused on prioritization rather than eligibility.
  const trivialCriterion: EligibilityCriterion = {
    field: 'age',
    operator: 'gte',
    value: 0,
    description: 'age >= 0',
  };

  function withCriterion(s: Scheme): Scheme {
    return { ...s, eligibilityCriteria: [trivialCriterion] };
  }

  it('builds and sorts a mix of state/central/other into the correct groups', () => {
    fc.assert(
      fc.property(
        arbUserState,
        fc.array(fc.constantFrom('state', 'central', 'other'), {
          minLength: 1,
          maxLength: 12,
        }),
        (userState, kinds) => {
          const schemes: Scheme[] = kinds.map((kind) => {
            if (kind === 'central') return withCriterion(makeScheme(null));
            if (kind === 'state') return withCriterion(makeScheme(userState));
            // 'other': pick a deterministic non-userState
            const otherState = INDIAN_STATES.find((s) => s !== userState)!;
            return withCriterion(makeScheme(otherState));
          });

          const profile = makeProfile(userState);
          const recs: Recommendation[] = [];
          for (const s of schemes) {
            const r = buildRecommendation(profile, s, userState, NOW);
            if (r !== null) recs.push(r);
          }
          const sorted = applyStateAwarePrioritization(recs, userState, NOW);

          // Every priorityGroup tag matches the originating scheme's state.
          for (const r of sorted) {
            const s = schemes.find((x) => x.id === r.schemeId)!;
            const expected =
              s.state === null
                ? 'central'
                : s.state === userState
                  ? 'state'
                  : 'other';
            expect(r.priorityGroup).toBe(expected);
          }

          // Group ordering invariant holds end-to-end.
          const stateIdx = indicesOfGroup(sorted, 'state');
          const centralIdx = indicesOfGroup(sorted, 'central');
          const otherIdx = indicesOfGroup(sorted, 'other');
          const maxState = stateIdx.length === 0 ? -1 : Math.max(...stateIdx);
          const minCentral =
            centralIdx.length === 0
              ? Number.POSITIVE_INFINITY
              : Math.min(...centralIdx);
          const maxCentral =
            centralIdx.length === 0 ? -1 : Math.max(...centralIdx);
          const minOther =
            otherIdx.length === 0
              ? Number.POSITIVE_INFINITY
              : Math.min(...otherIdx);
          expect(maxState).toBeLessThan(minCentral);
          expect(maxCentral).toBeLessThan(minOther);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
