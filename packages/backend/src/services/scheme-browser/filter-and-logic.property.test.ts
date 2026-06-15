/**
 * Property-based tests for the Scheme Browser filter logic.
 *
 * **Property 4: Filter AND Logic**
 * **Validates: Requirements 2.3**
 *
 * Property statement (from design.md):
 * "For any set of schemes and any combination of active filters (State,
 *  Income Level, Category, Age, Gender, Occupation, Benefit Type), every
 *  scheme in the returned result set SHALL satisfy ALL active filter
 *  criteria simultaneously."
 *
 * Approach: a per-scheme reference oracle mirrors the AND-combining
 * semantics of `applySchemeFilters` (each active filter must pass; inactive
 * filters contribute nothing). The tests then verify both directions of the
 * equivalence — soundness (every returned scheme passes every active
 * filter) and completeness (every dropped scheme fails at least one) — plus
 * the universal consequences of AND-combining (subset, order preservation,
 * monotonicity, empty-filter identity).
 *
 * To keep the oracle independent of the implementation's internal field
 * alias table, eligibility criteria are generated only with canonical field
 * names (`age`, `gender`, `occupation`, `incomeLevel`) that resolve to
 * themselves under the implementation's normalisation rules.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  EligibilityCriterion,
  Scheme,
  SchemeCategory,
} from '@bharat-benefits/shared';
import { INDIAN_STATES } from '@bharat-benefits/shared';
import {
  applySchemeFilters,
  countActiveFilters,
  criterionAllowsValue,
  type SchemeFilters,
} from './scheme-filter';

const NUM_RUNS = 150;

// ─── Domain arbitraries ──────────────────────────────────────────────────────

const SCHEME_CATEGORIES: readonly SchemeCategory[] = [
  'Education',
  'Agriculture',
  'Healthcare',
  'Women',
  'Employment',
  'Skill Development',
  'Housing',
  'Startups',
  'MSME',
  'Pension',
  'Scholarships',
  'Financial Assistance',
];

const GENDERS = ['Male', 'Female', 'Other'] as const;
const OCCUPATIONS = [
  'Farmer',
  'Student',
  'Salaried',
  'Self-Employed',
  'Unemployed',
  'Retired',
  'Other',
] as const;
const BENEFIT_TYPES = ['monetary', 'non-monetary'] as const;

const arbCategory = fc.constantFrom(...SCHEME_CATEGORIES);
const arbBenefitType = fc.constantFrom(...BENEFIT_TYPES);
const arbState = fc.constantFrom(...INDIAN_STATES);
const arbGender = fc.constantFrom(...GENDERS);
const arbOccupation = fc.constantFrom(...OCCUPATIONS);
const arbAge = fc.integer({ min: 0, max: 150 });
const arbIncome = fc.integer({ min: 0, max: 9_999_999_999 });

const arbDescription = fc.string({ minLength: 1, maxLength: 40 });

// ─── Criterion arbitraries ──────────────────────────────────────────────────
//
// All generated criteria use canonical field names so that the
// implementation's `canonicalFilterKey` maps the criterion's `field` to the
// matching key in `SchemeFilters` without requiring the test to mirror the
// alias table.

const arbAgeCriterion: fc.Arbitrary<EligibilityCriterion> = fc.oneof(
  fc.record({
    field: fc.constant('age'),
    operator: fc.constantFrom('eq', 'neq', 'gt', 'gte', 'lt', 'lte'),
    value: arbAge,
    description: arbDescription,
  }),
  fc
    .tuple(arbAge, arbAge, arbDescription)
    .map(([a, b, desc]): EligibilityCriterion => ({
      field: 'age',
      operator: 'between',
      value: [Math.min(a, b), Math.max(a, b)],
      description: desc,
    })),
) as fc.Arbitrary<EligibilityCriterion>;

const arbIncomeCriterion: fc.Arbitrary<EligibilityCriterion> = fc.oneof(
  fc.record({
    field: fc.constant('incomeLevel'),
    operator: fc.constantFrom('eq', 'neq', 'gt', 'gte', 'lt', 'lte'),
    value: arbIncome,
    description: arbDescription,
  }),
  fc
    .tuple(arbIncome, arbIncome, arbDescription)
    .map(([a, b, desc]): EligibilityCriterion => ({
      field: 'incomeLevel',
      operator: 'between',
      value: [Math.min(a, b), Math.max(a, b)],
      description: desc,
    })),
) as fc.Arbitrary<EligibilityCriterion>;

const arbGenderCriterion: fc.Arbitrary<EligibilityCriterion> = fc.oneof(
  fc.record({
    field: fc.constant('gender'),
    operator: fc.constantFrom('eq', 'neq'),
    value: arbGender,
    description: arbDescription,
  }),
  fc.record({
    field: fc.constant('gender'),
    operator: fc.constant('in'),
    value: fc.array(arbGender, { minLength: 1, maxLength: 3 }),
    description: arbDescription,
  }),
) as fc.Arbitrary<EligibilityCriterion>;

const arbOccupationCriterion: fc.Arbitrary<EligibilityCriterion> = fc.oneof(
  fc.record({
    field: fc.constant('occupation'),
    operator: fc.constantFrom('eq', 'neq'),
    value: arbOccupation,
    description: arbDescription,
  }),
  fc.record({
    field: fc.constant('occupation'),
    operator: fc.constant('in'),
    value: fc.array(arbOccupation, { minLength: 1, maxLength: OCCUPATIONS.length }),
    description: arbDescription,
  }),
) as fc.Arbitrary<EligibilityCriterion>;

const arbCriterion: fc.Arbitrary<EligibilityCriterion> = fc.oneof(
  arbAgeCriterion,
  arbIncomeCriterion,
  arbGenderCriterion,
  arbOccupationCriterion,
);

// ─── Scheme arbitrary ────────────────────────────────────────────────────────

let schemeIdCounter = 0;

function buildScheme(parts: {
  state: string | null;
  category: SchemeCategory;
  benefitType: 'monetary' | 'non-monetary';
  criteria: EligibilityCriterion[];
}): Scheme {
  schemeIdCounter += 1;
  return {
    id: `scheme-${schemeIdCounter}`,
    name: `Scheme ${schemeIdCounter}`,
    description: 'description',
    ministry: 'Ministry of Test',
    state: parts.state,
    category: parts.category,
    sourceUrl: 'https://example.gov.in/scheme',
    benefitType: parts.benefitType,
    benefitAmount: null,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: null,
    eligibilityCriteria: parts.criteria,
    benefits: [],
    applicationSteps: null,
    requiredDocuments: null,
    trustScore: 80,
    verified: true,
    discoveredAt: new Date('2024-01-01T00:00:00Z'),
    lastVerifiedAt: new Date('2024-01-02T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
  };
}

const arbScheme: fc.Arbitrary<Scheme> = fc
  .record({
    // ~30% Central schemes (state=null), 70% State schemes — drives coverage
    // of the "Central schemes always pass state filter" branch.
    state: fc.oneof(
      { weight: 3, arbitrary: fc.constant(null) },
      { weight: 7, arbitrary: arbState },
    ),
    category: arbCategory,
    benefitType: arbBenefitType,
    criteria: fc.array(arbCriterion, { minLength: 0, maxLength: 5 }),
  })
  .map(buildScheme);

const arbSchemeList: fc.Arbitrary<Scheme[]> = fc.array(arbScheme, {
  minLength: 0,
  maxLength: 12,
});

// ─── Filter arbitrary ────────────────────────────────────────────────────────
//
// Each filter dimension is independently `undefined` (inactive) with ~30%
// probability so the average filter set has ~5 active dimensions, exercising
// the AND combination heavily while still covering the inactive cases.

const arbFilters: fc.Arbitrary<SchemeFilters> = fc
  .record({
    state: fc.oneof(
      { weight: 3, arbitrary: fc.constant(undefined) },
      { weight: 7, arbitrary: arbState },
    ),
    incomeLevel: fc.oneof(
      { weight: 3, arbitrary: fc.constant(undefined) },
      { weight: 7, arbitrary: arbIncome },
    ),
    category: fc.oneof(
      { weight: 3, arbitrary: fc.constant(undefined) },
      { weight: 7, arbitrary: arbCategory },
    ),
    age: fc.oneof(
      { weight: 3, arbitrary: fc.constant(undefined) },
      { weight: 7, arbitrary: arbAge },
    ),
    gender: fc.oneof(
      { weight: 3, arbitrary: fc.constant(undefined) },
      { weight: 7, arbitrary: arbGender },
    ),
    occupation: fc.oneof(
      { weight: 3, arbitrary: fc.constant(undefined) },
      { weight: 7, arbitrary: arbOccupation },
    ),
    benefitType: fc.oneof(
      { weight: 3, arbitrary: fc.constant(undefined) },
      { weight: 7, arbitrary: arbBenefitType },
    ),
  })
  // Strip undefined keys so `countActiveFilters` reflects only present keys —
  // matches how the production filter UI submits the filter object.
  .map((raw) => {
    const out: SchemeFilters = {};
    if (raw.state !== undefined) out.state = raw.state;
    if (raw.incomeLevel !== undefined) out.incomeLevel = raw.incomeLevel;
    if (raw.category !== undefined) out.category = raw.category;
    if (raw.age !== undefined) out.age = raw.age;
    if (raw.gender !== undefined) out.gender = raw.gender;
    if (raw.occupation !== undefined) out.occupation = raw.occupation;
    if (raw.benefitType !== undefined) out.benefitType = raw.benefitType;
    return out;
  });

// ─── Reference oracle ────────────────────────────────────────────────────────

/**
 * Reference predicate: returns `true` iff `scheme` satisfies every active
 * filter under AND semantics. Independently re-derives the per-filter
 * decision so a divergence between the implementation and this oracle
 * causes the property to fail loudly.
 *
 * Mirrors `applySchemeFilters`:
 *   - State: Central schemes (null/empty state) always pass; State schemes
 *     pass iff trim+lowercase equals the filter state.
 *   - Category / Benefit Type: strict equality.
 *   - Age / Income / Gender / Occupation: every criterion in the scheme
 *     that targets that filter dimension must allow the filter value.
 *     Schemes that place no restriction on a dimension automatically pass.
 */
