/**
 * Property-based tests for User Profile validation.
 *
 * **Property 6: User Profile Validation**
 * **Validates: Requirements 3.1, 3.2, 3.4**
 *
 * Property statement (from design.md):
 * "For any submitted User_Profile data, the validation function SHALL accept
 * the submission if and only if: all required fields (age, gender, state,
 * income) are present, age is an integer in [0, 150], income is in
 * [0, 9999999999], gender is one of {Male, Female, Other}, state is from the
 * valid list, and all optional fields that are present have values within
 * their defined valid sets. For any invalid submission, the function SHALL
 * return errors identifying each failing field and the reason for failure."
 *
 * These tests use fast-check to verify the universal correctness of
 * `validateProfileData` across the full input space using a reference
 * predicate that mirrors the validation rules.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  PROFILE_CONSTRAINTS,
  INDIAN_STATES,
  type Gender,
  type Occupation,
  type EducationLevel,
  type CasteCategory,
  type MaritalStatus,
} from '@bharat-benefits/shared';
import { validateProfileData, type ValidationMode } from './user-profile-service';

// ─── Reference Predicate ─────────────────────────────────────────────────────

/**
 * Reference predicate that mirrors the validation rules described in the
 * property statement. Used for the bidirectional (iff) property: an input is
 * accepted by `validateProfileData` if and only if this predicate returns
 * true.
 */
