/**
 * Unit tests for the Recommendation Engine.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 23.1, 23.2,
 * 23.3, 23.4, 23.5.
 *
 * Covers:
 *   - `calculateMatchScore` always returns an integer in [0, 100].
 *   - Not Eligible schemes are excluded from recommendations (Req 5.4).
 *   - State → Central → Other ordering (Req 23.1, 23.2, 23.4).
 *   - Within a group: Match_Score → Benefit Amount → Deadline ordering with
 *     a deadline-within-30-days boost (Req 5.1, 5.3).
 *   - Cap at MAX_RECOMMENDATIONS = 50 (Req 5.7).
 *   - Explanation length ≤ 200 chars (Req 5.6).
 *   - Empty schemes list yields an empty result (Req 5.8 path).
 *   - End-to-end orchestration against a fake Prisma client.
 */

import { describe, it, expect } from 'vitest';
import type { Scheme, UserProfile, EligibilityCriterion } from '@bharat-benefits/shared';
import {
  MAX_RECOMMENDATIONS,
  MAX_RECOMMENDATION_EXPLANATION_CHARS,
} from '@bharat-benefits/shared';
import {
  RecommendationEngine,
  applyStateAwarePrioritization,
  assignPriorityGroup,
  buildRecommendation,
  calculateMatchScore,
  generateExplanation,
  isUrgentDeadline,
  URGENT_DEADLINE_DAYS,
  type RecommendationEnginePrisma,
} from './recommendation-engine';
import { calculateEligibility } from '../eligibility';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'profile-1',
    userId: 'user-1',
    age: 30,
    gender: 'Female',
    state: 'Karnataka',
    district: 'Bangalore Urban',
    incomeLevel: 250_000,
    occupation: 'Farmer',
    educationLevel: 'Graduate',
    casteCategory: 'General',
    disabilityStatus: false,
    maritalStatus: 'Married',
    dependents: 1,
    languagePreference: 'en',
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

