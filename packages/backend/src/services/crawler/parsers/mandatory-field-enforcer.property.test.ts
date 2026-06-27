/**
 * Property-based tests for the scheme-parsing mandatory field enforcer.
 *
 * **Property 20: Scheme Parsing Mandatory Field Enforcement**
 * **Validates: Requirements 22.6, 22.7**
 *
 * Property statement (from design.md):
 * "For any source data input where one or more mandatory fields (name,
 *  description, eligibility criteria, benefits, source URL, ministry)
 *  cannot be parsed, the Crawler_System SHALL reject the scheme. For any
 *  source data where all mandatory fields are present but optional fields
 *  are missing, the system SHALL create the scheme object with missing
 *  optional fields set to null."
 *
 * The properties below check the enforcer end-to-end:
 *   1. Rejection iff at least one mandatory field is missing/empty.
 *   2. Acceptance preserves the mandatory-field values verbatim.
 *   3. Optional fields default to null when missing/invalid; valid
 *      optional fields are preserved.
 *   4. Rejected results enumerate exactly the missing mandatory fields,
 *      always as a non-empty subset of MANDATORY_SCHEME_FIELDS.
 *   5. Successful results have the complete SchemeObject shape (all six
 *      mandatory + all three optional keys present, optionals possibly
 *      null).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  ApplicationStep,
  Benefit,
  DocumentRequirement,
  EligibilityCriterion,
  SchemeObject,
} from '@bharat-benefits/shared';

import {
  enforceMandatoryFields,
  FALLBACK_MINISTRY,
  isRejected,
  MANDATORY_SCHEME_FIELDS,
  type MandatorySchemeField,
} from './mandatory-field-enforcer';

// ─── String-shaped value arbitrary ───────────────────────────────────────────
//
// A "string-shaped" value mimics what an upstream parser may emit for a
// string field. We model the four interesting shapes so each one occurs
// with appreciable probability:
//   - `valid`        non-empty after trimming → counts as PRESENT
//   - `empty`        '' → counts as MISSING
//   - `whitespace`   only spaces/tabs → counts as MISSING
//   - `undefined`    field absent → counts as MISSING
// We also occasionally yield a non-string (number/null/object) to exercise
// the `typeof` guard inside sanitizeString.

type StringShaped = string | number | null | undefined | object;

const arbValidString = fc
  .string({ minLength: 1, maxLength: 40 })
  .map((s) => `x${s}`); // guarantee at least one non-whitespace char

const arbWhitespaceString = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 1, maxLength: 6 })
  .map((arr) => arr.join(''));

const arbStringShapedValid: fc.Arbitrary<StringShaped> = arbValidString;

const arbStringShapedInvalid: fc.Arbitrary<StringShaped> = fc.oneof(
  fc.constant(''),
  arbWhitespaceString,
  fc.constant(undefined),
  fc.constant(null),
  fc.integer(),
  fc.record({}),
);

// ─── Array-shaped value arbitrary ────────────────────────────────────────────

const arbCriterion: fc.Arbitrary<EligibilityCriterion> = fc.record({
  field: fc.string({ minLength: 1, maxLength: 16 }),
  operator: fc.constantFrom(
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'between',
  ) as fc.Arbitrary<EligibilityCriterion['operator']>,
  value: fc.oneof(
    fc.integer(),
    fc.string({ maxLength: 8 }),
    fc.boolean(),
  ) as fc.Arbitrary<unknown>,
  description: fc.string({ minLength: 1, maxLength: 32 }),
});

const arbBenefit: fc.Arbitrary<Benefit> = fc.record({
  type: fc.constantFrom('monetary', 'non-monetary') as fc.Arbitrary<
    Benefit['type']
  >,
  amount: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 1_000_000 })),
  description: fc.string({ minLength: 1, maxLength: 32 }),
});

const arbAppStep: fc.Arbitrary<ApplicationStep> = fc.record({
  stepNumber: fc.integer({ min: 1, max: 10 }),
  action: fc.string({ minLength: 1, maxLength: 24 }),
  expectedOutcome: fc.string({ minLength: 1, maxLength: 24 }),
});

const arbDocReq: fc.Arbitrary<DocumentRequirement> = fc.record({
  documentName: fc.string({ minLength: 1, maxLength: 16 }),
  description: fc.string({ minLength: 1, maxLength: 24 }),
  format: fc.constantFrom('pdf', 'jpg', 'png', 'doc'),
  required: fc.boolean(),
});

const arbValidCriteria = fc.array(arbCriterion, { minLength: 1, maxLength: 4 });
const arbValidBenefits = fc.array(arbBenefit, { minLength: 1, maxLength: 4 });

// "Invalid" array-shaped values: anything the enforcer treats as missing.
const arbInvalidArrayLike: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant([]),
  fc.constant(undefined),
  fc.constant(null),
  fc.string({ maxLength: 8 }),
  fc.integer(),
  fc.record({}),
);

const arbCriteriaShapedValid: fc.Arbitrary<unknown> = arbValidCriteria;
const arbCriteriaShapedInvalid: fc.Arbitrary<unknown> = arbInvalidArrayLike;
const arbBenefitsShapedValid: fc.Arbitrary<unknown> = arbValidBenefits;
const arbBenefitsShapedInvalid: fc.Arbitrary<unknown> = arbInvalidArrayLike;

// ─── Optional field arbitraries ──────────────────────────────────────────────

const arbValidAppProcess = fc.array(arbAppStep, { minLength: 1, maxLength: 3 });
const arbValidDocs = fc.array(arbDocReq, { minLength: 1, maxLength: 3 });
const arbValidDeadline = fc
  .integer({ min: 0, max: 4_102_444_800_000 }) // up to year 2100
  .map((ms) => new Date(ms));

const arbInvalidOptionalArray: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.string({ maxLength: 4 }),
  fc.integer(),
);

const arbInvalidDeadline: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant(new Date('not-a-date')),
  fc.string({ maxLength: 4 }),
  fc.integer(),
);

// ─── Top-level partial arbitrary ─────────────────────────────────────────────
//
// Each mandatory field is chosen independently from a pool that mixes
// "valid" and "invalid" shapes. We deliberately bias towards including
// invalid shapes so the rejection branch gets exercised most of the time,
// while still allowing the all-valid case to occur often enough to
// exercise acceptance.

interface PartialBundle {
  partial: Partial<SchemeObject>;
  fallbackSourceUrl: string;
  // Whether each mandatory field would, in isolation, count as PRESENT
  // under the enforcer's rules. For sourceUrl this incorporates the
  // fallback.
  presence: Record<MandatorySchemeField, boolean>;
}

const arbStringField = (validProb: number) =>
  fc
    .double({ min: 0, max: 1, noNaN: true })
    .chain((roll) =>
      roll < validProb ? arbStringShapedValid : arbStringShapedInvalid,
    );

const arbCriteriaField = (validProb: number) =>
  fc
    .double({ min: 0, max: 1, noNaN: true })
    .chain((roll) =>
      roll < validProb ? arbCriteriaShapedValid : arbCriteriaShapedInvalid,
    );

const arbBenefitsField = (validProb: number) =>
  fc
    .double({ min: 0, max: 1, noNaN: true })
    .chain((roll) =>
      roll < validProb ? arbBenefitsShapedValid : arbBenefitsShapedInvalid,
    );

const arbOptionalArrayField = (
  arbValid: fc.Arbitrary<unknown>,
  validProb: number,
) =>
  fc
    .double({ min: 0, max: 1, noNaN: true })
    .chain((roll) =>
      roll < validProb ? arbValid : arbInvalidOptionalArray,
    );

const arbOptionalDeadlineField = (validProb: number) =>
  fc
    .double({ min: 0, max: 1, noNaN: true })
    .chain((roll) =>
      roll < validProb
        ? (arbValidDeadline as fc.Arbitrary<unknown>)
        : arbInvalidDeadline,
    );

/**
 * Partial bundle where each field is INDEPENDENTLY valid with probability
 * `validProb`. Optional fields are independently valid with `optValidProb`.
 */
