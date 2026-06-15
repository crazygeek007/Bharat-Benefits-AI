/**
 * Property-based tests for scheme-comparison difference highlighting.
 *
 * **Property 22: Scheme Comparison Difference Highlighting**
 * **Validates: Requirements 24.4**
 *
 * Property statement (from design.md):
 * "For any set of 2 or 3 schemes selected for comparison, for each
 *  comparison attribute (eligibility criteria, benefits, deadline,
 *  documents, application process), the system SHALL highlight the
 *  attribute cell if and only if the values differ across the selected
 *  schemes."
 *
 * The pure helpers `attributeDiffersAcross` and `canonicaliseAttribute`
 * (in `scheme-comparison.ts`) implement the highlighting decision; the
 * top-level `buildSchemeComparison` lifts that decision into the
 * `differs` flag of every attribute row that the citizen-facing UI
 * renders.
 *
 * The biconditional is verified against a deterministic reference
 * oracle: count the distinct canonical values across the supplied
 * schemes — `differs` SHALL be true iff that count is greater than one.
 *
 * Generators are deliberately constrained to a small vocabulary of
 * attribute values so randomly-drawn schemes share values often enough
 * to exercise *both* directions of the iff: corpora that should highlight
 * (values differ) and corpora that should not (values match).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  ApplicationStep,
  Benefit,
  DocumentRequirement,
  EligibilityCriterion,
  Scheme,
} from '@bharat-benefits/shared';
import {
  COMPARISON_ATTRIBUTE_KEYS,
  MAX_COMPARISON_SCHEMES,
  MIN_COMPARISON_SCHEMES,
  type ComparisonAttributeKey,
  attributeDiffersAcross,
  buildSchemeComparison,
  canonicaliseAttribute,
} from './scheme-comparison';

const NUM_RUNS = 200;

// ─── Scheme construction helper ─────────────────────────────────────────────

let counter = 0;

/**
 * Builds a fully-typed `Scheme` from a partial override. Only the five
 * comparison attributes (`eligibilityCriteria`, `benefits`, `deadline`,
 * `requiredDocuments`, `applicationSteps`) participate in the highlighting
 * decision; the remaining fields are filled with stable, valid defaults
 * so any partial override produces a usable Scheme.
 */