function isValidByReference(
  data: Record<string, unknown>,
  mode: ValidationMode,
): boolean {
  // Required fields (create mode only). Treat undefined/null/empty-string as
  // "missing", matching the service's required-field check.
  if (mode === 'create') {
    const required: Array<['age' | 'gender' | 'state' | 'incomeLevel', unknown]> = [
      ['age', data.age],
      ['gender', data.gender],
      ['state', data.state],
      ['incomeLevel', data.incomeLevel],
    ];
    for (const [, value] of required) {
      if (value === undefined || value === null || value === '') return false;
    }
  }

  // Age: integer in [0, 150] when present.
  if (data.age !== undefined && data.age !== null) {
    if (
      typeof data.age !== 'number' ||
      !Number.isInteger(data.age) ||
      data.age < PROFILE_CONSTRAINTS.age.min ||
      data.age > PROFILE_CONSTRAINTS.age.max
    ) {
      return false;
    }
  }

  // Income: finite number in [0, 9_999_999_999] when present.
  if (data.incomeLevel !== undefined && data.incomeLevel !== null) {
    if (
      typeof data.incomeLevel !== 'number' ||
      !Number.isFinite(data.incomeLevel) ||
      data.incomeLevel < PROFILE_CONSTRAINTS.income.min ||
      data.incomeLevel > PROFILE_CONSTRAINTS.income.max
    ) {
      return false;
    }
  }

  // Gender: must be in the allowed set when present (non-null).
  if (data.gender !== undefined && data.gender !== null) {
    if (!PROFILE_CONSTRAINTS.gender.includes(data.gender as Gender)) return false;
  }

  // State: must be a valid Indian state when present and non-empty.
  if (data.state !== undefined && data.state !== null && data.state !== '') {
    if (!INDIAN_STATES.includes(data.state as string)) return false;
  }

  // Occupation: optional enum.
  if (data.occupation !== undefined && data.occupation !== null) {
    if (!PROFILE_CONSTRAINTS.occupation.includes(data.occupation as Occupation)) return false;
  }

  // Education level: optional enum.
  if (data.educationLevel !== undefined && data.educationLevel !== null) {
    if (!PROFILE_CONSTRAINTS.education.includes(data.educationLevel as EducationLevel)) {
      return false;
    }
  }

  // Caste category: optional enum.
  if (data.casteCategory !== undefined && data.casteCategory !== null) {
    if (!PROFILE_CONSTRAINTS.caste.includes(data.casteCategory as CasteCategory)) return false;
  }

  // Marital status: optional enum.
  if (data.maritalStatus !== undefined && data.maritalStatus !== null) {
    if (!PROFILE_CONSTRAINTS.maritalStatus.includes(data.maritalStatus as MaritalStatus)) {
      return false;
    }
  }

  // Dependents: integer in [0, 20] when present.
  if (data.dependents !== undefined && data.dependents !== null) {
    if (
      typeof data.dependents !== 'number' ||
      !Number.isInteger(data.dependents) ||
      data.dependents < PROFILE_CONSTRAINTS.dependents.min ||
      data.dependents > PROFILE_CONSTRAINTS.dependents.max
    ) {
      return false;
    }
  }

  // Disability status: must be boolean when present.
  if (data.disabilityStatus !== undefined && data.disabilityStatus !== null) {
    if (typeof data.disabilityStatus !== 'boolean') return false;
  }

  return true;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const NUM_RUNS = 200;

/** Valid integer age in [0, 150]. */
const arbValidAge = fc.integer({ min: 0, max: 150 });

/** Valid finite income in [0, 9_999_999_999]. */
const arbValidIncome = fc.integer({ min: 0, max: 9_999_999_999 });

/** Valid gender drawn from the allowed enum. */
const arbValidGender = fc.constantFrom<Gender>(...(PROFILE_CONSTRAINTS.gender as Gender[]));

/** Valid state drawn from the configured list. */
const arbValidState = fc.constantFrom(...INDIAN_STATES);

/** Valid optional occupation. */
const arbValidOccupation = fc.constantFrom<Occupation>(
  ...(PROFILE_CONSTRAINTS.occupation as Occupation[]),
);
const arbValidEducation = fc.constantFrom<EducationLevel>(
  ...(PROFILE_CONSTRAINTS.education as EducationLevel[]),
);
const arbValidCaste = fc.constantFrom<CasteCategory>(
  ...(PROFILE_CONSTRAINTS.caste as CasteCategory[]),
);
const arbValidMarital = fc.constantFrom<MaritalStatus>(
  ...(PROFILE_CONSTRAINTS.maritalStatus as MaritalStatus[]),
);
const arbValidDependents = fc.integer({ min: 0, max: 20 });

/** Builds a fully valid create-mode profile (with all optionals also valid). */
const arbValidFullProfile = fc.record({
  age: arbValidAge,
  gender: arbValidGender,
  state: arbValidState,
  incomeLevel: arbValidIncome,
  occupation: arbValidOccupation,
  educationLevel: arbValidEducation,
  casteCategory: arbValidCaste,
  disabilityStatus: fc.boolean(),
  maritalStatus: arbValidMarital,
  dependents: arbValidDependents,
});

/**
 * Arbitrary "anything" — a random input drawn from a space that contains
 * both valid and invalid values for each field. Used for the bidirectional
 * property: every input drawn here MUST satisfy
 *   isValidByReference(data) ⇔ validateProfileData(data).valid
 */
const arbAnyAge = fc.oneof(
  arbValidAge,
  fc.integer({ min: -1000, max: 1000 }),
  fc.double({ noNaN: true, min: -10, max: 200 }),
  fc.constant(undefined),
  fc.constant(null),
);

const arbAnyIncome = fc.oneof(
  arbValidIncome,
  fc.integer({ min: -1000, max: 9_999_999_999 + 1000 }),
  fc.integer({ min: 9_999_999_999, max: Number.MAX_SAFE_INTEGER }),
  fc.constant(undefined),
  fc.constant(null),
);

const arbAnyGender = fc.oneof(
  arbValidGender,
  fc.string(),
  fc.constant(''),
  fc.constant(undefined),
  fc.constant(null),
);

const arbAnyState = fc.oneof(
  arbValidState,
  fc.string(),
  fc.constant(''),
  fc.constant(undefined),
  fc.constant(null),
);

const arbAnyOccupation = fc.oneof(
  arbValidOccupation,
  fc.string(),
  fc.constant(undefined),
  fc.constant(null),
);

const arbAnyEducation = fc.oneof(
  arbValidEducation,
  fc.string(),
  fc.constant(undefined),
  fc.constant(null),
);

const arbAnyCaste = fc.oneof(
  arbValidCaste,
  fc.string(),
  fc.constant(undefined),
  fc.constant(null),
);

const arbAnyMarital = fc.oneof(
  arbValidMarital,
  fc.string(),
  fc.constant(undefined),
  fc.constant(null),
);

const arbAnyDependents = fc.oneof(
  arbValidDependents,
  fc.integer({ min: -50, max: 100 }),
  fc.double({ noNaN: true, min: -5, max: 25 }),
  fc.constant(undefined),
  fc.constant(null),
);

const arbAnyDisability = fc.oneof(
  fc.boolean(),
  fc.string(),
  fc.constant(undefined),
  fc.constant(null),
);

/** Strips undefined keys from a record so missing fields are truly absent. */
function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/** A mixed-validity input for any-mode testing. */
const arbAnyProfileInput = fc
  .record(
    {
      age: arbAnyAge,
      gender: arbAnyGender,
      state: arbAnyState,
      incomeLevel: arbAnyIncome,
      occupation: arbAnyOccupation,
      educationLevel: arbAnyEducation,
      casteCategory: arbAnyCaste,
      disabilityStatus: arbAnyDisability,
      maritalStatus: arbAnyMarital,
      dependents: arbAnyDependents,
    },
    { requiredKeys: [] },
  )
  .map(stripUndefined);

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 6: User Profile Validation', () => {
  // ── 1. Bidirectional property (the iff) ────────────────────────────────────
  describe('bidirectional equivalence with reference predicate', () => {
    it('create mode: validateProfileData.valid ⇔ reference predicate', () => {
      fc.assert(
        fc.property(arbAnyProfileInput, (data) => {
          const expected = isValidByReference(data, 'create');
          // Cast: arbitraries intentionally include null/invalid types to
          // exercise the validator's defensive checks.
          const actual = validateProfileData(
            data as Parameters<typeof validateProfileData>[0],
            'create',
          ).valid;
          expect(actual).toBe(expected);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('update mode: validateProfileData.valid ⇔ reference predicate', () => {
      fc.assert(
        fc.property(arbAnyProfileInput, (data) => {
          const expected = isValidByReference(data, 'update');
          const actual = validateProfileData(
            data as Parameters<typeof validateProfileData>[0],
            'update',
          ).valid;
          expect(actual).toBe(expected);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ── 2. Acceptance properties ───────────────────────────────────────────────
  describe('acceptance: any fully valid profile is accepted', () => {
    it('create mode: any fully valid profile yields valid=true with no errors', () => {
      fc.assert(
        fc.property(arbValidFullProfile, (profile) => {
          const result = validateProfileData(profile, 'create');
          expect(result.valid).toBe(true);
          expect(result.errors).toEqual([]);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('create mode: required-only valid profile (no optionals) is accepted', () => {
      const arbRequiredOnly = fc.record({
        age: arbValidAge,
        gender: arbValidGender,
        state: arbValidState,
        incomeLevel: arbValidIncome,
      });
      fc.assert(
        fc.property(arbRequiredOnly, (profile) => {
          const result = validateProfileData(profile, 'create');
          expect(result.valid).toBe(true);
          expect(result.errors).toEqual([]);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('update mode: any subset of valid fields is accepted', () => {
      const arbValidPartial = fc
        .record(
          {
            age: arbValidAge,
            gender: arbValidGender,
            state: arbValidState,
            incomeLevel: arbValidIncome,
            occupation: arbValidOccupation,
            educationLevel: arbValidEducation,
            casteCategory: arbValidCaste,
            disabilityStatus: fc.boolean(),
            maritalStatus: arbValidMarital,
            dependents: arbValidDependents,
          },
          { requiredKeys: [] },
        )
        .map(stripUndefined);

      fc.assert(
        fc.property(arbValidPartial, (partial) => {
          const result = validateProfileData(partial, 'update');
          expect(result.valid).toBe(true);
          expect(result.errors).toEqual([]);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ── 3. Rejection properties (one per failing condition) ───────────────────
  describe('rejection: each failing condition triggers a field-specific error', () => {
    /** Maps the schema-level required field name to the data property key. */
    const requiredFieldKeyMap = {
      age: 'age',
      gender: 'gender',
      state: 'state',
      income: 'incomeLevel',
    } as const;

    it('missing required field → invalid AND error names that field', () => {
      fc.assert(
        fc.property(
          arbValidFullProfile,
          fc.constantFrom('age', 'gender', 'state', 'income'),
          (base, requiredFieldName) => {
            const dataKey =
              requiredFieldKeyMap[requiredFieldName as keyof typeof requiredFieldKeyMap];
            const data: Record<string, unknown> = { ...base };
            delete data[dataKey];
            const result = validateProfileData(
              data as Parameters<typeof validateProfileData>[0],
              'create',
            );
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.field === requiredFieldName)).toBe(true);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('age out of [0, 150] → invalid AND error for "age"', () => {
      const arbOutOfRangeAge = fc.oneof(
        fc.integer({ min: -1000, max: -1 }),
        fc.integer({ min: 151, max: 10_000 }),
      );
      fc.assert(
        fc.property(arbValidFullProfile, arbOutOfRangeAge, (base, badAge) => {
          const result = validateProfileData({ ...base, age: badAge }, 'create');
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.field === 'age')).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('age non-integer → invalid AND error for "age"', () => {
      const arbNonIntegerAge = fc
        .double({ noNaN: true, min: 0, max: 150 })
        .filter((n) => !Number.isInteger(n));
      fc.assert(
        fc.property(arbValidFullProfile, arbNonIntegerAge, (base, badAge) => {
          const result = validateProfileData({ ...base, age: badAge }, 'create');
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.field === 'age')).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('income out of [0, 9_999_999_999] → invalid AND error for "incomeLevel"', () => {
      const arbOutOfRangeIncome = fc.oneof(
        fc.integer({ min: -1_000_000, max: -1 }),
        fc.integer({ min: 10_000_000_000, max: Number.MAX_SAFE_INTEGER }),
      );
      fc.assert(
        fc.property(arbValidFullProfile, arbOutOfRangeIncome, (base, badIncome) => {
          const result = validateProfileData({ ...base, incomeLevel: badIncome }, 'create');
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.field === 'incomeLevel')).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('gender not in valid set → invalid AND error for "gender"', () => {
      const arbInvalidGender = fc
        .string({ minLength: 1 })
        .filter((s) => !PROFILE_CONSTRAINTS.gender.includes(s as Gender));
      fc.assert(
        fc.property(arbValidFullProfile, arbInvalidGender, (base, badGender) => {
          const result = validateProfileData({ ...base, gender: badGender as Gender }, 'create');
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.field === 'gender')).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('state not in INDIAN_STATES → invalid AND error for "state"', () => {
      const arbInvalidState = fc
        .string({ minLength: 1 })
        .filter((s) => !INDIAN_STATES.includes(s));
      fc.assert(
        fc.property(arbValidFullProfile, arbInvalidState, (base, badState) => {
          const result = validateProfileData({ ...base, state: badState }, 'create');
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.field === 'state')).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('occupation invalid (when present) → error for "occupation"', () => {
      const arbInvalidOccupation = fc
        .string({ minLength: 1 })
        .filter((s) => !PROFILE_CONSTRAINTS.occupation.includes(s as Occupation));
      fc.assert(
        fc.property(arbValidFullProfile, arbInvalidOccupation, (base, badOcc) => {
          const result = validateProfileData(
            { ...base, occupation: badOcc as Occupation },
            'create',
          );
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.field === 'occupation')).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('educationLevel invalid → error for "educationLevel"', () => {
      const arbInvalidEducation = fc
        .string({ minLength: 1 })
        .filter((s) => !PROFILE_CONSTRAINTS.education.includes(s as EducationLevel));
      fc.assert(
        fc.property(arbValidFullProfile, arbInvalidEducation, (base, badEdu) => {
          const result = validateProfileData(
            { ...base, educationLevel: badEdu as EducationLevel },
            'create',
          );
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.field === 'educationLevel')).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('casteCategory invalid → error for "casteCategory"', () => {
      const arbInvalidCaste = fc
        .string({ minLength: 1 })
        .filter((s) => !PROFILE_CONSTRAINTS.caste.includes(s as CasteCategory));
      fc.assert(
        fc.property(arbValidFullProfile, arbInvalidCaste, (base, badCaste) => {
          const result = validateProfileData(
            { ...base, casteCategory: badCaste as CasteCategory },
            'create',
          );
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.field === 'casteCategory')).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('maritalStatus invalid → error for "maritalStatus"', () => {
      const arbInvalidMarital = fc
        .string({ minLength: 1 })
        .filter((s) => !PROFILE_CONSTRAINTS.maritalStatus.includes(s as MaritalStatus));
      fc.assert(
        fc.property(arbValidFullProfile, arbInvalidMarital, (base, badMarital) => {
          const result = validateProfileData(
            { ...base, maritalStatus: badMarital as MaritalStatus },
            'create',
          );
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.field === 'maritalStatus')).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('dependents out of [0, 20] → error for "dependents"', () => {
      const arbBadDependents = fc.oneof(
        fc.integer({ min: -100, max: -1 }),
        fc.integer({ min: 21, max: 1000 }),
      );
      fc.assert(
        fc.property(arbValidFullProfile, arbBadDependents, (base, badDeps) => {
          const result = validateProfileData({ ...base, dependents: badDeps }, 'create');
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.field === 'dependents')).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ── 4. Update mode property ────────────────────────────────────────────────
  describe('update mode', () => {
    it('any partial input where all provided fields are valid → valid=true', () => {
      const arbValidPartial = fc
        .record(
          {
            age: arbValidAge,
            gender: arbValidGender,
            state: arbValidState,
            incomeLevel: arbValidIncome,
            occupation: arbValidOccupation,
            educationLevel: arbValidEducation,
            casteCategory: arbValidCaste,
            disabilityStatus: fc.boolean(),
            maritalStatus: arbValidMarital,
            dependents: arbValidDependents,
          },
          { requiredKeys: [] },
        )
        .map(stripUndefined);

      fc.assert(
        fc.property(arbValidPartial, (partial) => {
          const result = validateProfileData(partial, 'update');
          expect(result.valid).toBe(true);
          expect(result.errors).toEqual([]);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('any partial input with at least one invalid provided field → valid=false AND errors include that field', () => {
      type FieldKey =
        | 'age'
        | 'incomeLevel'
        | 'gender'
        | 'state'
        | 'occupation'
        | 'educationLevel'
        | 'casteCategory'
        | 'maritalStatus'
        | 'dependents';

      const invalidByField: Record<FieldKey, fc.Arbitrary<unknown>> = {
        age: fc.oneof(
          fc.integer({ min: -1000, max: -1 }),
          fc.integer({ min: 151, max: 10_000 }),
        ),
        incomeLevel: fc.oneof(
          fc.integer({ min: -1_000_000, max: -1 }),
          fc.integer({ min: 10_000_000_000, max: Number.MAX_SAFE_INTEGER }),
        ),
        gender: fc
          .string({ minLength: 1 })
          .filter((s) => !PROFILE_CONSTRAINTS.gender.includes(s as Gender)),
        state: fc.string({ minLength: 1 }).filter((s) => !INDIAN_STATES.includes(s)),
        occupation: fc
          .string({ minLength: 1 })
          .filter((s) => !PROFILE_CONSTRAINTS.occupation.includes(s as Occupation)),
        educationLevel: fc
          .string({ minLength: 1 })
          .filter((s) => !PROFILE_CONSTRAINTS.education.includes(s as EducationLevel)),
        casteCategory: fc
          .string({ minLength: 1 })
          .filter((s) => !PROFILE_CONSTRAINTS.caste.includes(s as CasteCategory)),
        maritalStatus: fc
          .string({ minLength: 1 })
          .filter((s) => !PROFILE_CONSTRAINTS.maritalStatus.includes(s as MaritalStatus)),
        dependents: fc.oneof(
          fc.integer({ min: -100, max: -1 }),
          fc.integer({ min: 21, max: 1000 }),
        ),
      };

      // Build a single arbitrary that yields {field, badValue} pairs uniformly.
      const arbFieldAndBadValue = fc.oneof(
        ...(Object.entries(invalidByField) as Array<[FieldKey, fc.Arbitrary<unknown>]>).map(
          ([field, valueArb]) =>
            valueArb.map((badValue) => ({ field, badValue }) as const),
        ),
      );

      fc.assert(
        fc.property(arbFieldAndBadValue, ({ field, badValue }) => {
          const data: Record<string, unknown> = { [field]: badValue };
          const result = validateProfileData(data, 'update');
          expect(result.valid).toBe(false);
          expect(result.errors.some((e) => e.field === field)).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ── 5. Errors-identify-field-and-reason property (Requirement 3.4) ────────
  describe('error contract: every error names a field, value, and reason', () => {
    it('any invalid input → every error has non-empty field, value present, and non-empty reason', () => {
      fc.assert(
        fc.property(arbAnyProfileInput, (data) => {
          // Test in both modes; we only inspect errors when the result is invalid.
          for (const mode of ['create', 'update'] as const) {
            const result = validateProfileData(
              data as Parameters<typeof validateProfileData>[0],
              mode,
            );
            if (result.valid) continue;
            for (const err of result.errors) {
              expect(typeof err.field).toBe('string');
              expect(err.field.length).toBeGreaterThan(0);
              expect('value' in err).toBe(true); // present (may be null)
              expect(typeof err.reason).toBe('string');
              expect(err.reason.length).toBeGreaterThan(0);
            }
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('valid input → errors array is empty', () => {
      fc.assert(
        fc.property(arbValidFullProfile, (data) => {
          const result = validateProfileData(data, 'create');
          expect(result.valid).toBe(true);
          expect(result.errors).toEqual([]);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
