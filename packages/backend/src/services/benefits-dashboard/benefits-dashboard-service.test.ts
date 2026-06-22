/**
 * Unit tests for the Benefits Dashboard Service.
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 10.1.
 *
 * Covers:
 *   - Status grouping and transitions (Eligible / Applied / Saved / Expired).
 *   - Estimated Total Benefit Value (monetary-only summation, Req 11.2/11.6).
 *   - `markAsApplied` retention regardless of deadline (Req 11.3).
 *   - `saveScheme` 100-scheme cap (Req 10.1) and idempotency.
 *   - Empty-state dashboard (Req 11.7).
 *   - Pure helper `transitionStatuses` and `calculateEstimatedBenefitValue`.
 */

import { describe, it, expect } from 'vitest';
import type {
  Benefit,
  EligibilityResult,
  Recommendation,
  SavedScheme,
  Scheme,
} from '@bharat-benefits/shared';
import { MAX_SAVED_SCHEMES } from '@bharat-benefits/shared';
import {
  BenefitsDashboardService,
  DASHBOARD_RECOMMENDATION_FALLBACK_LIMIT,
  SavedSchemeLimitExceededError,
  SavedSchemeNotFoundError,
  SchemeNotFoundError,
  calculateEstimatedBenefitValue,
  deriveStatus,
  transitionStatuses,
  type BenefitsDashboardPrisma,
  type BenefitsDashboardSchemeLookupPrisma,
} from './benefits-dashboard-service';

// ─── Test fixtures ───────────────────────────────────────────────────────────

const NOW = new Date('2024-06-15T12:00:00Z');
const PAST = new Date('2024-06-01T00:00:00Z');
const FUTURE = new Date('2024-12-31T23:59:59Z');

function makeScheme(overrides: Partial<Scheme> = {}): Scheme {
  const benefits: Benefit[] = overrides.benefits ?? [
    { type: 'monetary', amount: 1000, description: 'Cash benefit' },
  ];
  return {
    id: 'scheme-1',
    name: 'Example Scheme',
    description: 'Test scheme',
    ministry: 'Ministry of Test',
    state: null,
    category: 'Education',
    sourceUrl: 'https://example.gov.in/test',
    benefitType: 'monetary',
    benefitAmount: 1000,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: null,
    eligibilityCriteria: [],
    benefits,
    applicationSteps: null,
    requiredDocuments: null,
    trustScore: 80,
    verified: true,
    discoveredAt: PAST,
    lastVerifiedAt: PAST,
    updatedAt: PAST,
    ...overrides,
  };
}

function makeSaved(overrides: Partial<SavedScheme> = {}): SavedScheme {
  return {
    id: `saved-${overrides.schemeId ?? 'x'}`,
    userId: 'user-1',
    schemeId: 'scheme-1',
    status: 'Saved',
    savedAt: PAST,
    appliedAt: null,
    ...overrides,
  };
}

function eligibleResult(): EligibilityResult {
  return {
    status: 'Eligible',
    metCriteria: [],
    unmetCriteria: [],
    unevaluatedCriteria: [],
    missingProfileFields: [],
  };
}

function notEligibleResult(): EligibilityResult {
  return {
    status: 'Not Eligible',
    metCriteria: [],
    unmetCriteria: [
      { criterionName: 'age', requirement: 'age >= 60', profileValue: 30, met: false },
    ],
    unevaluatedCriteria: [],
    missingProfileFields: [],
  };
}

function partiallyEligibleResult(): EligibilityResult {
  return {
    status: 'Partially Eligible',
    metCriteria: [
      { criterionName: 'age', requirement: 'age >= 18', profileValue: 30, met: true },
    ],
    unmetCriteria: [],
    unevaluatedCriteria: [
      { criterionName: 'occupation', requirement: 'Farmer', missingField: 'occupation' },
    ],
    missingProfileFields: ['occupation'],
  };
}

// ─── Fake Prisma ─────────────────────────────────────────────────────────────

interface FakeState {
  saved: Array<SavedScheme & { scheme: Scheme }>;
  schemes: Map<string, Scheme>;
}