function schemePassesAllFilters(scheme: Scheme, filters: SchemeFilters): boolean {
  if (filters.state !== undefined) {
    const s = scheme.state;
    if (s !== null && s !== undefined && s.trim() !== '') {
      if (s.trim().toLowerCase() !== filters.state.trim().toLowerCase()) {
        return false;
      }
    }
  }
  if (filters.category !== undefined && scheme.category !== filters.category) {
    return false;
  }
  if (
    filters.benefitType !== undefined &&
    scheme.benefitType !== filters.benefitType
  ) {
    return false;
  }

  // Criteria-driven dimensions: filterKey -> the literal field value used
  // in our generators. Aligned with `canonicalFilterKey`'s identity mapping
  // for these names.
  const criteriaDriven: Array<{
    key: keyof SchemeFilters;
    field: string;
    value: unknown;
  }> = [
    { key: 'incomeLevel', field: 'incomeLevel', value: filters.incomeLevel },
    { key: 'age', field: 'age', value: filters.age },
    { key: 'gender', field: 'gender', value: filters.gender },
    { key: 'occupation', field: 'occupation', value: filters.occupation },
  ];

  for (const { key, field, value } of criteriaDriven) {
    if (filters[key] === undefined) continue;
    for (const c of scheme.eligibilityCriteria) {
      if (c.field === field && !criterionAllowsValue(c, value)) {
        return false;
      }
    }
  }

  return true;
}

