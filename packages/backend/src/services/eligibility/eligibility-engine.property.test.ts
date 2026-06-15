/**
 * Property-based tests for the Eligibility Engine.
 *
 * **Property 7: Eligibility Calculation Correctness**
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.5**
 *
 * Property statement (from design.md):
 * "For any valid User_Profile and any Scheme with defined eligibility
 * criteria, the Eligibility_Engine SHALL produce a result where:
 *   (a) status is exactly one of {Eligible, Partially Eligible, Not Eligible},
 *   (b) if status is 'Not Eligible' then at least one criterion is listed as
 *       unmet with the criterion requirement and profile value,
 *   (c) if status is 'Partially Eligible' then at least one criterion cannot
 *       be evaluated (due to missing profile data), specific missing profile
 *       fields are identified, and no criterion is definitively unmet, and
 *   (d) if status is 'Eligible' then all criteria are evaluable and met
 *       (or there are no criteria)."
 *
 * These tests use fast-check to verify the universal correctness of
 * `calculateEligibility` across arbitrary valid `UserProfile` and `Scheme`
 * inputs.
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
  calculateEligibility,
  getProfileFieldValue,
} from './eligibility-engine';

const NUM_RUNS = 150;

// ─── Scheme builder ──────────────────────────────────────────────────────────

/**
 * Builds a minimal `Scheme` around a list of criteria. Only
 * `eligibilityCriteria` is exercised by `calculateEligibility`, but the rest
 * of the Scheme shape is required for type-correctness.
 */
function makeScheme(
  criteria: EligibilityCriterion[],
  id = 'test-scheme',
): Scheme {
  return {
    id,
    name: 'Test Scheme',
    description: 'Test scheme description',
    ministry: 'Test Ministry',
    state: null,
    category: 'Education',
    sourceUrl: 'https://example.gov.in/test',
    benefitType: 'monetary',
    benefitAmount: null,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: null,
    eligibilityCriteria: criteria,
    benefits: [],
    applicationSteps: null,
    requiredDocuments: null,
    trustScore: 0,
    verified: true,
    discoveredAt: new Date(0),
    lastVerifiedAt: new Date(0),
    updatedAt: new Date(0),
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

/**
 * Valid `UserProfile` where each optional field is independently nulled with
 * ~50% probability. Required fields (age, gender, state, incomeLevel) remain
 * populated.
 */
const arbProfileMissingFields: fc.Arbitrary<UserProfile> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 32 }),
  userId: fc.string({ minLength: 1, maxLength: 32 }),
  age: arbAge,
  gender: arbGender,
  state: arbState,
  district: fc.option(fc.string(), { nil: null }),
  incomeLevel: arbIncome,
  occupation: fc.option(arbOccupation, { nil: null }),
  educationLevel: fc.option(arbEducation, { nil: null }),
  casteCategory: fc.option(arbCaste, { nil: null }),
  disabilityStatus: fc.option(fc.boolean(), { nil: null }),
  maritalStatus: fc.option(arbMarital, { nil: null }),
  dependents: fc.option(arbDependents, { nil: null }),
  languagePreference: arbLanguage,
  updatedAt: fc.date(),
});

/**
 * Mixed-population profile: 50/50 fully-populated vs. missing-fields. Drives
 * coverage of all three eligibility statuses across runs.
 */
const arbAnyProfile: fc.Arbitrary<UserProfile> = fc.oneof(
  arbValidProfile,
  arbProfileMissingFields,
);

// ─── Criterion arbitraries ───────────────────────────────────────────────────

const arbDescription = fc.string({ minLength: 1, maxLength: 80 });

/**
 * Categorical eq / neq criteria over enum-valued profile fields. Always
 * generates `value` from the field's valid enum so the criterion is
 * meaningful (not vacuously unmet).
 */
const arbCategoricalEqNeq: fc.Arbitrary<EligibilityCriterion> = fc.oneof(
  fc.record({
    field: fc.constant('gender'),
    operator: fc.constantFrom('eq', 'neq'),
    value: arbGender,
    description: arbDescription,
  }),
  fc.record({
    field: fc.constant('casteCategory'),
    operator: fc.constantFrom('eq', 'neq'),
    value: arbCaste,
    description: arbDescription,
  }),
  fc.record({
    field: fc.constant('occupation'),
    operator: fc.constantFrom('eq', 'neq'),
    value: arbOccupation,
    description: arbDescription,
  }),
  fc.record({
    field: fc.constant('maritalStatus'),
    operator: fc.constantFrom('eq', 'neq'),
    value: arbMarital,
    description: arbDescription,
  }),
) as fc.Arbitrary<EligibilityCriterion>;