function makeFakePrisma(state: FakeState): BenefitsDashboardPrisma {
  return {
    savedScheme: {
      async findMany({ where }) {
        return state.saved.filter((s) => s.userId === where.userId);
      },
      async count({ where }) {
        return state.saved.filter((s) => s.userId === where.userId).length;
      },
      async findUnique({ where }) {
        const { userId, schemeId } = where.uq_user_saved_scheme;
        const found = state.saved.find(
          (s) => s.userId === userId && s.schemeId === schemeId,
        );
        if (!found) return null;
        // Return a SavedScheme without the joined scheme.
        const { scheme: _scheme, ...rest } = found;
        return rest;
      },
      async create({ data }) {
        const scheme = state.schemes.get(data.schemeId);
        if (!scheme) {
          throw new Error('Foreign key violation in fake prisma');
        }
        const row: SavedScheme & { scheme: Scheme } = {
          id: `saved-${data.schemeId}`,
          userId: data.userId,
          schemeId: data.schemeId,
          status: data.status,
          savedAt: data.savedAt,
          appliedAt: data.appliedAt,
          scheme,
        };
        state.saved.push(row);
        const { scheme: _s, ...rest } = row;
        return rest;
      },
      async update({ where, data }) {
        const { userId, schemeId } = where.uq_user_saved_scheme;
        const idx = state.saved.findIndex(
          (s) => s.userId === userId && s.schemeId === schemeId,
        );
        if (idx === -1) throw new Error('Record not found');
        const updated = { ...state.saved[idx], ...data };
        state.saved[idx] = updated;
        const { scheme: _s, ...rest } = updated;
        return rest;
      },
    },
    scheme: {
      async findUnique({ where }) {
        return state.schemes.get(where.id) ?? null;
      },
    },
  };
}

function makeFakeEligibilityEngine(
  results: Map<string, EligibilityResult>,
): { recalculateAllSavedSchemes: (userId: string) => Promise<Array<{ schemeId: string; result: EligibilityResult }>> } {
  return {
    async recalculateAllSavedSchemes() {
      return Array.from(results.entries()).map(([schemeId, result]) => ({
        schemeId,
        result,
      }));
    },
  };
}

// ─── Pure helpers: deriveStatus ──────────────────────────────────────────────

describe('deriveStatus', () => {
  it('returns Applied when appliedAt is set, regardless of deadline (Req 11.3)', () => {
    const status = deriveStatus(
      { status: 'Saved', appliedAt: PAST },
      { deadline: PAST }, // already in the past
      eligibleResult(),
      NOW,
    );
    expect(status).toBe('Applied');
  });

  it('returns Applied when persisted status is Applied even without appliedAt', () => {
    const status = deriveStatus(
      { status: 'Applied', appliedAt: null },
      { deadline: PAST },
      eligibleResult(),
      NOW,
    );
    expect(status).toBe('Applied');
  });

  it('returns Expired when deadline is in the past and not Applied (Req 11.4)', () => {
    const status = deriveStatus(
      { status: 'Saved', appliedAt: null },
      { deadline: PAST },
      eligibleResult(),
      NOW,
    );
    expect(status).toBe('Expired');
  });

  it('returns Eligible when eligibility result is Eligible and deadline not passed', () => {
    const status = deriveStatus(
      { status: 'Saved', appliedAt: null },
      { deadline: FUTURE },
      eligibleResult(),
      NOW,
    );
    expect(status).toBe('Eligible');
  });

  it('returns Saved for Partially Eligible schemes', () => {
    const status = deriveStatus(
      { status: 'Saved', appliedAt: null },
      { deadline: FUTURE },
      partiallyEligibleResult(),
      NOW,
    );
    expect(status).toBe('Saved');
  });

  it('returns Saved when no eligibility result is provided', () => {
    const status = deriveStatus(
      { status: 'Saved', appliedAt: null },
      { deadline: FUTURE },
      undefined,
      NOW,
    );
    expect(status).toBe('Saved');
  });

  it('returns Saved for schemes with no deadline that are not yet Eligible', () => {
    const status = deriveStatus(
      { status: 'Saved', appliedAt: null },
      { deadline: null },
      notEligibleResult(),
      NOW,
    );
    expect(status).toBe('Saved');
  });

  it('does not expire schemes with null deadline (rolling/no-deadline)', () => {
    const status = deriveStatus(
      { status: 'Saved', appliedAt: null },
      { deadline: null },
      eligibleResult(),
      NOW,
    );
    expect(status).toBe('Eligible');
  });
});

