/**
 * Unit tests for the Eligibility Engine.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 3.3.
 *
 * Covers:
 *   - All operator semantics (eq / neq / gt / gte / lt / lte / in / between).
 *   - Status determination (Eligible / Partially Eligible / Not Eligible).
 *   - Missing-field handling produces `unevaluatedCriteria` and
 *     `missingProfileFields`.
 *   - `recalculateAllSavedSchemes` against a fake Prisma client.
 *   - Edge cases: empty criteria, single criterion, mixed buckets.
 */

import { describe, it, expect } from 'vitest';
import type {
  EligibilityCriterion,
  Scheme,
  UserProfile,
} from '@bharat-benefits/shared';
import {
  EligibilityEngine,
  calculateEligibility,
  evaluateCriterion,
  getProfileFieldValue,
  type EligibilityEnginePrisma,
} from './eligibility-engine';

// ─── Test fixtures ───────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'profile-1',
    userId: 'user-1',
    age: 30,
    gender: 'Female',
    state: 'Karnataka',
    district: 'Bangalore Urban',
    incomeLevel: 250_000,
    occupation: 'Salaried',
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

function makeScheme(overrides: Partial<Scheme> = {}): Scheme {
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
  description = `${field} ${operator} ${JSON.stringify(value)}`,
): EligibilityCriterion {
  return { field, operator, value, description };
}

// ─── getProfileFieldValue ────────────────────────────────────────────────────

describe('getProfileFieldValue', () => {
  it('returns canonical profile fields by canonical name', () => {
    const p = makeProfile();
    expect(getProfileFieldValue(p, 'age')).toBe(30);
    expect(getProfileFieldValue(p, 'gender')).toBe('Female');
    expect(getProfileFieldValue(p, 'incomeLevel')).toBe(250_000);
    expect(getProfileFieldValue(p, 'casteCategory')).toBe('General');
  });

  it('resolves common aliases used by official scheme criteria', () => {
    const p = makeProfile();
    expect(getProfileFieldValue(p, 'income')).toBe(250_000);
    expect(getProfileFieldValue(p, 'caste')).toBe('General');
    expect(getProfileFieldValue(p, 'education')).toBe('Graduate');
    expect(getProfileFieldValue(p, 'state_of_residence')).toBe('Karnataka');
    expect(getProfileFieldValue(p, 'household_income')).toBe(250_000);
  });

  it('returns undefined for unknown field names', () => {
    expect(getProfileFieldValue(makeProfile(), 'salary_in_usd')).toBeUndefined();
    expect(getProfileFieldValue(makeProfile(), '')).toBeUndefined();
  });

  it('returns undefined when the profile attribute is null/undefined', () => {
    const p = makeProfile({ occupation: null, dependents: null });
    expect(getProfileFieldValue(p, 'occupation')).toBeNull();
    expect(getProfileFieldValue(p, 'dependents')).toBeNull();
  });
});

// ─── evaluateCriterion: operator semantics ───────────────────────────────────

describe('evaluateCriterion — operator semantics', () => {
  it('eq: matches identical primitive values', () => {
    const c = criterion('gender', 'eq', 'Female');
    expect(evaluateCriterion(c, 'Female').met).toBe(true);
    expect(evaluateCriterion(c, 'Male').met).toBe(false);
  });

  it('neq: inverts equality', () => {
    const c = criterion('gender', 'neq', 'Male');
    expect(evaluateCriterion(c, 'Female').met).toBe(true);
    expect(evaluateCriterion(c, 'Male').met).toBe(false);
  });

  it('gt / gte / lt / lte: numeric comparison', () => {
    expect(evaluateCriterion(criterion('age', 'gt', 18), 19).met).toBe(true);
    expect(evaluateCriterion(criterion('age', 'gt', 18), 18).met).toBe(false);

    expect(evaluateCriterion(criterion('age', 'gte', 18), 18).met).toBe(true);
    expect(evaluateCriterion(criterion('age', 'gte', 18), 17).met).toBe(false);

    expect(evaluateCriterion(criterion('income', 'lt', 500_000), 250_000).met).toBe(true);
    expect(evaluateCriterion(criterion('income', 'lt', 500_000), 500_000).met).toBe(false);

    expect(evaluateCriterion(criterion('income', 'lte', 500_000), 500_000).met).toBe(true);
    expect(evaluateCriterion(criterion('income', 'lte', 500_000), 500_001).met).toBe(false);
  });

  it('in: treats criterion.value as an array of acceptable values', () => {
    const c = criterion('caste', 'in', ['SC', 'ST', 'OBC']);
    expect(evaluateCriterion(c, 'SC').met).toBe(true);
    expect(evaluateCriterion(c, 'OBC').met).toBe(true);
    expect(evaluateCriterion(c, 'General').met).toBe(false);
  });

  it('in: treats a non-array criterion.value as no match', () => {
    const c = criterion('caste', 'in', 'SC');
    expect(evaluateCriterion(c, 'SC').met).toBe(false);
  });

  it('between: inclusive numeric range over a [min, max] tuple', () => {
    const c = criterion('age', 'between', [18, 60]);
    expect(evaluateCriterion(c, 18).met).toBe(true);
    expect(evaluateCriterion(c, 60).met).toBe(true);
    expect(evaluateCriterion(c, 30).met).toBe(true);
    expect(evaluateCriterion(c, 17).met).toBe(false);
    expect(evaluateCriterion(c, 61).met).toBe(false);
  });

  it('between: malformed range yields not-met without throwing', () => {
    expect(evaluateCriterion(criterion('age', 'between', [18]), 30).met).toBe(false);
    expect(evaluateCriterion(criterion('age', 'between', 'not-a-tuple'), 30).met).toBe(false);
  });

  it('numeric operators reject non-numeric inputs as not-met', () => {
    expect(evaluateCriterion(criterion('age', 'gt', 18), 'old').met).toBe(false);
  });

  it('reports missingField when profileValue is null or undefined', () => {
    const c = criterion('income', 'lte', 500_000);
    const undef = evaluateCriterion(c, undefined);
    expect(undef.met).toBe(false);
    expect(undef.missingField).toBe('income');

    const nul = evaluateCriterion(c, null);
    expect(nul.missingField).toBe('income');
  });
});