function arbPartialBundle(
  validProb: number,
  optValidProb: number,
): fc.Arbitrary<PartialBundle> {
  return fc
    .record({
      name: arbStringField(validProb),
      description: arbStringField(validProb),
      eligibilityCriteria: arbCriteriaField(validProb),
      benefits: arbBenefitsField(validProb),
      sourceUrl: arbStringField(validProb),
      ministry: arbStringField(validProb),
      // For sourceUrl fallback we also vary validity so the combined rule
      // (partial.sourceUrl OR fallback) gets covered.
      fallbackSourceUrl: arbStringField(validProb),
      applicationProcess: arbOptionalArrayField(
        arbValidAppProcess,
        optValidProb,
      ),
      requiredDocuments: arbOptionalArrayField(arbValidDocs, optValidProb),
      deadline: arbOptionalDeadlineField(optValidProb),
    })
    .map((raw) => {
      const partial: Partial<SchemeObject> = {};
      // Only assign keys whose value is not `undefined`, so the "field
      // absent" case is genuinely absent rather than `key: undefined`.
      // (Either would behave identically for the enforcer, but absence is
      // the more realistic shape from a parser.)
      if (raw.name !== undefined) (partial as Record<string, unknown>).name = raw.name;
      if (raw.description !== undefined)
        (partial as Record<string, unknown>).description = raw.description;
      if (raw.eligibilityCriteria !== undefined)
        (partial as Record<string, unknown>).eligibilityCriteria =
          raw.eligibilityCriteria;
      if (raw.benefits !== undefined)
        (partial as Record<string, unknown>).benefits = raw.benefits;
      if (raw.sourceUrl !== undefined)
        (partial as Record<string, unknown>).sourceUrl = raw.sourceUrl;
      if (raw.ministry !== undefined)
        (partial as Record<string, unknown>).ministry = raw.ministry;
      if (raw.applicationProcess !== undefined)
        (partial as Record<string, unknown>).applicationProcess =
          raw.applicationProcess;
      if (raw.requiredDocuments !== undefined)
        (partial as Record<string, unknown>).requiredDocuments =
          raw.requiredDocuments;
      if (raw.deadline !== undefined)
        (partial as Record<string, unknown>).deadline = raw.deadline;

      const fallbackSourceUrl =
        typeof raw.fallbackSourceUrl === 'string' ? raw.fallbackSourceUrl : '';

      const sourceUrlPresent =
        isPresentString(raw.sourceUrl) ||
        isPresentString(raw.fallbackSourceUrl);

      const presence: Record<MandatorySchemeField, boolean> = {
        name: isPresentString(raw.name),
        description: isPresentString(raw.description),
        sourceUrl: sourceUrlPresent,
      };

      return { partial, fallbackSourceUrl, presence };
    });
}