// ─── transitionStatuses ──────────────────────────────────────────────────────

describe('transitionStatuses', () => {
  it('classifies each saved scheme into the correct bucket', () => {
    const eligibleScheme = makeScheme({ id: 's1', deadline: FUTURE });
    const expiredScheme = makeScheme({ id: 's2', deadline: PAST });
    const appliedScheme = makeScheme({ id: 's3', deadline: PAST });
    const savedScheme = makeScheme({ id: 's4', deadline: FUTURE });

    const transitioned = transitionStatuses(
      [
        { saved: makeSaved({ schemeId: 's1' }), scheme: eligibleScheme },
        { saved: makeSaved({ schemeId: 's2' }), scheme: expiredScheme },
        {
          saved: makeSaved({ schemeId: 's3', appliedAt: PAST, status: 'Applied' }),
          scheme: appliedScheme,
        },
        { saved: makeSaved({ schemeId: 's4' }), scheme: savedScheme },
      ],
      new Map([
        ['s1', eligibleResult()],
        ['s2', eligibleResult()],
        ['s3', eligibleResult()],
        ['s4', notEligibleResult()],
      ]),
      NOW,
    );

    const byScheme = new Map(transitioned.map((t) => [t.schemeId, t.status]));
    expect(byScheme.get('s1')).toBe('Eligible');
    expect(byScheme.get('s2')).toBe('Expired');
    expect(byScheme.get('s3')).toBe('Applied');
    expect(byScheme.get('s4')).toBe('Saved');
  });

  it('every scheme appears in exactly one bucket (status invariant)', () => {
    const schemes = [
      makeScheme({ id: 's1', deadline: FUTURE }),
      makeScheme({ id: 's2', deadline: PAST }),
      makeScheme({ id: 's3' }),
    ];
    const transitioned = transitionStatuses(
      schemes.map((scheme) => ({
        saved: makeSaved({ schemeId: scheme.id }),
        scheme,
      })),
      new Map(schemes.map((s) => [s.id, eligibleResult()])),
      NOW,
    );
    expect(new Set(transitioned.map((t) => t.schemeId)).size).toBe(schemes.length);
    for (const t of transitioned) {
      expect(['Eligible', 'Applied', 'Saved', 'Expired']).toContain(t.status);
    }
  });
});

// ─── calculateEstimatedBenefitValue ──────────────────────────────────────────

describe('calculateEstimatedBenefitValue', () => {
  it('sums monetary benefit amounts of every supplied scheme', () => {
    const schemes = [
      makeScheme({ id: 's1', benefitType: 'monetary', benefitAmount: 1000 }),
      makeScheme({ id: 's2', benefitType: 'monetary', benefitAmount: 2500 }),
      makeScheme({ id: 's3', benefitType: 'monetary', benefitAmount: 0 }),
    ];
    expect(calculateEstimatedBenefitValue(schemes)).toBe(3500);
  });

  it('excludes non-monetary schemes (Req 11.6)', () => {
    const schemes = [
      makeScheme({ id: 's1', benefitType: 'monetary', benefitAmount: 1000 }),
      makeScheme({
        id: 's2',
        benefitType: 'non-monetary',
        benefitAmount: 99999, // amount must be ignored when non-monetary
      }),
    ];
    expect(calculateEstimatedBenefitValue(schemes)).toBe(1000);
  });

  it('excludes monetary schemes with null benefitAmount', () => {
    const schemes = [
      makeScheme({ id: 's1', benefitType: 'monetary', benefitAmount: 1000 }),
      makeScheme({ id: 's2', benefitType: 'monetary', benefitAmount: null }),
    ];
    expect(calculateEstimatedBenefitValue(schemes)).toBe(1000);
  });

  it('returns 0 for an empty list', () => {
    expect(calculateEstimatedBenefitValue([])).toBe(0);
  });

  it('ignores malformed amounts (NaN, negative, Infinity)', () => {
    const schemes = [
      makeScheme({ id: 's1', benefitType: 'monetary', benefitAmount: 1000 }),
      makeScheme({ id: 's2', benefitType: 'monetary', benefitAmount: Number.NaN }),
      makeScheme({ id: 's3', benefitType: 'monetary', benefitAmount: -50 }),
      makeScheme({
        id: 's4',
        benefitType: 'monetary',
        benefitAmount: Number.POSITIVE_INFINITY,
      }),
    ];
    expect(calculateEstimatedBenefitValue(schemes)).toBe(1000);
  });
});

