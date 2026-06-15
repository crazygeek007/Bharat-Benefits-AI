/**
 * Property-based tests for ineligible-scheme exclusion in the
 * Recommendation Engine.
 *
 * **Property 10: Ineligible Scheme Exclusion from Recommendations**
 * **Validates: Requirements 5.4**
 *
 * Property statement (from design.md):
 * "For any citizen and any scheme for which the Eligibility_Engine returns
 * 'Not Eligible', that scheme SHALL NOT appear in the citizen's
 * recommendation list."
 *
 * The tests below exercise the property at three levels:
 *   1. Pure: `buildRecommendation` returns null for any scheme that the
 *      Eligibility Engine classifies as Not Eligible.
 *   2. End-to-end: `RecommendationEngine.generateRecommendations` (driven
 *      against a fake Prisma client) never surfaces a Not Eligible scheme
 *      even when the universe of schemes mixes eligible and ineligible
 *      criteria.
 *   3. Inverse: schemes that the Eligibility Engine classifies as Eligible
 *      and that produce a positive Match_Score remain in the output (the
 *      exclusion rule does not over-prune).
 *
 * Smart arbitraries are derived per-profile so that each generated scheme is
 * deterministically eligible or ineligible relative to the profile under
 * test. This avoids relying on probabilistic ineligibility from random
 * numeric thresholds.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  PROFILE_CONSTRAINTS,
  INDIAN_STATES,
  type UserProfile,
  type Scheme,
  type EligibilityCriterion,
  type Gender,
  type Occupation,
  type CasteCategory,
  type MaritalStatus,
  type EducationLevel,
  type SupportedLanguage,
} from '@bharat-benefits/shared';
import {
  RecommendationEngine,
  buildRecommendation,
  type RecommendationEnginePrisma,
} from './recommendation-engine';
import { calculateEligibility } from '../eligibility';

const NUM_RUNS = 150;

// ─── Scheme builder ──────────────────────────────────────────────────────────

/**
 * Builds a minimal `Scheme` around a list of criteria and an id. Only fields
 * the recommendation/eligibility engines actually read are non-default; the
 * rest exist purely to satisfy the type contract.
 */
function makeScheme(
  criteria: EligibilityCriterion[],
  id: string,
  overrides: Partial<Scheme> = {},
): Scheme {
  return {
    id,
    name: `Test Scheme ${id}`,
    description: `Description for ${id}`,
    ministry: 'Test Ministry',
    state: null,
    category: 'Education',
    sourceUrl: `https://example.gov.in/${id}`,
    benefitType: 'monetary',
    benefitAmount: 1000,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: null,
    eligibilityCriteria: criteria,
    benefits: [],
    applicationSteps: null,
    requiredDocuments: null,
    // trustScore must be ≥ 60 so the engine's `findMany` filter does not
    // hide the scheme before exclusion can be tested.
    trustScore: 80,
    verified: true,
    discoveredAt: new Date('2024-01-01T00:00:00Z'),
    lastVerifiedAt: new Date('2024-01-02T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

// ─── Profile arbitraries ─────────────────────────────────────────────────────

const arbGender = fc.constantFrom<Gender>(
  ...(PROFILE_CONSTRAINTS.gender as Gender[]),
);
const arbOccupation = fc.constantFrom<Occupation>(
  ...(PROFILE_CONSTRAINTS.occupation as Occupation[]),
);
const arbCaste = fc.constantFrom<CasteCategory>(
  ...(PROFILE_CONSTRAINTS.caste as CasteCategory[]),
);
const arbMarital = fc.constantFrom<MaritalStatus>(
  ...(PROFILE_CONSTRAINTS.maritalStatus as MaritalStatus[]),
);
const arbEducation = fc.constantFrom<EducationLevel>(
  ...(PROFILE_CONSTRAINTS.education as EducationLevel[]),
);
const arbState = fc.constantFrom(...INDIAN_STATES);
const arbLanguage = fc.constantFrom<SupportedLanguage>(
  'en',
  'hi',
  'bn',
  'ta',
  'te',
  'mr',
);

const arbAge = fc.integer({ min: 0, max: 150 });
const arbIncome = fc.integer({ min: 0, max: 9_999_999_999 });
const arbDependents = fc.integer({ min: 0, max: 20 });

/** Fully populated, valid `UserProfile` (no nullable optional fields). */
const arbValidProfile: fc.Arbitrary<UserProfile> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 32 }),
  userId: fc.string({ minLength: 1, maxLength: 32 }),
  age: arbAge,
  gender: arbGender,
  state: arbState,
  district: fc.option(fc.string(), { nil: null }),
  incomeLevel: arbIncome,
  occupation: arbOccupation,
  educationLevel: arbEducation,
  casteCategory: arbCaste,
  disabilityStatus: fc.boolean(),
  maritalStatus: arbMarital,
  dependents: arbDependents,
  languagePreference: arbLanguage,
  updatedAt: fc.date(),
});