/** Categorical `in` criteria — value is a non-empty array of valid enum values. */
const arbCategoricalIn: fc.Arbitrary<EligibilityCriterion> = fc.oneof(
  fc.record({
    field: fc.constant('gender'),
    operator: fc.constant('in'),
    value: fc.array(arbGender, { minLength: 1, maxLength: 3 }),
    description: arbDescription,
  }),
  fc.record({
    field: fc.constant('casteCategory'),
    operator: fc.constant('in'),
    value: fc.array(arbCaste, { minLength: 1, maxLength: 4 }),
    description: arbDescription,
  }),
  fc.record({
    field: fc.constant('occupation'),
    operator: fc.constant('in'),
    value: fc.array(arbOccupation, { minLength: 1, maxLength: 7 }),
    description: arbDescription,
  }),
) as fc.Arbitrary<EligibilityCriterion>;

/** Numeric gt / gte / lt / lte criteria over `age` and `income`. */
const arbNumericComparison: fc.Arbitrary<EligibilityCriterion> = fc.oneof(
  fc.record({
    field: fc.constant('age'),
    operator: fc.constantFrom('gt', 'gte', 'lt', 'lte'),
    value: arbAge,
    description: arbDescription,
  }),
  fc.record({
    field: fc.constant('income'),
    operator: fc.constantFrom('gt', 'gte', 'lt', 'lte'),
    value: arbIncome,
    description: arbDescription,
  }),
) as fc.Arbitrary<EligibilityCriterion>;

/** `between` criteria — value is a sorted [min, max] tuple. */
const arbBetween: fc.Arbitrary<EligibilityCriterion> = fc.oneof(
  fc.tuple(arbAge, arbAge, arbDescription).map(
    ([a, b, desc]): EligibilityCriterion => ({
      field: 'age',
      operator: 'between',
      value: [Math.min(a, b), Math.max(a, b)],
      description: desc,
    }),
  ),
  fc.tuple(arbIncome, arbIncome, arbDescription).map(
    ([a, b, desc]): EligibilityCriterion => ({
      field: 'income',
      operator: 'between',
      value: [Math.min(a, b), Math.max(a, b)],
      description: desc,
    }),
  ),
);

/** Any single criterion drawn uniformly from all operator families. */
const arbCriterion: fc.Arbitrary<EligibilityCriterion> = fc.oneof(
  arbCategoricalEqNeq,
  arbCategoricalIn,
  arbNumericComparison,
  arbBetween,
);