// ─── BenefitsDashboardService.getDashboard ───────────────────────────────────

describe('BenefitsDashboardService.getDashboard', () => {
  it('returns the empty-state dashboard when the citizen has no saved schemes (Req 11.7)', async () => {
    const state: FakeState = { saved: [], schemes: new Map() };
    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    expect(dashboard.eligible).toEqual([]);
    expect(dashboard.applied).toEqual([]);
    expect(dashboard.saved).toEqual([]);
    expect(dashboard.expired).toEqual([]);
    expect(dashboard.estimatedTotalBenefitValue).toBe(0);
    expect(dashboard.counts).toEqual({ eligible: 0, applied: 0, saved: 0, expired: 0 });
    expect(dashboard.missedBenefitsSummary).toEqual({
      totalCount: 0,
      totalMonetaryValue: 0,
      schemes: [],
    });
  });

  it('groups saved schemes into Eligible / Applied / Saved / Expired buckets (Req 11.1)', async () => {
    const eligibleScheme = makeScheme({
      id: 's-elig',
      deadline: FUTURE,
      benefitType: 'monetary',
      benefitAmount: 1500,
    });
    const expiredScheme = makeScheme({
      id: 's-exp',
      deadline: PAST,
      benefitAmount: 9999,
    });
    const appliedScheme = makeScheme({
      id: 's-app',
      deadline: PAST,
      benefitAmount: 9999,
    });
    const savedScheme = makeScheme({
      id: 's-saved',
      deadline: FUTURE,
      benefitAmount: 9999,
    });

    const state: FakeState = {
      saved: [
        {
          ...makeSaved({ schemeId: 's-elig' }),
          scheme: eligibleScheme,
        },
        {
          ...makeSaved({ schemeId: 's-exp' }),
          scheme: expiredScheme,
        },
        {
          ...makeSaved({
            schemeId: 's-app',
            status: 'Applied',
            appliedAt: PAST,
          }),
          scheme: appliedScheme,
        },
        {
          ...makeSaved({ schemeId: 's-saved' }),
          scheme: savedScheme,
        },
      ],
      schemes: new Map([
        [eligibleScheme.id, eligibleScheme],
        [expiredScheme.id, expiredScheme],
        [appliedScheme.id, appliedScheme],
        [savedScheme.id, savedScheme],
      ]),
    };

    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map([
          ['s-elig', eligibleResult()],
          ['s-exp', eligibleResult()],
          ['s-app', eligibleResult()],
          ['s-saved', notEligibleResult()],
        ]),
      ),
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    expect(dashboard.eligible.map((e) => e.scheme.id)).toEqual(['s-elig']);
    expect(dashboard.expired.map((e) => e.scheme.id)).toEqual(['s-exp']);
    expect(dashboard.applied.map((e) => e.scheme.id)).toEqual(['s-app']);
    expect(dashboard.saved.map((e) => e.scheme.id)).toEqual(['s-saved']);
    expect(dashboard.counts).toEqual({
      eligible: 1,
      applied: 1,
      saved: 1,
      expired: 1,
    });
  });

  it('calculates estimatedTotalBenefitValue from monetary Eligible schemes only (Req 11.2, 11.6)', async () => {
    const monetary = makeScheme({
      id: 's1',
      deadline: FUTURE,
      benefitType: 'monetary',
      benefitAmount: 5000,
    });
    const nonMonetary = makeScheme({
      id: 's2',
      deadline: FUTURE,
      benefitType: 'non-monetary',
      benefitAmount: null,
    });
    const expired = makeScheme({
      id: 's3',
      deadline: PAST,
      benefitType: 'monetary',
      benefitAmount: 10_000, // expired — must NOT count toward total
    });

    const state: FakeState = {
      saved: [
        { ...makeSaved({ schemeId: 's1' }), scheme: monetary },
        { ...makeSaved({ schemeId: 's2' }), scheme: nonMonetary },
        { ...makeSaved({ schemeId: 's3' }), scheme: expired },
      ],
      schemes: new Map([
        [monetary.id, monetary],
        [nonMonetary.id, nonMonetary],
        [expired.id, expired],
      ]),
    };

    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map([
          ['s1', eligibleResult()],
          ['s2', eligibleResult()],
          ['s3', eligibleResult()],
        ]),
      ),
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    expect(dashboard.estimatedTotalBenefitValue).toBe(5000);
  });

  it('keeps Applied schemes in the Applied bucket regardless of deadline (Req 11.3)', async () => {
    const scheme = makeScheme({ id: 's1', deadline: PAST });
    const state: FakeState = {
      saved: [
        {
          ...makeSaved({
            schemeId: 's1',
            status: 'Applied',
            appliedAt: PAST,
          }),
          scheme,
        },
      ],
      schemes: new Map([[scheme.id, scheme]]),
    };

    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map([['s1', eligibleResult()]]),
      ),
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    expect(dashboard.applied.map((e) => e.scheme.id)).toEqual(['s1']);
    expect(dashboard.expired).toEqual([]);
  });

  it('counts displayed for each bucket equal the bucket size (Req 11.5)', async () => {
    const schemes = Array.from({ length: 5 }, (_, i) =>
      makeScheme({ id: `s${i}`, deadline: FUTURE, benefitAmount: 100 }),
    );
    const state: FakeState = {
      saved: schemes.map((scheme) => ({
        ...makeSaved({ schemeId: scheme.id }),
        scheme,
      })),
      schemes: new Map(schemes.map((s) => [s.id, s])),
    };

    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map(schemes.map((s) => [s.id, eligibleResult()])),
      ),
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    expect(dashboard.counts.eligible).toBe(dashboard.eligible.length);
    expect(dashboard.counts.applied).toBe(dashboard.applied.length);
    expect(dashboard.counts.saved).toBe(dashboard.saved.length);
    expect(dashboard.counts.expired).toBe(dashboard.expired.length);
    expect(
      dashboard.counts.eligible +
        dashboard.counts.applied +
        dashboard.counts.saved +
        dashboard.counts.expired,
    ).toBe(5);
  });

  it('falls back gracefully when eligibility recalculation fails', async () => {
    const scheme = makeScheme({ id: 's1', deadline: FUTURE, benefitAmount: 5000 });
    const state: FakeState = {
      saved: [{ ...makeSaved({ schemeId: 's1' }), scheme }],
      schemes: new Map([[scheme.id, scheme]]),
    };

    const failingEligibility = {
      async recalculateAllSavedSchemes() {
        throw new Error('No user profile found for userId=user-1');
      },
    };

    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: failingEligibility,
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    // Without eligibility, the scheme stays in the Saved bucket.
    expect(dashboard.saved.map((e) => e.scheme.id)).toEqual(['s1']);
    expect(dashboard.eligible).toEqual([]);
    expect(dashboard.estimatedTotalBenefitValue).toBe(0);
  });

  it('rejects empty userId', async () => {
    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma({ saved: [], schemes: new Map() }),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      now: () => NOW,
    });
    await expect(service.getDashboard('')).rejects.toThrow(TypeError);
  });
});