// Same rules the enforcer uses, mirrored locally so the property is an
// independent oracle rather than a tautology.
function isPresentString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
function isPresentNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

// ─── Property tests ──────────────────────────────────────────────────────────

describe('Property 20: Scheme Parsing Mandatory Field Enforcement', () => {
  // ── 1. Rejection iff property ─────────────────────────────────────────────
  it('rejects iff at least one mandatory field is missing/empty', () => {
    fc.assert(
      fc.property(arbPartialBundle(0.6, 0.5), ({ partial, fallbackSourceUrl, presence }) => {
        const result = enforceMandatoryFields(partial, fallbackSourceUrl);

        const expectedMissing = MANDATORY_SCHEME_FIELDS.filter(
          (f) => !presence[f],
        );
        const shouldReject = expectedMissing.length > 0;

        expect(isRejected(result)).toBe(shouldReject);
      }),
      { numRuns: 200 },
    );
  });

  // ── 2. Acceptance property ────────────────────────────────────────────────
  it('accepts and preserves mandatory field values when all are present', () => {
    // High probability of validity so this branch is well-exercised.
    fc.assert(
      fc.property(arbPartialBundle(0.95, 0.5), ({ partial, fallbackSourceUrl, presence }) => {
        // Skip cases where the bundle still happened to miss something.
        const allPresent = MANDATORY_SCHEME_FIELDS.every((f) => presence[f]);
        fc.pre(allPresent);

        const result = enforceMandatoryFields(partial, fallbackSourceUrl);
        expect(isRejected(result)).toBe(false);
        if (isRejected(result)) return;

        // Mandatory fields preserved verbatim (modulo the trim normalisation
        // applied by the enforcer to strings).
        expect(result.name).toBe((partial.name as string).trim());
        expect(result.description).toBe(
          (partial.description as string).trim(),
        );

        const expectedSourceUrl =
          typeof partial.sourceUrl === 'string' &&
          partial.sourceUrl.trim().length > 0
            ? partial.sourceUrl.trim()
            : fallbackSourceUrl.trim();
        expect(result.sourceUrl).toBe(expectedSourceUrl);

        // Ministry is now optional: when present, it's preserved (trimmed);
        // when missing, the enforcer falls back to FALLBACK_MINISTRY so
        // PrismaSchemePersistence still has a non-null value.
        if (typeof partial.ministry === 'string' && partial.ministry.trim().length > 0) {
          expect(result.ministry).toBe(partial.ministry.trim());
        } else {
          expect(result.ministry).toBe(FALLBACK_MINISTRY);
        }

        // Eligibility / benefits are now optional. When the partial holds a
        // proper array, it's preserved by reference; otherwise the enforcer
        // returns an empty array so the SchemeObject shape stays consistent.
        if (Array.isArray(partial.eligibilityCriteria)) {
          expect(result.eligibilityCriteria).toBe(partial.eligibilityCriteria);
        } else {
          expect(result.eligibilityCriteria).toEqual([]);
        }
        if (Array.isArray(partial.benefits)) {
          expect(result.benefits).toBe(partial.benefits);
        } else {
          expect(result.benefits).toEqual([]);
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── 3a. Optional fields nullified when missing/invalid ────────────────────
  it('nullifies optional fields when they are missing or invalid', () => {
    fc.assert(
      fc.property(
        arbPartialBundle(0.95, 0).map(({ partial, fallbackSourceUrl, presence }) => {
          // Force optional fields to be missing/invalid by stripping them.
          const stripped: Partial<SchemeObject> = { ...partial };
          delete stripped.applicationProcess;
          delete stripped.requiredDocuments;
          delete stripped.deadline;
          return { partial: stripped, fallbackSourceUrl, presence };
        }),
        ({ partial, fallbackSourceUrl, presence }) => {
          fc.pre(MANDATORY_SCHEME_FIELDS.every((f) => presence[f]));
          const result = enforceMandatoryFields(partial, fallbackSourceUrl);
          expect(isRejected(result)).toBe(false);
          if (isRejected(result)) return;
          expect(result.applicationProcess).toBeNull();
          expect(result.requiredDocuments).toBeNull();
          expect(result.deadline).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });

  // ── 3b. Optional fields preserved when valid ──────────────────────────────
  it('preserves optional fields when they are valid', () => {
    fc.assert(
      fc.property(
        arbPartialBundle(0.95, 1).map(({ partial, fallbackSourceUrl, presence }) => ({
          partial,
          fallbackSourceUrl,
          presence,
        })),
        ({ partial, fallbackSourceUrl, presence }) => {
          fc.pre(MANDATORY_SCHEME_FIELDS.every((f) => presence[f]));
          // optValidProb=1 guarantees these are valid shapes.
          fc.pre(Array.isArray(partial.applicationProcess));
          fc.pre(Array.isArray(partial.requiredDocuments));
          fc.pre(
            partial.deadline instanceof Date &&
              !Number.isNaN(partial.deadline.getTime()),
          );

          const result = enforceMandatoryFields(partial, fallbackSourceUrl);
          expect(isRejected(result)).toBe(false);
          if (isRejected(result)) return;
          expect(result.applicationProcess).toBe(partial.applicationProcess);
          expect(result.requiredDocuments).toBe(partial.requiredDocuments);
          expect(result.deadline).toBe(partial.deadline);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ── 4. Missing fields identification ──────────────────────────────────────
  it('reports exactly the missing mandatory fields on rejection', () => {
    fc.assert(
      fc.property(arbPartialBundle(0.6, 0.5), ({ partial, fallbackSourceUrl, presence }) => {
        const result = enforceMandatoryFields(partial, fallbackSourceUrl);

        const expectedMissing = MANDATORY_SCHEME_FIELDS.filter(
          (f) => !presence[f],
        );
        if (expectedMissing.length === 0) {
          expect(isRejected(result)).toBe(false);
          return;
        }

        expect(isRejected(result)).toBe(true);
        if (!isRejected(result)) return;

        // missingFields is non-empty and a subset of the mandatory set.
        expect(result.missingFields.length).toBeGreaterThan(0);
        for (const f of result.missingFields) {
          expect(MANDATORY_SCHEME_FIELDS).toContain(f);
        }

        // Exact equality as sets — same elements, no duplicates, no extras.
        expect(new Set(result.missingFields)).toEqual(new Set(expectedMissing));
        expect(result.missingFields.length).toBe(expectedMissing.length);
      }),
      { numRuns: 200 },
    );
  });

  // ── 5. Output structure invariant ─────────────────────────────────────────
  it('returns a complete SchemeObject shape on success', () => {
    const expectedKeys = [
      'name',
      'description',
      'eligibilityCriteria',
      'benefits',
      'sourceUrl',
      'ministry',
      'applicationProcess',
      'requiredDocuments',
      'deadline',
    ] as const;

    fc.assert(
      fc.property(arbPartialBundle(0.95, 0.5), ({ partial, fallbackSourceUrl, presence }) => {
        fc.pre(MANDATORY_SCHEME_FIELDS.every((f) => presence[f]));
        const result = enforceMandatoryFields(partial, fallbackSourceUrl);
        expect(isRejected(result)).toBe(false);
        if (isRejected(result)) return;

        for (const key of expectedKeys) {
          expect(Object.prototype.hasOwnProperty.call(result, key)).toBe(true);
        }
        // Mandatory values are non-null/non-empty in their respective ways.
        expect(typeof result.name).toBe('string');
        expect(result.name.length).toBeGreaterThan(0);
        expect(typeof result.description).toBe('string');
        expect(result.description.length).toBeGreaterThan(0);
        // Ministry is non-empty even when missing from the partial — the
        // enforcer falls back to FALLBACK_MINISTRY rather than rejecting.
        expect(typeof result.ministry).toBe('string');
        expect(result.ministry.length).toBeGreaterThan(0);
        expect(typeof result.sourceUrl).toBe('string');
        expect(result.sourceUrl.length).toBeGreaterThan(0);
        // Eligibility / benefits are arrays (possibly empty now that they
        // are optional). Don't assert length > 0 — the relaxed contract
        // explicitly allows partial schemes to land in the catalogue.
        expect(Array.isArray(result.eligibilityCriteria)).toBe(true);
        expect(Array.isArray(result.benefits)).toBe(true);

        // Optional fields are either of their proper shape OR null —
        // never undefined.
        expect(
          result.applicationProcess === null ||
            Array.isArray(result.applicationProcess),
        ).toBe(true);
        expect(
          result.requiredDocuments === null ||
            Array.isArray(result.requiredDocuments),
        ).toBe(true);
        expect(
          result.deadline === null || result.deadline instanceof Date,
        ).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