/** Minimal scheme wrapping a 0–10 length array of criteria. */
const arbScheme: fc.Arbitrary<Scheme> = fc
  .array(arbCriterion, { minLength: 0, maxLength: 10 })
  .map((criteria) => makeScheme(criteria));

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 7: Eligibility Calculation Correctness', () => {
  // (a) Status enum.
  it('result.status is exactly one of {Eligible, Partially Eligible, Not Eligible}', () => {
    fc.assert(
      fc.property(arbAnyProfile, arbScheme, (profile, scheme) => {
        const result = calculateEligibility(profile, scheme);
        expect(['Eligible', 'Partially Eligible', 'Not Eligible']).toContain(
          result.status,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // (b) Not Eligible invariant.
  it('Not Eligible → unmetCriteria has >=1 entry with non-empty requirement, profileValue, and criterionName', () => {
    fc.assert(
      fc.property(arbAnyProfile, arbScheme, (profile, scheme) => {
        const result = calculateEligibility(profile, scheme);
        if (result.status !== 'Not Eligible') return;

        expect(result.unmetCriteria.length).toBeGreaterThanOrEqual(1);
        for (const entry of result.unmetCriteria) {
          // criterionName: present, non-empty string.
          expect(typeof entry.criterionName).toBe('string');
          expect(entry.criterionName.length).toBeGreaterThan(0);

          // requirement: present, non-empty string (mirrors criterion.description).
          expect(typeof entry.requirement).toBe('string');
          expect(entry.requirement.length).toBeGreaterThan(0);

          // profileValue: present (the citizen-facing value cited in the
          // explanation). Missing values would have routed to
          // `unevaluatedCriteria`, so unmet entries always have a real value.
          expect('profileValue' in entry).toBe(true);
          expect(entry.profileValue).not.toBeNull();
          expect(entry.profileValue).not.toBeUndefined();

          // met flag is correctly false on unmet entries.
          expect(entry.met).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // (c) Partially Eligible invariant.
  it('Partially Eligible → unevaluated >= 1, missingProfileFields non-empty, no unmet, met >= 0', () => {
    fc.assert(
      fc.property(arbAnyProfile, arbScheme, (profile, scheme) => {
        const result = calculateEligibility(profile, scheme);
        if (result.status !== 'Partially Eligible') return;

        expect(result.unevaluatedCriteria.length).toBeGreaterThanOrEqual(1);
        expect(result.missingProfileFields.length).toBeGreaterThanOrEqual(1);
        // Otherwise the engine would have classified the result as Not Eligible.
        expect(result.unmetCriteria.length).toBe(0);
        // met criteria CAN be zero if all criteria are unevaluable due to
        // missing profile fields.
        expect(result.metCriteria.length).toBeGreaterThanOrEqual(0);

        // Each unevaluated entry names a specific missing profile field.
        for (const u of result.unevaluatedCriteria) {
          expect(typeof u.missingField).toBe('string');
          expect(u.missingField.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // (d) Eligible invariant.
  it('Eligible → no unmet criteria; all evaluable criteria are in metCriteria', () => {
    fc.assert(
      fc.property(arbAnyProfile, arbScheme, (profile, scheme) => {
        const result = calculateEligibility(profile, scheme);
        if (result.status !== 'Eligible') return;

        expect(result.unmetCriteria.length).toBe(0);
        // Eligible now means: no unmet and no unevaluated criteria exist.
        // Either all criteria are met or there are no criteria at all.
        expect(result.unevaluatedCriteria.length).toBe(0);

        // Every scheme criterion with an available profile value is reported as met.
        const evaluable = scheme.eligibilityCriteria.filter((c) => {
          const v = getProfileFieldValue(profile, c.field);
          return v !== null && v !== undefined;
        });
        expect(result.metCriteria.length).toBe(evaluable.length);
        for (const m of result.metCriteria) {
          expect(m.met).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // (d) Vacuous-eligible edge case: empty criteria.
  it('Eligible (vacuously) when scheme.eligibilityCriteria is empty', () => {
    fc.assert(
      fc.property(arbAnyProfile, (profile) => {
        const result = calculateEligibility(profile, makeScheme([]));
        expect(result.status).toBe('Eligible');
        expect(result.metCriteria).toEqual([]);
        expect(result.unmetCriteria).toEqual([]);
        expect(result.unevaluatedCriteria).toEqual([]);
        expect(result.missingProfileFields).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Bucketing partition.
  it('met ⊎ unmet ⊎ unevaluated partitions scheme.eligibilityCriteria exactly', () => {
    fc.assert(
      fc.property(arbAnyProfile, arbScheme, (profile, scheme) => {
        const result = calculateEligibility(profile, scheme);
        const total =
          result.metCriteria.length +
          result.unmetCriteria.length +
          result.unevaluatedCriteria.length;
        expect(total).toBe(scheme.eligibilityCriteria.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Status determination consistency.
  it('status follows the unmet → unevaluated → eligible precedence', () => {
    fc.assert(
      fc.property(arbAnyProfile, arbScheme, (profile, scheme) => {
        const result = calculateEligibility(profile, scheme);
        if (result.unmetCriteria.length > 0) {
          expect(result.status).toBe('Not Eligible');
        } else if (result.unevaluatedCriteria.length > 0) {
          expect(result.status).toBe('Partially Eligible');
        } else {
          // Covers: all met (no unevaluated) and the empty-criteria case.
          expect(result.status).toBe('Eligible');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Missing field surfacing (Req 4.5).
  it('every unevaluated criterion has its missingField surfaced in result.missingProfileFields', () => {
    fc.assert(
      fc.property(arbAnyProfile, arbScheme, (profile, scheme) => {
        const result = calculateEligibility(profile, scheme);
        for (const u of result.unevaluatedCriteria) {
          expect(result.missingProfileFields).toContain(u.missingField);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