// ─── Eligible-bucket recommendation fallback ─────────────────────────────────

function makeRecommendation(
  overrides: Partial<Recommendation> = {},
): Recommendation {
  return {
    schemeId: 'scheme-1',
    matchScore: 80,
    benefitAmount: 1000,
    deadline: null,
    explanation: '80% match; Central scheme; eligible',
    priorityGroup: 'central',
    ...overrides,
  };
}

function makeSchemeLookup(schemes: Scheme[]): BenefitsDashboardSchemeLookupPrisma {
  return {
    scheme: {
      async findMany({ where }) {
        const ids = new Set(where.id.in);
        return schemes.filter((s) => ids.has(s.id));
      },
    },
  };
}

describe('BenefitsDashboardService.getDashboard — recommendation fallback', () => {
  it('fills the Eligible bucket with top recommendations when the citizen has no saved schemes', async () => {
    const recA = makeScheme({ id: 'rec-a', benefitAmount: 1500, benefitType: 'monetary' });
    const recB = makeScheme({ id: 'rec-b', benefitAmount: 2500, benefitType: 'monetary' });

    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma({ saved: [], schemes: new Map() }),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      recommendationEngine: {
        async generateRecommendations() {
          return [
            makeRecommendation({ schemeId: 'rec-a', matchScore: 90, benefitAmount: 1500 }),
            makeRecommendation({ schemeId: 'rec-b', matchScore: 70, benefitAmount: 2500 }),
          ];
        },
      },
      schemeLookup: makeSchemeLookup([recA, recB]),
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    expect(dashboard.eligible.map((e) => e.scheme.id)).toEqual(['rec-a', 'rec-b']);
    expect(dashboard.eligible.every((e) => e.status === 'Eligible')).toBe(true);
    expect(dashboard.eligible.every((e) => e.appliedAt === null)).toBe(true);
    // estimatedTotalBenefitValue follows the eligible bucket — fallback included.
    expect(dashboard.estimatedTotalBenefitValue).toBe(4000);
    expect(dashboard.counts.eligible).toBe(2);
  });

  it('fills the Eligible bucket when saved schemes exist but none qualify as Eligible', async () => {
    const notEligibleScheme = makeScheme({ id: 's-no', deadline: FUTURE });
    const recScheme = makeScheme({ id: 'rec-x', benefitAmount: 500, benefitType: 'monetary' });

    const state: FakeState = {
      saved: [{ ...makeSaved({ schemeId: 's-no' }), scheme: notEligibleScheme }],
      schemes: new Map([[notEligibleScheme.id, notEligibleScheme]]),
    };

    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map([['s-no', notEligibleResult()]]),
      ),
      recommendationEngine: {
        async generateRecommendations() {
          return [makeRecommendation({ schemeId: 'rec-x', matchScore: 75 })];
        },
      },
      schemeLookup: makeSchemeLookup([recScheme]),
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    expect(dashboard.saved.map((e) => e.scheme.id)).toEqual(['s-no']);
    expect(dashboard.eligible.map((e) => e.scheme.id)).toEqual(['rec-x']);
  });

  it('does NOT pull in recommendations when the Eligible bucket is already populated by saved schemes', async () => {
    const eligibleScheme = makeScheme({ id: 's-elig', deadline: FUTURE });
    const recScheme = makeScheme({ id: 'rec-x' });

    const state: FakeState = {
      saved: [{ ...makeSaved({ schemeId: 's-elig' }), scheme: eligibleScheme }],
      schemes: new Map([[eligibleScheme.id, eligibleScheme]]),
    };

    let engineCalled = false;
    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map([['s-elig', eligibleResult()]]),
      ),
      recommendationEngine: {
        async generateRecommendations() {
          engineCalled = true;
          return [makeRecommendation({ schemeId: 'rec-x' })];
        },
      },
      schemeLookup: makeSchemeLookup([recScheme]),
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    expect(dashboard.eligible.map((e) => e.scheme.id)).toEqual(['s-elig']);
    expect(engineCalled).toBe(false);
  });

  it('excludes recommendations whose scheme is already in another bucket (no duplicates)', async () => {
    const savedScheme = makeScheme({ id: 'shared', deadline: FUTURE });
    const otherRec = makeScheme({ id: 'other-rec' });

    const state: FakeState = {
      // Saved with no eligibility result so it lands in Saved bucket, leaving
      // the Eligible bucket empty and the fallback path active.
      saved: [{ ...makeSaved({ schemeId: 'shared' }), scheme: savedScheme }],
      schemes: new Map([[savedScheme.id, savedScheme]]),
    };

    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      recommendationEngine: {
        async generateRecommendations() {
          return [
            makeRecommendation({ schemeId: 'shared', matchScore: 95 }),
            makeRecommendation({ schemeId: 'other-rec', matchScore: 60 }),
          ];
        },
      },
      schemeLookup: makeSchemeLookup([savedScheme, otherRec]),
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    expect(dashboard.saved.map((e) => e.scheme.id)).toEqual(['shared']);
    expect(dashboard.eligible.map((e) => e.scheme.id)).toEqual(['other-rec']);
  });

  it('caps the fallback at DASHBOARD_RECOMMENDATION_FALLBACK_LIMIT entries', async () => {
    const schemes = Array.from({ length: 20 }, (_, i) =>
      makeScheme({ id: `rec-${i}` }),
    );

    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma({ saved: [], schemes: new Map() }),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      recommendationEngine: {
        async generateRecommendations() {
          return schemes.map((s, i) =>
            makeRecommendation({ schemeId: s.id, matchScore: 100 - i }),
          );
        },
      },
      schemeLookup: makeSchemeLookup(schemes),
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    expect(dashboard.eligible.length).toBe(DASHBOARD_RECOMMENDATION_FALLBACK_LIMIT);
  });

  it('returns an empty Eligible bucket when the recommendation engine throws', async () => {
    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma({ saved: [], schemes: new Map() }),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      recommendationEngine: {
        async generateRecommendations() {
          throw new Error('No user profile found');
        },
      },
      schemeLookup: makeSchemeLookup([]),
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    expect(dashboard.eligible).toEqual([]);
    expect(dashboard.estimatedTotalBenefitValue).toBe(0);
  });

  it('does not invoke the recommendation engine when no fallback dep is provided (backwards compatibility)', async () => {
    // The existing constructor signature is no-deps — the service must keep
    // working when callers omit the recommendationEngine.
    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma({ saved: [], schemes: new Map() }),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    expect(dashboard.eligible).toEqual([]);
  });
});