let schemeCounter = 0;
function makeScheme(overrides: Partial<Scheme> = {}): Scheme {
  const id = `scheme-${++schemeCounter}`;
  return {
    id,
    name: `Scheme ${id}`,
    description: `Description for ${id}`,
    ministry: 'Ministry of Test',
    state: null,
    category: 'Agriculture',
    sourceUrl: `https://example.gov.in/${id}`,
    benefitType: 'monetary',
    benefitAmount: 1000,
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
    lastVerifiedAt: new Date('2024-01-02T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

function criterion(
  field: string,
  operator: EligibilityCriterion['operator'],
  value: unknown,
): EligibilityCriterion {
  return { field, operator, value, description: `${field} ${operator} ${JSON.stringify(value)}` };
}

// ─── isUrgentDeadline ────────────────────────────────────────────────────────

describe('isUrgentDeadline', () => {
  const now = new Date('2024-06-01T00:00:00Z');

  it('returns true for deadlines within 30 days from now', () => {
    expect(isUrgentDeadline(new Date('2024-06-15T00:00:00Z'), now)).toBe(true);
    expect(isUrgentDeadline(new Date('2024-07-01T00:00:00Z'), now)).toBe(true);
  });

  it('returns false for deadlines beyond 30 days', () => {
    expect(isUrgentDeadline(new Date('2024-07-15T00:00:00Z'), now)).toBe(false);
  });

  it('returns false for past deadlines', () => {
    expect(isUrgentDeadline(new Date('2024-05-01T00:00:00Z'), now)).toBe(false);
  });

  it('returns false when deadline is null', () => {
    expect(isUrgentDeadline(null, now)).toBe(false);
  });
});

// ─── calculateMatchScore ─────────────────────────────────────────────────────

describe('calculateMatchScore', () => {
  it('returns an integer in [0, 100] for arbitrary profile/scheme combinations', () => {
    const profile = makeProfile();
    const samples: Scheme[] = [
      makeScheme(),
      makeScheme({ state: 'Karnataka', category: 'Agriculture', benefitAmount: 1_000_000 }),
      makeScheme({
        eligibilityCriteria: [criterion('age', 'gte', 60)], // unmet → Not Eligible
      }),
      makeScheme({ benefitAmount: null, lastVerifiedAt: new Date('1999-01-01') }),
      makeScheme({ benefitAmount: -500 }),
    ];
    for (const s of samples) {
      const score = calculateMatchScore(profile, s);
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it('omits the eligibility boost for Not Eligible schemes', () => {
    // Same profile and scheme attributes, only eligibility differs. The
    // eligible variant should score at least 60 points higher (the
    // eligibility component) than the ineligible one. Not Eligible
    // schemes are excluded from the citizen's recommendation list at
    // `buildRecommendation`, so only the score contract matters here.
    const profile = makeProfile({ age: 25 });
    const ineligible = makeScheme({
      eligibilityCriteria: [criterion('age', 'gte', 60)],
    });
    const eligible = makeScheme({
      eligibilityCriteria: [criterion('age', 'gte', 18)],
    });
    const ineligibleScore = calculateMatchScore(profile, ineligible);
    const eligibleScore = calculateMatchScore(profile, eligible);
    expect(eligibleScore - ineligibleScore).toBeGreaterThanOrEqual(60);
  });

  it('boosts state-matching schemes above non-matching ones, all else equal', () => {
    const profile = makeProfile({ state: 'Karnataka' });
    const stateScheme = makeScheme({ state: 'Karnataka' });
    const otherScheme = makeScheme({ state: 'Maharashtra' });
    expect(calculateMatchScore(profile, stateScheme)).toBeGreaterThan(
      calculateMatchScore(profile, otherScheme),
    );
  });

  it('rewards category alignment with the citizen occupation', () => {
    const profile = makeProfile({ occupation: 'Farmer', state: 'Karnataka' });
    const aligned = makeScheme({ category: 'Agriculture' });
    const unaligned = makeScheme({ category: 'Pension' });
    expect(calculateMatchScore(profile, aligned)).toBeGreaterThan(
      calculateMatchScore(profile, unaligned),
    );
  });
});

// ─── buildRecommendation: Not Eligible exclusion (Req 5.4) ───────────────────

describe('buildRecommendation', () => {
  it('returns null for Not Eligible schemes (Req 5.4)', () => {
    const profile = makeProfile({ age: 25 });
    const scheme = makeScheme({
      eligibilityCriteria: [criterion('age', 'gte', 60)],
    });
    expect(buildRecommendation(profile, scheme, profile.state)).toBeNull();
  });

  it('returns a non-null recommendation for Eligible schemes', () => {
    const profile = makeProfile();
    const scheme = makeScheme({
      eligibilityCriteria: [criterion('age', 'gte', 18)],
    });
    const rec = buildRecommendation(profile, scheme, profile.state);
    expect(rec).not.toBeNull();
    expect(rec!.schemeId).toBe(scheme.id);
    expect(rec!.matchScore).toBeGreaterThan(0);
  });

  it('tags priority groups correctly relative to the citizen state', () => {
    const profile = makeProfile({ state: 'Karnataka' });
    const stateScheme = makeScheme({ state: 'Karnataka' });
    const central = makeScheme({ state: null });
    const other = makeScheme({ state: 'Maharashtra' });
    expect(buildRecommendation(profile, stateScheme, profile.state)!.priorityGroup).toBe('state');
    expect(buildRecommendation(profile, central, profile.state)!.priorityGroup).toBe('central');
    expect(buildRecommendation(profile, other, profile.state)!.priorityGroup).toBe('other');
  });
});

// ─── assignPriorityGroup: Req 23.5 (no state set) ────────────────────────────

describe('assignPriorityGroup', () => {
  it('handles citizens without a state (Req 23.5)', () => {
    const central = makeScheme({ state: null });
    const stateBound = makeScheme({ state: 'Karnataka' });
    expect(assignPriorityGroup(central, null)).toBe('central');
    // Without a citizen state every state-bound scheme falls into "other",
    // which produces the Central-first ordering Req 23.5 requires.
    expect(assignPriorityGroup(stateBound, null)).toBe('other');
  });
});

// ─── Explanation length (Req 5.6) ────────────────────────────────────────────

describe('generateExplanation', () => {
  it('returns at most 200 characters', () => {
    const profile = makeProfile();
    const scheme = makeScheme();
    const eligibility = calculateEligibility(profile, scheme);
    const explanation = generateExplanation(profile, scheme, eligibility, 75);
    expect(explanation.length).toBeLessThanOrEqual(MAX_RECOMMENDATION_EXPLANATION_CHARS);
  });

  it('truncates extremely long content with an ellipsis', () => {
    const profile = makeProfile();
    const longCategory = 'X'.repeat(500) as unknown as Scheme['category'];
    const scheme = makeScheme({ category: longCategory });
    const eligibility = calculateEligibility(profile, scheme);
    const explanation = generateExplanation(profile, scheme, eligibility, 50);
    expect(explanation.length).toBeLessThanOrEqual(MAX_RECOMMENDATION_EXPLANATION_CHARS);
    expect(explanation.endsWith('...')).toBe(true);
  });
});

// ─── applyStateAwarePrioritization: ordering rules ───────────────────────────

describe('applyStateAwarePrioritization', () => {
  const now = new Date('2024-06-01T00:00:00Z');

  function rec(overrides: {
    schemeId: string;
    matchScore: number;
    benefitAmount?: number | null;
    deadline?: Date | null;
    priorityGroup: 'state' | 'central' | 'other';
  }) {
    return {
      explanation: '',
      benefitAmount: overrides.benefitAmount ?? null,
      deadline: overrides.deadline ?? null,
      ...overrides,
    };
  }

  it('orders state schemes before central, central before other (Req 23.1, 23.2)', () => {
    const sorted = applyStateAwarePrioritization(
      [
        rec({ schemeId: 'a', matchScore: 50, priorityGroup: 'other' }),
        rec({ schemeId: 'b', matchScore: 50, priorityGroup: 'central' }),
        rec({ schemeId: 'c', matchScore: 50, priorityGroup: 'state' }),
      ],
      'Karnataka',
      now,
    );
    expect(sorted.map((r) => r.schemeId)).toEqual(['c', 'b', 'a']);
  });

  it('keeps a lower-scoring state scheme above a higher-scoring central scheme (Req 23.4)', () => {
    const sorted = applyStateAwarePrioritization(
      [
        rec({ schemeId: 'central-high', matchScore: 95, priorityGroup: 'central' }),
        rec({ schemeId: 'state-low', matchScore: 30, priorityGroup: 'state' }),
      ],
      'Karnataka',
      now,
    );
    expect(sorted[0].schemeId).toBe('state-low');
  });

  it('within a group, sorts by Match_Score desc → Benefit Amount desc → Deadline asc (Req 5.1)', () => {
    const sorted = applyStateAwarePrioritization(
      [
        rec({
          schemeId: 'p1',
          matchScore: 80,
          benefitAmount: 1000,
          deadline: new Date('2025-01-01'),
          priorityGroup: 'central',
        }),
        rec({
          schemeId: 'p2',
          matchScore: 80,
          benefitAmount: 5000,
          deadline: new Date('2025-01-01'),
          priorityGroup: 'central',
        }),
        rec({
          schemeId: 'p3',
          matchScore: 90,
          benefitAmount: 1000,
          deadline: new Date('2025-01-01'),
          priorityGroup: 'central',
        }),
        rec({
          schemeId: 'p4',
          matchScore: 80,
          benefitAmount: 5000,
          deadline: new Date('2024-12-01'),
          priorityGroup: 'central',
        }),
      ],
      'Karnataka',
      now,
    );
    // p3 (score 90) first; then within score=80 the urgent-boost rule does
    // not apply (none of these deadlines are within 30 days of June 2024).
    // So the secondary key kicks in: benefit-amount desc places p2/p4 above
    // p1, and the tertiary key (deadline asc) places p4 above p2.
    expect(sorted.map((r) => r.schemeId)).toEqual(['p3', 'p4', 'p2', 'p1']);
  });

  it('boosts schemes with deadlines within 30 days above same-tier later/none (Req 5.3)', () => {
    const urgent = rec({
      schemeId: 'urgent',
      matchScore: 70,
      benefitAmount: 1000,
      deadline: new Date('2024-06-15T00:00:00Z'), // 14 days from `now`
      priorityGroup: 'central',
    });
    const later = rec({
      schemeId: 'later',
      matchScore: 70,
      benefitAmount: 5000, // higher benefit
      deadline: new Date('2025-01-01T00:00:00Z'),
      priorityGroup: 'central',
    });
    const noDeadline = rec({
      schemeId: 'none',
      matchScore: 70,
      benefitAmount: 10_000, // even higher benefit
      deadline: null,
      priorityGroup: 'central',
    });
    const sorted = applyStateAwarePrioritization([later, noDeadline, urgent], 'Karnataka', now);
    expect(sorted[0].schemeId).toBe('urgent');
  });
});

// ─── End-to-end via RecommendationEngine ─────────────────────────────────────

describe('RecommendationEngine.generateRecommendations', () => {
  function fakeDb(profile: UserProfile | null, schemes: Scheme[]): RecommendationEnginePrisma {
    return {
      userProfile: {
        async findUnique({ where }) {
          if (!profile) return null;
          return profile.userId === where.userId ? profile : null;
        },
      },
      scheme: {
        async findMany({ where }) {
          if (!where) return schemes;
          const min = where.trustScore?.gte ?? 0;
          return schemes.filter((s) => s.trustScore >= min);
        },
      },
    };
  }

  it('returns an empty list when there are no schemes (Req 5.8 path)', async () => {
    const profile = makeProfile();
    const engine = new RecommendationEngine(fakeDb(profile, []));
    const recs = await engine.generateRecommendations(profile.userId);
    expect(recs).toEqual([]);
  });

  it('excludes Not Eligible schemes from the result (Req 5.4)', async () => {
    const profile = makeProfile({ age: 25 });
    const ineligible = makeScheme({
      eligibilityCriteria: [criterion('age', 'gte', 60)],
    });
    const eligible = makeScheme({
      eligibilityCriteria: [criterion('age', 'gte', 18)],
    });
    const engine = new RecommendationEngine(fakeDb(profile, [ineligible, eligible]));
    const recs = await engine.generateRecommendations(profile.userId);
    expect(recs.map((r) => r.schemeId)).toEqual([eligible.id]);
  });

  it('caps the result at MAX_RECOMMENDATIONS (Req 5.7)', async () => {
    const profile = makeProfile();
    const schemes: Scheme[] = Array.from({ length: 75 }, () =>
      makeScheme({ eligibilityCriteria: [criterion('age', 'gte', 18)] }),
    );
    const engine = new RecommendationEngine(fakeDb(profile, schemes));
    const recs = await engine.generateRecommendations(profile.userId);
    expect(recs).toHaveLength(MAX_RECOMMENDATIONS);
  });

  it('orders state schemes before central before other (Req 23.1)', async () => {
    const profile = makeProfile({ state: 'Karnataka' });
    const central = makeScheme({ state: null, name: 'central' });
    const stateBound = makeScheme({ state: 'Karnataka', name: 'state' });
    const other = makeScheme({ state: 'Maharashtra', name: 'other' });
    const engine = new RecommendationEngine(fakeDb(profile, [other, central, stateBound]));
    const recs = await engine.generateRecommendations(profile.userId);
    expect(recs.map((r) => r.priorityGroup)).toEqual(['state', 'central', 'other']);
  });

  it('every recommendation has integer matchScore in [0, 100] and explanation ≤ 200 chars', async () => {
    const profile = makeProfile();
    const schemes: Scheme[] = [
      makeScheme({ state: 'Karnataka', category: 'Agriculture', benefitAmount: 500_000 }),
      makeScheme({ state: null, category: 'Healthcare' }),
      makeScheme({ state: 'Maharashtra', category: 'Education', benefitAmount: null }),
    ];
    const engine = new RecommendationEngine(fakeDb(profile, schemes));
    const recs = await engine.generateRecommendations(profile.userId);
    for (const r of recs) {
      expect(Number.isInteger(r.matchScore)).toBe(true);
      expect(r.matchScore).toBeGreaterThanOrEqual(0);
      expect(r.matchScore).toBeLessThanOrEqual(100);
      expect(r.explanation.length).toBeLessThanOrEqual(MAX_RECOMMENDATION_EXPLANATION_CHARS);
    }
  });

  it('completes well within the 60-second SLA at typical scale (Req 5.5)', async () => {
    const profile = makeProfile();
    const schemes: Scheme[] = Array.from({ length: 500 }, () =>
      makeScheme({
        state: Math.random() < 0.5 ? null : 'Karnataka',
        eligibilityCriteria: [criterion('age', 'gte', 18), criterion('income', 'lte', 1_000_000)],
      }),
    );
    const engine = new RecommendationEngine(fakeDb(profile, schemes));

    const start = Date.now();
    const recs = await engine.generateRecommendations(profile.userId);
    const duration = Date.now() - start;

    expect(recs.length).toBeLessThanOrEqual(MAX_RECOMMENDATIONS);
    expect(duration).toBeLessThan(60_000);
  });

  it('throws when the citizen has no profile (Req 5.8 caller surfaces this as a prompt)', async () => {
    const engine = new RecommendationEngine(fakeDb(null, []));
    await expect(engine.generateRecommendations('user-missing')).rejects.toThrow(
      /No user profile found/,
    );
  });

  it('rejects an empty userId', async () => {
    const engine = new RecommendationEngine(fakeDb(null, []));
    await expect(engine.generateRecommendations('')).rejects.toThrow(TypeError);
  });

  it('orders within the state group by Match_Score → Benefit Amount → Deadline ', async () => {
    const profile = makeProfile({ state: 'Karnataka' });
    // All Karnataka schemes (state group) and all Eligible.
    const a = makeScheme({
      state: 'Karnataka',
      benefitAmount: 1000,
      deadline: new Date('2025-01-01'),
      eligibilityCriteria: [criterion('age', 'gte', 18)],
    });
    const b = makeScheme({
      state: 'Karnataka',
      benefitAmount: 5000,
      deadline: new Date('2025-01-01'),
      eligibilityCriteria: [criterion('age', 'gte', 18)],
    });
    const c = makeScheme({
      state: 'Karnataka',
      benefitAmount: 5000,
      deadline: new Date('2024-12-01'),
      eligibilityCriteria: [criterion('age', 'gte', 18)],
    });
    const engine = new RecommendationEngine(fakeDb(profile, [a, b, c]));
    const recs = await engine.generateRecommendations(profile.userId);
    // All three have the same matchScore (same state, same category, same
    // eligibility, same recency). Tie-break by benefit amount desc, then
    // deadline asc: c (5000, earlier) → b (5000, later) → a (1000).
    expect(recs.map((r) => r.schemeId)).toEqual([c.id, b.id, a.id]);
  });
});