// ─── Smart criterion arbitraries (profile-derived) ───────────────────────────

/**
 * Returns an arbitrary criterion that is GUARANTEED to be unmet by the
 * supplied profile under `calculateEligibility`. Each variant exercises a
 * different operator family so the property test exercises the full
 * exclusion contract.
 */
function arbDefinitelyIneligibleCriterion(
  profile: UserProfile,
): fc.Arbitrary<EligibilityCriterion> {
  return fc.oneof(
    // age must be at least 100 years older than the citizen — impossible
    // because profile.age ≤ 150 and the threshold is profile.age + 100 ≥ 100.
    fc.constant({
      field: 'age',
      operator: 'gte' as const,
      value: profile.age + 100,
      description: 'age must be impossibly high',
    }),
    // age strictly less than 0 — profile.age ≥ 0 always.
    fc.constant({
      field: 'age',
      operator: 'lt' as const,
      value: 0,
      description: 'age must be negative',
    }),
    // income strictly less than 0 — profile.incomeLevel ≥ 0 always.
    fc.constant({
      field: 'income',
      operator: 'lt' as const,
      value: 0,
      description: 'income must be negative',
    }),
    // income above the validated maximum — profile.incomeLevel ≤ 9_999_999_999.
    fc.constant({
      field: 'income',
      operator: 'gte' as const,
      value: 10_000_000_001,
      description: 'income must exceed validated maximum',
    }),
    // gender must equal a sentinel that no enum value matches.
    fc.constant({
      field: 'gender',
      operator: 'eq' as const,
      value: '__NonExistent__',
      description: 'gender must be a non-existent enum value',
    }),
    // dependents must equal an impossible count.
    fc.constant({
      field: 'dependents',
      operator: 'eq' as const,
      value: 9999,
      description: 'dependents must be 9999',
    }),
  );
}

/**
 * Returns an arbitrary criterion that is GUARANTEED to be met by the supplied
 * profile under `calculateEligibility`. Used by the inverse property to
 * confirm the exclusion rule does not over-prune.
 */
function arbDefinitelyEligibleCriterion(
  profile: UserProfile,
): fc.Arbitrary<EligibilityCriterion> {
  return fc.oneof(
    fc.constant({
      field: 'age',
      operator: 'gte' as const,
      value: 0,
      description: 'age must be ≥ 0',
    }),
    fc.constant({
      field: 'income',
      operator: 'gte' as const,
      value: 0,
      description: 'income must be ≥ 0',
    }),
    fc.constant({
      field: 'gender',
      operator: 'eq' as const,
      value: profile.gender,
      description: 'gender must match the citizen',
    }),
    fc.constant({
      field: 'state',
      operator: 'eq' as const,
      value: profile.state,
      description: 'state must match the citizen',
    }),
  );
}

// ─── Combined arbitraries ────────────────────────────────────────────────────

/**
 * Profile + a single ineligible scheme — used for the unit-level property.
 */
const arbProfileAndIneligibleScheme: fc.Arbitrary<{
  profile: UserProfile;
  scheme: Scheme;
}> = arbValidProfile.chain((profile) =>
  arbDefinitelyIneligibleCriterion(profile).map((criterion) => ({
    profile,
    scheme: makeScheme([criterion], 'ineligible-scheme'),
  })),
);

type SchemeKind = 'eligible' | 'ineligible';

/**
 * Profile + a mixed list of clearly-eligible and clearly-ineligible schemes.
 * Used for the end-to-end exclusion property. Schemes are tagged with their
 * expected eligibility kind so the test can independently verify the
 * post-exclusion result without re-running the eligibility engine inside
 * the generator.
 */