// ─── BenefitsDashboardService.markAsApplied ──────────────────────────────────

describe('BenefitsDashboardService.markAsApplied', () => {
  it('moves a saved scheme to Applied and stamps appliedAt (Req 11.3)', async () => {
    const scheme = makeScheme({ id: 's1', deadline: FUTURE });
    const state: FakeState = {
      saved: [{ ...makeSaved({ schemeId: 's1' }), scheme }],
      schemes: new Map([[scheme.id, scheme]]),
    };

    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      now: () => NOW,
    });

    await service.markAsApplied('user-1', 's1');

    expect(state.saved[0].status).toBe('Applied');
    expect(state.saved[0].appliedAt).toEqual(NOW);
  });

  it('retains Applied status when the deadline passes (Req 11.3)', async () => {
    const scheme = makeScheme({ id: 's1', deadline: PAST });
    const state: FakeState = {
      saved: [{ ...makeSaved({ schemeId: 's1' }), scheme }],
      schemes: new Map([[scheme.id, scheme]]),
    };

    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map([['s1', notEligibleResult()]]),
      ),
      now: () => NOW,
    });

    await service.markAsApplied('user-1', 's1');
    const dashboard = await service.getDashboard('user-1');

    expect(dashboard.applied.map((e) => e.scheme.id)).toEqual(['s1']);
    expect(dashboard.expired).toEqual([]);
  });

  it('is idempotent for an already-applied scheme', async () => {
    const scheme = makeScheme({ id: 's1' });
    const earlierApplied = new Date('2024-05-01T00:00:00Z');
    const state: FakeState = {
      saved: [
        {
          ...makeSaved({
            schemeId: 's1',
            status: 'Applied',
            appliedAt: earlierApplied,
          }),
          scheme,
        },
      ],
      schemes: new Map([[scheme.id, scheme]]),
    };

    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      now: () => NOW,
    });

    await service.markAsApplied('user-1', 's1');
    expect(state.saved[0].appliedAt).toEqual(earlierApplied);
  });

  it('throws SavedSchemeNotFoundError when the citizen has not saved the scheme', async () => {
    const state: FakeState = { saved: [], schemes: new Map() };
    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      now: () => NOW,
    });
    await expect(service.markAsApplied('user-1', 's1')).rejects.toThrow(
      SavedSchemeNotFoundError,
    );
  });

  it('rejects empty arguments', async () => {
    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma({ saved: [], schemes: new Map() }),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      now: () => NOW,
    });
    await expect(service.markAsApplied('', 's1')).rejects.toThrow(TypeError);
    await expect(service.markAsApplied('user-1', '')).rejects.toThrow(TypeError);
  });
});