function makeScheme(overrides: Partial<Scheme> = {}): Scheme {
  counter += 1;
  return {
    id: `scheme-${counter}`,
    name: `Scheme ${counter}`,
    description: 'Description',
    ministry: 'Ministry of Test',
    state: null,
    category: 'Education',
    sourceUrl: 'https://example.gov.in/scheme',
    benefitType: 'monetary',
    benefitAmount: 0,
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

// ─── Constrained-vocabulary arbitraries ──────────────────────────────────────
//
// Property 22 is a biconditional; to exercise both directions the generator
// has to produce corpora that frequently agree *and* corpora that frequently
// disagree on a given attribute. Drawing each value from a small pool
// (handful of dates, handful of criteria, handful of benefit shapes, etc.)
// gives a meaningful collision rate so neither branch is starved.

const arbCriterion: fc.Arbitrary<EligibilityCriterion> = fc.constantFrom(
  {
    field: 'age',
    operator: 'gte' as const,
    value: 18,
    description: 'Age >= 18',
  },
  {
    field: 'age',
    operator: 'lte' as const,
    value: 60,
    description: 'Age <= 60',
  },
  {
    field: 'state',
    operator: 'eq' as const,
    value: 'KA',
    description: 'State = KA',
  },
  {
    field: 'income',
    operator: 'lt' as const,
    value: 250000,
    description: 'Income < 2.5L',
  },
);

const arbBenefit: fc.Arbitrary<Benefit> = fc.constantFrom(
  { type: 'monetary' as const, amount: 1000, description: 'Cash 1k' },
  { type: 'monetary' as const, amount: 5000, description: 'Cash 5k' },
  { type: 'non-monetary' as const, amount: null, description: 'Training' },
  { type: 'non-monetary' as const, amount: null, description: 'Mentorship' },
);

const arbDocument: fc.Arbitrary<DocumentRequirement> = fc.constantFrom(
  {
    documentName: 'Aadhaar',
    description: 'National ID',
    format: 'PDF',
    required: true,
  },
  {
    documentName: 'PAN',
    description: 'Tax ID',
    format: 'PDF',
    required: true,
  },
  {
    documentName: 'Income Certificate',
    description: 'Issued by tehsildar',
    format: 'PDF',
    required: false,
  },
);

const arbStep: fc.Arbitrary<ApplicationStep> = fc.constantFrom(
  { stepNumber: 1, action: 'Visit portal', expectedOutcome: 'Logged in' },
  { stepNumber: 2, action: 'Upload docs', expectedOutcome: 'Submitted' },
  { stepNumber: 3, action: 'Wait for review', expectedOutcome: 'Approved' },
);

/**
 * Pool of candidate deadlines including `null`. Limiting to a handful of
 * dates ensures multiple schemes regularly share the same canonical
 * day-precision value (so `differs` is sometimes false).
 */
const arbDeadline: fc.Arbitrary<Date | null> = fc.constantFrom(
  null,
  new Date('2025-01-15T00:00:00Z'),
  new Date('2025-04-01T08:00:00Z'),
  new Date('2025-04-01T20:00:00Z'), // same day as the previous → canonicalises identically
  new Date('2025-12-31T23:59:00Z'),
);

const arbCriteriaList: fc.Arbitrary<EligibilityCriterion[]> = fc.array(
  arbCriterion,
  { minLength: 0, maxLength: 3 },
);

const arbBenefitList: fc.Arbitrary<Benefit[]> = fc.array(arbBenefit, {
  minLength: 0,
  maxLength: 3,
});

const arbDocList: fc.Arbitrary<DocumentRequirement[] | null> = fc.option(
  fc.array(arbDocument, { minLength: 0, maxLength: 3 }),
  { nil: null, freq: 4 },
);

const arbStepList: fc.Arbitrary<ApplicationStep[] | null> = fc.option(
  fc.array(arbStep, { minLength: 0, maxLength: 3 }),
  { nil: null, freq: 4 },
);

/**
 * Arbitrary scheme: only the comparison-relevant fields vary; all other
 * fields use `makeScheme`'s stable defaults. Each generated scheme gets a
 * unique id (auto-assigned by the counter) so duplicate-id validation is
 * not in scope for this property.
 */
const arbScheme: fc.Arbitrary<Scheme> = fc
  .record({
    eligibilityCriteria: arbCriteriaList,
    benefits: arbBenefitList,
    deadline: arbDeadline,
    requiredDocuments: arbDocList,
    applicationSteps: arbStepList,
  })
  .map((parts) => makeScheme(parts));

/**
 * Selection of 2 or 3 schemes — the exact range Requirement 24.1/24.3
 * permit and the precondition of Property 22.
 */
const arbSchemeSelection: fc.Arbitrary<Scheme[]> = fc.array(arbScheme, {
  minLength: MIN_COMPARISON_SCHEMES,
  maxLength: MAX_COMPARISON_SCHEMES,
});

const arbAttributeKey: fc.Arbitrary<ComparisonAttributeKey> = fc.constantFrom(
  ...COMPARISON_ATTRIBUTE_KEYS,
);

// ─── Reference oracle ────────────────────────────────────────────────────────

/**
 * Reference predicate for Property 22: the canonical values across the
 * supplied schemes are deemed to differ iff they don't all collapse to a
 * single distinct string. This mirrors the cell-highlighting rule from
 * Requirement 24.4 without depending on any of the helpers under test
 * other than `canonicaliseAttribute`, which is the documented contract
 * for "values differ across the selected schemes".
 */
function expectedDiffers(
  key: ComparisonAttributeKey,
  schemes: ReadonlyArray<Scheme>,
): boolean {
  if (schemes.length < 2) return false;
  const canonical = new Set(schemes.map((s) => canonicaliseAttribute(key, s)));
  return canonical.size > 1;
}

// ─── Property tests ──────────────────────────────────────────────────────────

describe('Property 22: Scheme Comparison Difference Highlighting', () => {
  // Core biconditional: differs iff canonical values are not all equal.
  it('attributeDiffersAcross is true iff canonical values differ across selection (Req 24.4)', () => {
    fc.assert(
      fc.property(arbSchemeSelection, arbAttributeKey, (schemes, key) => {
        expect(attributeDiffersAcross(key, schemes)).toBe(
          expectedDiffers(key, schemes),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Builder coherence: every `differs` flag emitted by `buildSchemeComparison`
  // matches the same biconditional, for every attribute row.
  it('buildSchemeComparison.differs flag matches the biconditional for every attribute (Req 24.4)', () => {
    fc.assert(
      fc.property(arbSchemeSelection, (schemes) => {
        const result = buildSchemeComparison(schemes);
        for (const row of result.attributes) {
          const key = row.attributeName as ComparisonAttributeKey;
          expect(row.differs).toBe(expectedDiffers(key, schemes));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Permutation invariance: highlighting is a property of the *set* of
  // schemes selected, not the order they were selected in. Citizens
  // reordering the columns SHALL not flip a row's highlight state.
  it('differs flag is invariant under permutation of the selected schemes (Req 24.4)', () => {
    fc.assert(
      fc.property(arbSchemeSelection, arbAttributeKey, (schemes, key) => {
        const direct = attributeDiffersAcross(key, schemes);
        const reversed = attributeDiffersAcross(key, [...schemes].reverse());
        expect(reversed).toBe(direct);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // All-identical degenerate case: a selection built from clones of a
  // single scheme SHALL have `differs === false` on every attribute. This
  // is the "←" direction of the biconditional made explicit.
  it('a selection of identical schemes never highlights any attribute (Req 24.4)', () => {
    fc.assert(
      fc.property(
        arbScheme,
        fc.integer({ min: MIN_COMPARISON_SCHEMES, max: MAX_COMPARISON_SCHEMES }),
        (scheme, n) => {
          // Clone the scheme `n` times — distinct ids, identical attributes.
          const clones = Array.from({ length: n }, (_, i) => ({
            ...scheme,
            id: `clone-${i}-${scheme.id}`,
          }));
          for (const key of COMPARISON_ATTRIBUTE_KEYS) {
            expect(attributeDiffersAcross(key, clones)).toBe(false);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