// ─── calculateEligibility: status determination ──────────────────────────────

describe('calculateEligibility — status determination', () => {
  it('returns Eligible with empty buckets when no criteria are defined', () => {
    const result = calculateEligibility(makeProfile(), makeScheme());
    expect(result.status).toBe('Eligible');
    expect(result.metCriteria).toEqual([]);
    expect(result.unmetCriteria).toEqual([]);
    expect(result.unevaluatedCriteria).toEqual([]);
    expect(result.missingProfileFields).toEqual([]);
  });

  it('returns Eligible when every criterion is met', () => {
    const scheme = makeScheme({
      eligibilityCriteria: [
        criterion('age', 'gte', 18),
        criterion('gender', 'in', ['Female', 'Other']),
        criterion('income', 'lte', 500_000),
      ],
    });
    const result = calculateEligibility(makeProfile(), scheme);
    expect(result.status).toBe('Eligible');
    expect(result.metCriteria).toHaveLength(3);
    expect(result.unmetCriteria).toEqual([]);
    expect(result.unevaluatedCriteria).toEqual([]);
  });

  it('returns Not Eligible when at least one criterion is definitively unmet (Req 4.2)', () => {
    const scheme = makeScheme({
      eligibilityCriteria: [
        criterion('age', 'gte', 18, 'Minimum age 18'),
        criterion('income', 'lte', 100_000, 'Income at or below 1 lakh'),
      ],
    });
    const result = calculateEligibility(makeProfile(), scheme);
    expect(result.status).toBe('Not Eligible');
    expect(result.unmetCriteria).toHaveLength(1);
    expect(result.unmetCriteria[0].criterionName).toBe('income');
    expect(result.unmetCriteria[0].requirement).toBe('Income at or below 1 lakh');
    expect(result.unmetCriteria[0].profileValue).toBe(250_000);
  });

  it('returns Partially Eligible when some criteria are met and some are unevaluated (Req 4.3)', () => {
    // Profile is missing optional fields needed by some criteria.
    const profile = makeProfile({ disabilityStatus: null, occupation: null });
    const scheme = makeScheme({
      eligibilityCriteria: [
        criterion('age', 'gte', 18),
        criterion('disabilityStatus', 'eq', true, 'Must be a person with disability'),
        criterion('occupation', 'in', ['Farmer'], 'Must be a Farmer'),
      ],
    });
    const result = calculateEligibility(profile, scheme);
    expect(result.status).toBe('Partially Eligible');
    expect(result.metCriteria).toHaveLength(1);
    expect(result.unmetCriteria).toEqual([]);
    expect(result.unevaluatedCriteria).toHaveLength(2);
    expect(result.missingProfileFields).toEqual(
      expect.arrayContaining(['disabilityStatus', 'occupation']),
    );
  });

  it('treats Not Eligible as dominant over Partially Eligible when both apply', () => {
    const profile = makeProfile({ occupation: null });
    const scheme = makeScheme({
      eligibilityCriteria: [
        criterion('income', 'lte', 100_000), // unmet
        criterion('occupation', 'eq', 'Farmer'), // unevaluated
      ],
    });
    const result = calculateEligibility(profile, scheme);
    expect(result.status).toBe('Not Eligible');
    expect(result.unmetCriteria).toHaveLength(1);
    expect(result.unevaluatedCriteria).toHaveLength(1);
  });

  it('deduplicates missingProfileFields while preserving first-seen order', () => {
    const profile = makeProfile({ occupation: null });
    const scheme = makeScheme({
      eligibilityCriteria: [
        criterion('occupation', 'eq', 'Farmer', 'first'),
        criterion('occupation', 'eq', 'Student', 'second'),
        criterion('age', 'gte', 18),
      ],
    });
    const result = calculateEligibility(profile, scheme);
    expect(result.unevaluatedCriteria).toHaveLength(2);
    expect(result.missingProfileFields).toEqual(['occupation']);
  });

  it('exposes the full requirement text on each evaluation for citizen-facing UI (Req 4.2)', () => {
    const scheme = makeScheme({
      eligibilityCriteria: [
        criterion('age', 'gte', 60, 'Senior citizens (age 60 or above)'),
      ],
    });
    const result = calculateEligibility(makeProfile({ age: 30 }), scheme);
    expect(result.status).toBe('Not Eligible');
    expect(result.unmetCriteria[0].requirement).toBe(
      'Senior citizens (age 60 or above)',
    );
  });

  it('handles a single met criterion as Eligible (edge case)', () => {
    const scheme = makeScheme({
      eligibilityCriteria: [criterion('state', 'eq', 'Karnataka')],
    });
    expect(calculateEligibility(makeProfile(), scheme).status).toBe('Eligible');
  });
});