// ─── Property tests ──────────────────────────────────────────────────────────

describe('Property 4: Filter AND Logic — Validates Requirements 2.3', () => {
  // Soundness: every returned scheme satisfies every active filter.
  it('every scheme in the result satisfies every active filter', () => {
    fc.assert(
      fc.property(arbSchemeList, arbFilters, (schemes, filters) => {
        const result = applySchemeFilters(schemes, filters);
        for (const scheme of result) {
          expect(schemePassesAllFilters(scheme, filters)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Completeness: nothing valid is dropped. Combined with soundness this
  // gives full equivalence between `applySchemeFilters` and the oracle.
  it('every scheme that satisfies all active filters appears in the result', () => {
    fc.assert(
      fc.property(arbSchemeList, arbFilters, (schemes, filters) => {
        const result = applySchemeFilters(schemes, filters);
        const resultIds = new Set(result.map((s) => s.id));
        for (const scheme of schemes) {
          if (schemePassesAllFilters(scheme, filters)) {
            expect(resultIds.has(scheme.id)).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Subset + order preservation: AND-filtering can only drop, never reorder.
  it('the result is an order-preserving subset of the input', () => {
    fc.assert(
      fc.property(arbSchemeList, arbFilters, (schemes, filters) => {
        const result = applySchemeFilters(schemes, filters);
        // Subset.
        const inputIds = new Set(schemes.map((s) => s.id));
        for (const r of result) {
          expect(inputIds.has(r.id)).toBe(true);
        }
        // Order preserved (relative order of surviving elements is unchanged).
        let cursor = 0;
        for (const s of schemes) {
          if (cursor < result.length && result[cursor].id === s.id) cursor += 1;
        }
        expect(cursor).toBe(result.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Empty AND is the identity: with no active filters, every scheme passes.
  it('returns the full input list when no filters are active', () => {
    fc.assert(
      fc.property(arbSchemeList, (schemes) => {
        const result = applySchemeFilters(schemes, {});
        expect(countActiveFilters({})).toBe(0);
        expect(result.map((s) => s.id)).toEqual(schemes.map((s) => s.id));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Monotonicity under AND: activating a previously-inactive filter never
  // grows the result set. Strengthens Property 4 by ruling out "AND that
  // sometimes lets new schemes in" — a classic mis-implementation of
  // conjunctive filters. Note: we compose only by adding new dimensions
  // (never overwriting an active filter value) so the relationship is
  // strictly narrowing.
  it('activating additional filters never grows the result set', () => {
    fc.assert(
      fc.property(arbSchemeList, arbFilters, arbFilters, (schemes, base, extra) => {
        const narrowed: SchemeFilters = { ...base };
        for (const key of Object.keys(extra) as (keyof SchemeFilters)[]) {
          if (base[key] === undefined && extra[key] !== undefined) {
            (narrowed as Record<string, unknown>)[key] = extra[key];
          }
        }
        const baseIds = new Set(applySchemeFilters(schemes, base).map((s) => s.id));
        const narrowedResult = applySchemeFilters(schemes, narrowed);
        for (const s of narrowedResult) {
          expect(baseIds.has(s.id)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Idempotence: filtering an already-filtered list with the same filters
  // returns the same list. A direct consequence of AND semantics — the
  // surviving schemes already satisfy every active filter.
  it('filtering is idempotent under the same filter set', () => {
    fc.assert(
      fc.property(arbSchemeList, arbFilters, (schemes, filters) => {
        const once = applySchemeFilters(schemes, filters);
        const twice = applySchemeFilters(once, filters);
        expect(twice.map((s) => s.id)).toEqual(once.map((s) => s.id));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