const arbProfileAndMixedSchemes: fc.Arbitrary<{
  profile: UserProfile;
  schemes: Scheme[];
}> = arbValidProfile.chain((profile) => {
  const arbTaggedCriterion: fc.Arbitrary<{
    kind: SchemeKind;
    criterion: EligibilityCriterion;
  }> = fc.oneof(
    arbDefinitelyEligibleCriterion(profile).map((criterion) => ({
      kind: 'eligible' as SchemeKind,
      criterion,
    })),
    arbDefinitelyIneligibleCriterion(profile).map((criterion) => ({
      kind: 'ineligible' as SchemeKind,
      criterion,
    })),
  );

  return fc
    .array(arbTaggedCriterion, { minLength: 1, maxLength: 20 })
    .map((tagged) => ({
      profile,
      schemes: tagged.map((t, i) =>
        makeScheme([t.criterion], `scheme-${t.kind}-${i}`),
      ),
    }));
});

/**
 * Profile + a small list of all-eligible schemes (≤ 30 entries so the 50-cap
 * never engages). Used for the inverse property.
 */
const arbProfileAndEligibleSchemes: fc.Arbitrary<{
  profile: UserProfile;
  schemes: Scheme[];
}> = arbValidProfile.chain((profile) =>
  fc
    .array(arbDefinitelyEligibleCriterion(profile), {
      minLength: 1,
      maxLength: 30,
    })
    .map((criteria) => ({
      profile,
      schemes: criteria.map((c, i) => makeScheme([c], `scheme-eligible-${i}`)),
    })),
);

// ─── Fake Prisma client (mirrors the engine's filter contract) ───────────────

function fakeDb(profile: UserProfile, schemes: Scheme[]): RecommendationEnginePrisma {
  return {
    userProfile: {
      async findUnique({ where }) {
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

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 10: Ineligible Scheme Exclusion from Recommendations', () => {
  // (1) Pure / unit-level: buildRecommendation returns null for any scheme
  // the eligibility engine classifies as Not Eligible.
  it('buildRecommendation returns null for Not Eligible schemes (Req 5.4)', () => {
    fc.assert(
      fc.property(arbProfileAndIneligibleScheme, ({ profile, scheme }) => {
        // Sanity: the criterion is genuinely unmet.
        expect(calculateEligibility(profile, scheme).status).toBe('Not Eligible');
        // Property under test.
        expect(buildRecommendation(profile, scheme, profile.state)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // (2) End-to-end exclusion: across a mixed universe of schemes, no Not
  // Eligible scheme appears in the engine's output.
  it('generateRecommendations never returns a Not Eligible scheme (Req 5.4)', async () => {
    await fc.assert(
      fc.asyncProperty(arbProfileAndMixedSchemes, async ({ profile, schemes }) => {
        const engine = new RecommendationEngine(fakeDb(profile, schemes));
        const recs = await engine.generateRecommendations(profile.userId);

        // No recommended scheme can re-evaluate to Not Eligible.
        for (const rec of recs) {
          const scheme = schemes.find((s) => s.id === rec.schemeId);
          expect(scheme, `recommendation references unknown scheme ${rec.schemeId}`).toBeDefined();
          const reEval = calculateEligibility(profile, scheme!);
          expect(reEval.status).not.toBe('Not Eligible');
        }

        // Stronger: every ineligible scheme in the input is absent from the output.
        const recommendedIds = new Set(recs.map((r) => r.schemeId));
        const ineligibleIds = schemes
          .filter((s) => calculateEligibility(profile, s).status === 'Not Eligible')
          .map((s) => s.id);
        for (const id of ineligibleIds) {
          expect(recommendedIds.has(id)).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // (3) Inverse: the exclusion rule does not over-prune. Schemes that are
  // Eligible (and therefore have a positive Match_Score thanks to the
  // eligibility component contributing +60) all appear in the output when
  // the list size stays within the 50-cap.
  it('Eligible schemes are not excluded from the output', async () => {
    await fc.assert(
      fc.asyncProperty(arbProfileAndEligibleSchemes, async ({ profile, schemes }) => {
        const engine = new RecommendationEngine(fakeDb(profile, schemes));
        const recs = await engine.generateRecommendations(profile.userId);

        // Sanity: every input scheme is genuinely Eligible for this profile.
        for (const s of schemes) {
          expect(calculateEligibility(profile, s).status).toBe('Eligible');
        }

        // With ≤ 30 schemes the 50-cap cannot engage, so every eligible
        // scheme must appear in the output.
        const recommendedIds = new Set(recs.map((r) => r.schemeId));
        for (const s of schemes) {
          expect(recommendedIds.has(s.id)).toBe(true);
        }

        // And every recommendation has a positive Match_Score (the
        // eligibility component contributes +60 for Eligible schemes).
        for (const rec of recs) {
          expect(rec.matchScore).toBeGreaterThan(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