// ─── BenefitsDashboardService.saveScheme ─────────────────────────────────────

describe('BenefitsDashboardService.saveScheme', () => {
  it('saves a scheme with status=Saved when the citizen is below the cap', async () => {
    const scheme = makeScheme({ id: 's1' });
    const state: FakeState = {
      saved: [],
      schemes: new Map([[scheme.id, scheme]]),
    };
    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      now: () => NOW,
    });

    await service.saveScheme('user-1', 's1');
    expect(state.saved).toHaveLength(1);
    expect(state.saved[0].status).toBe('Saved');
    expect(state.saved[0].appliedAt).toBeNull();
  });

  it('is idempotent for a scheme already saved', async () => {
    const scheme = makeScheme({ id: 's1' });
    const state: FakeState = {
      saved: [{ ...makeSaved({ schemeId: 's1' }), scheme }],
      schemes: new Map([[scheme.id, scheme]]),
    };
    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      now: () => NOW,
    });

    await service.saveScheme('user-1', 's1');
    expect(state.saved).toHaveLength(1);
  });

  it('throws SavedSchemeLimitExceededError when the citizen is at the 100-scheme cap (Req 10.1)', async () => {
    const schemes = Array.from({ length: MAX_SAVED_SCHEMES }, (_, i) =>
      makeScheme({ id: `s${i}` }),
    );
    const newScheme = makeScheme({ id: 'overflow' });
    const state: FakeState = {
      saved: schemes.map((scheme) => ({
        ...makeSaved({ schemeId: scheme.id }),
        scheme,
      })),
      schemes: new Map([
        ...schemes.map((s) => [s.id, s] as const),
        [newScheme.id, newScheme],
      ]),
    };

    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      now: () => NOW,
    });

    await expect(service.saveScheme('user-1', 'overflow')).rejects.toThrow(
      SavedSchemeLimitExceededError,
    );
    expect(state.saved).toHaveLength(MAX_SAVED_SCHEMES);
  });

  it('throws SchemeNotFoundError when the scheme does not exist', async () => {
    const state: FakeState = { saved: [], schemes: new Map() };
    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      now: () => NOW,
    });
    await expect(service.saveScheme('user-1', 'missing')).rejects.toThrow(
      SchemeNotFoundError,
    );
  });

  it('rejects empty arguments', async () => {
    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma({ saved: [], schemes: new Map() }),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      now: () => NOW,
    });
    await expect(service.saveScheme('', 's1')).rejects.toThrow(TypeError);
    await expect(service.saveScheme('user-1', '')).rejects.toThrow(TypeError);
  });
});

// ─── calculateEstimatedBenefitValue (instance pass-through) ─────────────────

describe('BenefitsDashboardService.calculateEstimatedBenefitValue', () => {
  it('exposes the pure helper as an instance method (parity with design interface)', () => {
    const service = new BenefitsDashboardService({
      prisma: makeFakePrisma({ saved: [], schemes: new Map() }),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      now: () => NOW,
    });

    const schemes = [
      makeScheme({ id: 's1', benefitType: 'monetary', benefitAmount: 1000 }),
      makeScheme({ id: 's2', benefitType: 'monetary', benefitAmount: 500 }),
    ];
    expect(service.calculateEstimatedBenefitValue(schemes)).toBe(1500);
  });
});