// ─── EligibilityEngine: recalculateAllSavedSchemes ───────────────────────────

describe('EligibilityEngine.recalculateAllSavedSchemes', () => {
  function fakeDb(
    profile: UserProfile | null,
    schemes: Scheme[],
  ): EligibilityEnginePrisma {
    return {
      userProfile: {
        async findUnique({ where }) {
          if (!profile) return null;
          return profile.userId === where.userId ? profile : null;
        },
      },
      savedScheme: {
        async findMany({ where }) {
          if (!profile || profile.userId !== where.userId) return [];
          return schemes.map((scheme) => ({ scheme }));
        },
      },
    };
  }

  it('returns one EligibilityResult per saved scheme', async () => {
    const profile = makeProfile();
    const eligibleScheme = makeScheme({
      id: 'scheme-eligible',
      eligibilityCriteria: [criterion('age', 'gte', 18)],
    });
    const ineligibleScheme = makeScheme({
      id: 'scheme-ineligible',
      eligibilityCriteria: [criterion('income', 'lte', 100_000)],
    });
    const partialScheme = makeScheme({
      id: 'scheme-partial',
      eligibilityCriteria: [
        criterion('age', 'gte', 18),
        criterion('occupation', 'eq', 'Farmer'),
      ],
    });

    // Profile has occupation 'Salaried' so partialScheme is actually unmet
    // here. Force "unevaluated" by clearing the field.
    const partialProfile = makeProfile({ occupation: null });

    const db = fakeDb(partialProfile, [eligibleScheme, ineligibleScheme, partialScheme]);
    const engine = new EligibilityEngine(db);

    const results = await engine.recalculateAllSavedSchemes(partialProfile.userId);

    expect(results).toHaveLength(3);
    expect(results.find((r) => r.schemeId === 'scheme-eligible')!.result.status).toBe('Eligible');
    expect(results.find((r) => r.schemeId === 'scheme-ineligible')!.result.status).toBe('Not Eligible');
    expect(results.find((r) => r.schemeId === 'scheme-partial')!.result.status).toBe('Partially Eligible');
  });

  it('returns an empty array when the user has no saved schemes', async () => {
    const profile = makeProfile();
    const engine = new EligibilityEngine(fakeDb(profile, []));
    const results = await engine.recalculateAllSavedSchemes(profile.userId);
    expect(results).toEqual([]);
  });

  it('completes well within the 30-second SLA at the saved-scheme cap (Req 3.3)', async () => {
    const profile = makeProfile();
    const schemes: Scheme[] = Array.from({ length: 100 }, (_, i) =>
      makeScheme({
        id: `scheme-${i}`,
        eligibilityCriteria: [
          criterion('age', 'gte', 18),
          criterion('income', 'lte', 1_000_000),
          criterion('state', 'eq', 'Karnataka'),
        ],
      }),
    );
    const engine = new EligibilityEngine(fakeDb(profile, schemes));

    const start = Date.now();
    const results = await engine.recalculateAllSavedSchemes(profile.userId);
    const duration = Date.now() - start;

    expect(results).toHaveLength(100);
    expect(duration).toBeLessThan(30_000);
  });

  it('throws when the userId has no profile (Req 4.5)', async () => {
    const engine = new EligibilityEngine(fakeDb(null, []));
    await expect(engine.recalculateAllSavedSchemes('user-missing')).rejects.toThrow(
      /No user profile found/,
    );
  });

  it('rejects an empty userId', async () => {
    const engine = new EligibilityEngine(fakeDb(null, []));
    await expect(engine.recalculateAllSavedSchemes('')).rejects.toThrow(TypeError);
  });

  it('class methods evaluateCriterion / calculateEligibility are stable pass-throughs', () => {
    const engine = new EligibilityEngine(fakeDb(makeProfile(), []));
    const c = criterion('age', 'gte', 18);
    expect(engine.evaluateCriterion(c, 19)).toEqual(evaluateCriterion(c, 19));

    const scheme = makeScheme({ eligibilityCriteria: [c] });
    expect(engine.calculateEligibility(makeProfile(), scheme)).toEqual(
      calculateEligibility(makeProfile(), scheme),
    );
  });
});
