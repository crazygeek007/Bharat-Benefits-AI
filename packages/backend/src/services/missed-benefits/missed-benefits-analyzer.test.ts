/**
 * Unit tests for the Missed Benefits Analyzer.
 *
 * Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6.
 *
 * Covers:
 *   - `isMissed` predicate over the full input domain (the pure helper
 *     exported for Property test 14.4).
 *   - `identifyMissedSchemes` returns schemes the citizen was eligible for,
 *     whose deadline passed, and that were not marked Applied.
 *   - Excludes schemes the citizen marked as Applied (Req 15.1).
 *   - Excludes ineligible schemes.
 *   - Excludes schemes with future deadlines.
 *   - `calculateMissedBenefitsValue` sums monetary benefits only (Req
 *     15.2 / 15.6).
 *   - `getSummary` aggregates count + monetary value + scheme list.
 *   - `notifyOnReopening` fans out one notification per non-Applied
 *     citizen (Req 15.4).
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  EligibilityResult,
  SavedScheme,
  Scheme,
  UserProfile,
} from '@bharat-benefits/shared';
import {
  MissedBenefitsAnalyzer,
  isMissed,
  sumMonetaryMissedBenefits,
  type EligibilityCalculator,
  type MissedBenefitsPrisma,
} from './missed-benefits-analyzer';
import type {
  DeliveryWithRetryResult,
  NotificationService,
  OutboundNotification,
} from '../notifications/notification-service';

// ─── Test fixtures ───────────────────────────────────────────────────────────

const NOW = new Date('2024-06-15T12:00:00Z');
const DEADLINE_PAST = new Date('2024-05-01T00:00:00Z');
const DEADLINE_FUTURE = new Date('2024-12-31T23:59:59Z');

function makeScheme(overrides: Partial<Scheme> = {}): Scheme {
  return {
    id: 'scheme-1',
    name: 'Sample Scheme',
    description: 'desc',
    ministry: 'Ministry of Test',
    state: null,
    category: 'Education',
    sourceUrl: 'https://example.gov.in/test',
    benefitType: 'monetary',
    benefitAmount: 1000,
    deadline: DEADLINE_PAST,
    applicationMode: 'online',
    applicationUrl: null,
    eligibilityCriteria: [],
    benefits: [{ type: 'monetary', amount: 1000, description: 'cash' }],
    applicationSteps: null,
    requiredDocuments: null,
    trustScore: 80,
    verified: true,
    discoveredAt: DEADLINE_PAST,
    lastVerifiedAt: DEADLINE_PAST,
    updatedAt: DEADLINE_PAST,
    ...overrides,
  };
}

function makeSaved(overrides: Partial<SavedScheme> = {}): SavedScheme {
  return {
    id: `saved-${overrides.schemeId ?? 'x'}-${overrides.userId ?? 'u'}`,
    userId: 'user-1',
    schemeId: 'scheme-1',
    status: 'Saved',
    savedAt: DEADLINE_PAST,
    appliedAt: null,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    userId: 'user-1',
    age: 30,
    gender: 'Male',
    state: 'Karnataka',
    district: null,
    incomeLevel: 100000,
    occupation: null,
    educationLevel: null,
    casteCategory: null,
    disabilityStatus: null,
    maritalStatus: null,
    dependents: null,
    languagePreference: null,
    ...overrides,
  } as unknown as UserProfile;
}

function eligibleResult(metNames: string[] = ['age']): EligibilityResult {
  return {
    status: 'Eligible',
    metCriteria: metNames.map((n) => ({
      criterionName: n,
      requirement: `${n} criterion`,
      profileValue: 'value',
      met: true,
    })),
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
      {
        criterionName: 'age',
        requirement: 'age >= 60',
        profileValue: 30,
        met: false,
      },
    ],
    unevaluatedCriteria: [],
    missingProfileFields: [],
  };
}

// ─── In-memory Prisma fake ──────────────────────────────────────────────────

interface FakeState {
  profiles: Map<string, UserProfile>;
  schemes: Scheme[];
  saved: SavedScheme[];
}

function makeFakePrisma(state: FakeState): MissedBenefitsPrisma {
  return {
    scheme: {
      async findMany() {
        // Caller is responsible for re-applying the deadline filter — we
        // return everything to exercise the analyzer's defensive in-memory
        // filter.
        return [...state.schemes];
      },
      async findUnique({ where }) {
        return state.schemes.find((s) => s.id === where.id) ?? null;
      },
    },
    savedScheme: {
      async findMany({ where }) {
        return state.saved.filter((s) => {
          if (where.userId !== undefined && s.userId !== where.userId) return false;
          if (where.schemeId !== undefined && s.schemeId !== where.schemeId) return false;
          return true;
        });
      },
    },
    userProfile: {
      async findUnique({ where }) {
        return state.profiles.get(where.userId) ?? null;
      },
    },
  };
}

function makeFakeEligibilityEngine(
  results: Map<string, EligibilityResult>,
  fallback: EligibilityResult = notEligibleResult(),
): EligibilityCalculator {
  return {
    calculateEligibility(_profile, scheme) {
      return results.get(scheme.id) ?? fallback;
    },
  };
}

// ─── isMissed pure helper ───────────────────────────────────────────────────

describe('isMissed', () => {
  it('flags scheme with passed deadline, no save record, eligible profile', () => {
    expect(
      isMissed(
        { deadline: DEADLINE_PAST },
        null,
        { status: 'Eligible' },
        NOW,
      ),
    ).toBe(true);
  });

  it('flags scheme when saved but not Applied (status=Saved)', () => {
    expect(
      isMissed(
        { deadline: DEADLINE_PAST },
        { status: 'Saved' },
        { status: 'Eligible' },
        NOW,
      ),
    ).toBe(true);
  });

  it('does not flag scheme when citizen marked Applied (Req 15.1)', () => {
    expect(
      isMissed(
        { deadline: DEADLINE_PAST },
        { status: 'Applied' },
        { status: 'Eligible' },
        NOW,
      ),
    ).toBe(false);
  });

  it('does not flag scheme with deadline in the future', () => {
    expect(
      isMissed(
        { deadline: DEADLINE_FUTURE },
        null,
        { status: 'Eligible' },
        NOW,
      ),
    ).toBe(false);
  });

  it('does not flag scheme with null deadline (rolling window per Req 10.7)', () => {
    expect(
      isMissed({ deadline: null }, null, { status: 'Eligible' }, NOW),
    ).toBe(false);
  });

  it('does not flag scheme when citizen was Not Eligible', () => {
    expect(
      isMissed(
        { deadline: DEADLINE_PAST },
        null,
        { status: 'Not Eligible' },
        NOW,
      ),
    ).toBe(false);
  });

  it('does not flag scheme when citizen was Partially Eligible', () => {
    expect(
      isMissed(
        { deadline: DEADLINE_PAST },
        null,
        { status: 'Partially Eligible' },
        NOW,
      ),
    ).toBe(false);
  });

  it('does not flag scheme when eligibility result is null', () => {
    expect(isMissed({ deadline: DEADLINE_PAST }, null, null, NOW)).toBe(false);
  });

  it('does not flag scheme when deadline equals asOf (strict <, not ≤)', () => {
    expect(
      isMissed(
        { deadline: NOW },
        null,
        { status: 'Eligible' },
        NOW,
      ),
    ).toBe(false);
  });
});

// ─── sumMonetaryMissedBenefits ───────────────────────────────────────────────

describe('sumMonetaryMissedBenefits', () => {
  it('sums monetary missed schemes', () => {
    const total = sumMonetaryMissedBenefits([
      { benefitType: 'monetary', benefitAmount: 1000 },
      { benefitType: 'monetary', benefitAmount: 2500 },
    ]);
    expect(total).toBe(3500);
  });

  it('excludes non-monetary missed schemes (Req 15.6)', () => {
    const total = sumMonetaryMissedBenefits([
      { benefitType: 'monetary', benefitAmount: 1000 },
      { benefitType: 'non-monetary', benefitAmount: null },
      { benefitType: 'non-monetary', benefitAmount: 9999 },
    ]);
    expect(total).toBe(1000);
  });

  it('excludes monetary schemes with null amount', () => {
    const total = sumMonetaryMissedBenefits([
      { benefitType: 'monetary', benefitAmount: null },
      { benefitType: 'monetary', benefitAmount: 500 },
    ]);
    expect(total).toBe(500);
  });

  it('ignores malformed amounts (NaN, Infinity, negative)', () => {
    const total = sumMonetaryMissedBenefits([
      { benefitType: 'monetary', benefitAmount: 1000 },
      { benefitType: 'monetary', benefitAmount: Number.NaN },
      { benefitType: 'monetary', benefitAmount: Number.POSITIVE_INFINITY },
      { benefitType: 'monetary', benefitAmount: -50 },
    ]);
    expect(total).toBe(1000);
  });

  it('returns 0 for an empty list', () => {
    expect(sumMonetaryMissedBenefits([])).toBe(0);
  });
});

// ─── identifyMissedSchemes ───────────────────────────────────────────────────

describe('MissedBenefitsAnalyzer.identifyMissedSchemes', () => {
  it('returns schemes the citizen was eligible for, deadline passed, not applied', async () => {
    const scheme = makeScheme({
      id: 's1',
      name: 'Eligible Missed',
      deadline: DEADLINE_PAST,
      benefitType: 'monetary',
      benefitAmount: 5000,
    });
    const state: FakeState = {
      profiles: new Map([['user-1', makeProfile()]]),
      schemes: [scheme],
      saved: [],
    };
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map([['s1', eligibleResult(['age', 'state'])]]),
      ),
    });

    const missed = await analyzer.identifyMissedSchemes('user-1', NOW);
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({
      schemeId: 's1',
      schemeName: 'Eligible Missed',
      benefitAmount: 5000,
      benefitType: 'monetary',
      deadline: DEADLINE_PAST,
      metCriteria: ['age', 'state'],
    });
  });

  it('excludes schemes the citizen marked as Applied (Req 15.1)', async () => {
    const scheme = makeScheme({ id: 's1', deadline: DEADLINE_PAST });
    const state: FakeState = {
      profiles: new Map([['user-1', makeProfile()]]),
      schemes: [scheme],
      saved: [
        makeSaved({
          userId: 'user-1',
          schemeId: 's1',
          status: 'Applied',
          appliedAt: new Date('2024-04-15T00:00:00Z'),
        }),
      ],
    };
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map([['s1', eligibleResult()]]),
      ),
    });

    const missed = await analyzer.identifyMissedSchemes('user-1', NOW);
    expect(missed).toEqual([]);
  });

  it('excludes ineligible schemes', async () => {
    const eligibleScheme = makeScheme({ id: 's1', deadline: DEADLINE_PAST });
    const ineligibleScheme = makeScheme({
      id: 's2',
      deadline: DEADLINE_PAST,
      name: 'Ineligible',
    });
    const state: FakeState = {
      profiles: new Map([['user-1', makeProfile()]]),
      schemes: [eligibleScheme, ineligibleScheme],
      saved: [],
    };
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map([
          ['s1', eligibleResult()],
          ['s2', notEligibleResult()],
        ]),
      ),
    });

    const missed = await analyzer.identifyMissedSchemes('user-1', NOW);
    expect(missed.map((m) => m.schemeId)).toEqual(['s1']);
  });

  it('excludes schemes with future deadlines', async () => {
    const futureScheme = makeScheme({
      id: 's-future',
      deadline: DEADLINE_FUTURE,
    });
    const pastScheme = makeScheme({ id: 's-past', deadline: DEADLINE_PAST });
    const state: FakeState = {
      profiles: new Map([['user-1', makeProfile()]]),
      schemes: [futureScheme, pastScheme],
      saved: [],
    };
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map([
          ['s-future', eligibleResult()],
          ['s-past', eligibleResult()],
        ]),
      ),
    });

    const missed = await analyzer.identifyMissedSchemes('user-1', NOW);
    expect(missed.map((m) => m.schemeId)).toEqual(['s-past']);
  });

  it('excludes schemes with null deadlines (rolling window per Req 10.7)', async () => {
    const rollingScheme = makeScheme({ id: 's-roll', deadline: null });
    const state: FakeState = {
      profiles: new Map([['user-1', makeProfile()]]),
      schemes: [rollingScheme],
      saved: [],
    };
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map([['s-roll', eligibleResult()]]),
      ),
    });

    const missed = await analyzer.identifyMissedSchemes('user-1', NOW);
    expect(missed).toEqual([]);
  });

  it('returns benefitAmount=null for non-monetary missed schemes (Req 15.6)', async () => {
    const scheme = makeScheme({
      id: 's-skill',
      deadline: DEADLINE_PAST,
      benefitType: 'non-monetary',
      benefitAmount: null,
      name: 'Skill Training',
    });
    const state: FakeState = {
      profiles: new Map([['user-1', makeProfile()]]),
      schemes: [scheme],
      saved: [],
    };
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map([['s-skill', eligibleResult()]]),
      ),
    });

    const missed = await analyzer.identifyMissedSchemes('user-1', NOW);
    expect(missed).toHaveLength(1);
    expect(missed[0].benefitAmount).toBeNull();
    expect(missed[0].benefitType).toBe('non-monetary');
  });

  it('returns empty when the citizen has no profile', async () => {
    const scheme = makeScheme({ id: 's1', deadline: DEADLINE_PAST });
    const state: FakeState = {
      profiles: new Map(),
      schemes: [scheme],
      saved: [],
    };
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map([['s1', eligibleResult()]]),
      ),
    });

    const missed = await analyzer.identifyMissedSchemes('user-1', NOW);
    expect(missed).toEqual([]);
  });

  it('rejects empty userId', async () => {
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma({
        profiles: new Map(),
        schemes: [],
        saved: [],
      }),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
    });
    await expect(analyzer.identifyMissedSchemes('', NOW)).rejects.toThrow(
      TypeError,
    );
  });
});

// ─── calculateMissedBenefitsValue ────────────────────────────────────────────

describe('MissedBenefitsAnalyzer.calculateMissedBenefitsValue', () => {
  it('sums only monetary benefits (Req 15.2 / 15.6)', () => {
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma({
        profiles: new Map(),
        schemes: [],
        saved: [],
      }),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
    });

    const total = analyzer.calculateMissedBenefitsValue([
      {
        schemeId: 's1',
        schemeName: 'Cash Aid',
        benefitType: 'monetary',
        benefitAmount: 1000,
        deadline: DEADLINE_PAST,
        metCriteria: [],
      },
      {
        schemeId: 's2',
        schemeName: 'Skill Training',
        benefitType: 'non-monetary',
        benefitAmount: null,
        deadline: DEADLINE_PAST,
        metCriteria: [],
      },
      {
        schemeId: 's3',
        schemeName: 'Stipend',
        benefitType: 'monetary',
        benefitAmount: 2500,
        deadline: DEADLINE_PAST,
        metCriteria: [],
      },
    ]);
    expect(total).toBe(3500);
  });
});

// ─── getSummary ──────────────────────────────────────────────────────────────

describe('MissedBenefitsAnalyzer.getSummary', () => {
  it('aggregates count + monetary value + scheme rows (Req 15.5)', async () => {
    const monetary = makeScheme({
      id: 's1',
      name: 'Cash Aid',
      deadline: DEADLINE_PAST,
      benefitType: 'monetary',
      benefitAmount: 1000,
    });
    const nonMonetary = makeScheme({
      id: 's2',
      name: 'Skill Training',
      deadline: DEADLINE_PAST,
      benefitType: 'non-monetary',
      benefitAmount: null,
    });
    const state: FakeState = {
      profiles: new Map([['user-1', makeProfile()]]),
      schemes: [monetary, nonMonetary],
      saved: [],
    };
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(
        new Map([
          ['s1', eligibleResult(['age', 'income'])],
          ['s2', eligibleResult(['age'])],
        ]),
      ),
    });

    const summary = await analyzer.getSummary('user-1', NOW);
    expect(summary.totalCount).toBe(2);
    expect(summary.totalMonetaryValue).toBe(1000);
    expect(summary.schemes.map((s) => s.schemeId).sort()).toEqual(['s1', 's2']);
    const cashRow = summary.schemes.find((s) => s.schemeId === 's1')!;
    expect(cashRow.metCriteria).toEqual(['age', 'income']);
    expect(cashRow.deadline).toEqual(DEADLINE_PAST);
    expect(cashRow.benefitAmount).toBe(1000);
  });

  it('returns a zeroed summary when the citizen has no missed schemes', async () => {
    const state: FakeState = {
      profiles: new Map([['user-1', makeProfile()]]),
      schemes: [],
      saved: [],
    };
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
    });

    const summary = await analyzer.getSummary('user-1', NOW);
    expect(summary).toEqual({
      totalCount: 0,
      totalMonetaryValue: 0,
      schemes: [],
    });
  });
});

// ─── notifyOnReopening ───────────────────────────────────────────────────────

describe('MissedBenefitsAnalyzer.notifyOnReopening', () => {
  function makeFakeNotificationService() {
    const calls: OutboundNotification[] = [];
    const successDelivery: DeliveryWithRetryResult = {
      finalResult: { success: true, channel: 'email', error: null },
      attempts: [],
    };
    const fake: Pick<NotificationService, 'deliverWithRetry'> = {
      async deliverWithRetry(notification: OutboundNotification) {
        calls.push(notification);
        return successDelivery;
      },
    };
    return { fake, calls };
  }

  it('notifies every citizen who saved the scheme but did not apply (Req 15.4)', async () => {
    const scheme = makeScheme({
      id: 's-reopen',
      name: 'Reopened Scheme',
      deadline: DEADLINE_FUTURE, // already reopened
      sourceUrl: 'https://example.gov.in/reopened',
    });
    const state: FakeState = {
      profiles: new Map(),
      schemes: [scheme],
      saved: [
        makeSaved({ userId: 'user-1', schemeId: 's-reopen', status: 'Saved' }),
        makeSaved({ userId: 'user-2', schemeId: 's-reopen', status: 'Saved' }),
        makeSaved({
          userId: 'user-3',
          schemeId: 's-reopen',
          status: 'Applied',
          appliedAt: new Date('2024-04-01T00:00:00Z'),
        }),
        // unrelated scheme — must not receive a notification
        makeSaved({ userId: 'user-99', schemeId: 'other', status: 'Saved' }),
      ],
    };
    const { fake: notify, calls } = makeFakeNotificationService();
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      notificationService: notify,
      recipientEmailFor: (userId) => `${userId}@example.com`,
    });

    await analyzer.notifyOnReopening('s-reopen');

    expect(calls).toHaveLength(2);
    const recipientUserIds = calls.map((c) => c.userId).sort();
    expect(recipientUserIds).toEqual(['user-1', 'user-2']);
    for (const call of calls) {
      expect(call.type).toBe('reopening');
      expect(call.schemeId).toBe('s-reopen');
      expect(call.recipientEmail).toBe(`${call.userId}@example.com`);
      expect(call.subject).toContain('Reopened Scheme');
      expect(call.body).toContain('https://example.gov.in/reopened');
      expect(call.payload?.sourceUrl).toBe('https://example.gov.in/reopened');
    }
  });

  it('is a silent no-op when no NotificationService is configured', async () => {
    const scheme = makeScheme({ id: 's-reopen' });
    const state: FakeState = {
      profiles: new Map(),
      schemes: [scheme],
      saved: [
        makeSaved({ userId: 'user-1', schemeId: 's-reopen', status: 'Saved' }),
      ],
    };
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
    });

    await expect(analyzer.notifyOnReopening('s-reopen')).resolves.toBeUndefined();
  });

  it('does nothing when the scheme cannot be found', async () => {
    const state: FakeState = {
      profiles: new Map(),
      schemes: [],
      saved: [
        makeSaved({ userId: 'user-1', schemeId: 'missing', status: 'Saved' }),
      ],
    };
    const { fake: notify, calls } = makeFakeNotificationService();
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma(state),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
      notificationService: notify,
    });

    await analyzer.notifyOnReopening('missing');
    expect(calls).toEqual([]);
  });

  it('rejects empty schemeId', async () => {
    const analyzer = new MissedBenefitsAnalyzer({
      prisma: makeFakePrisma({
        profiles: new Map(),
        schemes: [],
        saved: [],
      }),
      eligibilityEngine: makeFakeEligibilityEngine(new Map()),
    });

    await expect(analyzer.notifyOnReopening('')).rejects.toThrow(TypeError);
  });
});

// ─── BenefitsDashboard wiring smoke test ────────────────────────────────────

describe('BenefitsDashboard wiring (Req 15.5)', () => {
  it('populates missedBenefitsSummary when the analyzer is injected', async () => {
    // Lazy import so the dashboard module loads with our DI in place.
    const {
      BenefitsDashboardService,
    } = await import('../benefits-dashboard/benefits-dashboard-service');

    const fakeAnalyzer = {
      getSummary: vi.fn(async (_userId: string) => ({
        totalCount: 2,
        totalMonetaryValue: 7500,
        schemes: [
          {
            schemeId: 's1',
            schemeName: 'Cash Aid',
            benefitAmount: 5000,
            deadline: DEADLINE_PAST,
            metCriteria: ['age'],
          },
          {
            schemeId: 's2',
            schemeName: 'Stipend',
            benefitAmount: 2500,
            deadline: DEADLINE_PAST,
            metCriteria: ['income'],
          },
        ],
      })),
    };

    const service = new BenefitsDashboardService({
      prisma: {
        savedScheme: {
          async findMany() {
            return [];
          },
          async count() {
            return 0;
          },
          async findUnique() {
            return null;
          },
          async create() {
            throw new Error('not used');
          },
          async update() {
            throw new Error('not used');
          },
        },
        scheme: {
          async findUnique() {
            return null;
          },
        },
      },
      eligibilityEngine: {
        async recalculateAllSavedSchemes() {
          return [];
        },
      },
      missedBenefitsAnalyzer: fakeAnalyzer,
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    expect(fakeAnalyzer.getSummary).toHaveBeenCalledWith('user-1');
    expect(dashboard.missedBenefitsSummary.totalCount).toBe(2);
    expect(dashboard.missedBenefitsSummary.totalMonetaryValue).toBe(7500);
    expect(dashboard.missedBenefitsSummary.schemes).toHaveLength(2);
  });

  it('falls back to a zeroed summary when the analyzer throws', async () => {
    const {
      BenefitsDashboardService,
    } = await import('../benefits-dashboard/benefits-dashboard-service');

    const fakeAnalyzer = {
      getSummary: vi.fn(async () => {
        throw new Error('analyzer broken');
      }),
    };

    const service = new BenefitsDashboardService({
      prisma: {
        savedScheme: {
          async findMany() {
            return [];
          },
          async count() {
            return 0;
          },
          async findUnique() {
            return null;
          },
          async create() {
            throw new Error('not used');
          },
          async update() {
            throw new Error('not used');
          },
        },
        scheme: {
          async findUnique() {
            return null;
          },
        },
      },
      eligibilityEngine: {
        async recalculateAllSavedSchemes() {
          return [];
        },
      },
      missedBenefitsAnalyzer: fakeAnalyzer,
      now: () => NOW,
    });

    const dashboard = await service.getDashboard('user-1');
    expect(dashboard.missedBenefitsSummary).toEqual({
      totalCount: 0,
      totalMonetaryValue: 0,
      schemes: [],
    });
  });
});
