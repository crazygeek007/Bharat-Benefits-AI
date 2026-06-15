/**
 * Property-based tests for the Change_Detector version-history contract.
 *
 * **Property 26: Version History Completeness**
 * **Validates: Requirements 14.1, 14.2**
 *
 * Property statement (from design.md):
 *   "For any scheme update detected by the Change_Detector, the recorded
 *    change entry SHALL contain: the previous value, new value, change
 *    date, and source URL. The system SHALL retain at least the 50 most
 *    recent versions per scheme."
 *
 * Two sub-properties are exercised, mirroring the two prongs of the
 * statement above:
 *
 *   A. *Completeness* — for any sequence of detected updates, every
 *      persisted `SchemeVersion` row carries a non-null new value, the
 *      exact source URL passed in, the wall-clock timestamp at the
 *      moment of detection, and (for non-baseline rows) a non-null
 *      previous value equal to the prior version's new value.
 *   B. *Retention* — for any sequence of N updates that produce N
 *      distinct versions, the post-prune state retains exactly
 *      `min(N, 50)` rows, and the retained rows are the most recent
 *      `min(N, 50)` by version number.
 *
 * Both properties are driven by an in-memory Prisma fake — the same
 * fake shape used by `change-detector.test.ts` — so no database is
 * required. Each property runs 100 examples to comfortably exceed the
 * design's documented minimum (Section: Property-Based Testing
 * Configuration → "Minimum iterations: 100 per property test").
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { MIN_VERSION_HISTORY } from '@bharat-benefits/shared';
import type {
  ApplicationStep,
  Benefit,
  DocumentRequirement,
  EligibilityCriterion,
  SchemeObject,
} from '@bharat-benefits/shared';
import {
  ChangeDetectorService,
  DIFFABLE_SCHEME_FIELDS,
  type ChangeDetectorPrisma,
  type SchemeVersionRow,
} from './change-detector';

const NUM_RUNS = 100;

// ─── In-memory Prisma fake ───────────────────────────────────────────────────

interface FakeState {
  versions: SchemeVersionRow[];
  nextId: number;
}

function makeFakeState(): FakeState {
  return { versions: [], nextId: 1 };
}

function makeFakePrisma(state: FakeState): ChangeDetectorPrisma {
  return {
    schemeVersion: {
      async findFirst({ where, orderBy }) {
        const rows = state.versions
          .filter((v) => v.schemeId === where.schemeId)
          .sort((a, b) =>
            orderBy.versionNumber === 'desc'
              ? b.versionNumber - a.versionNumber
              : a.versionNumber - b.versionNumber,
          );
        return rows[0] ?? null;
      },
      async findMany({ where, orderBy, take, skip }) {
        const rows = state.versions
          .filter((v) => v.schemeId === where.schemeId)
          .sort((a, b) =>
            orderBy.versionNumber === 'desc'
              ? b.versionNumber - a.versionNumber
              : a.versionNumber - b.versionNumber,
          );
        const start = skip ?? 0;
        const end = take === undefined ? rows.length : start + take;
        return rows.slice(start, end);
      },
      async create({ data }) {
        const row: SchemeVersionRow = {
          id: `version-${state.nextId++}`,
          schemeId: data.schemeId,
          previousValues: data.previousValues,
          newValues: data.newValues,
          changedFields: data.changedFields,
          sourceUrl: data.sourceUrl,
          changeDetectedAt: data.changeDetectedAt,
          versionNumber: data.versionNumber,
        };
        state.versions.push(row);
        return row;
      },
      async deleteMany({ where }) {
        const before = state.versions.length;
        state.versions = state.versions.filter(
          (v) =>
            !(
              v.schemeId === where.schemeId &&
              v.versionNumber < where.versionNumber.lt
            ),
        );
        return { count: before - state.versions.length };
      },
    },
    savedScheme: {
      async findMany() {
        // Not exercised by these properties.
        return [];
      },
    },
  };
}

// ─── Atomic arbitraries ──────────────────────────────────────────────────────

const arbCriterionValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

const arbEligibilityCriterion: fc.Arbitrary<EligibilityCriterion> = fc.record({
  field: fc.string({ minLength: 1, maxLength: 24 }),
  operator: fc.constantFrom<EligibilityCriterion['operator']>(
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'between',
  ),
  value: arbCriterionValue,
  description: fc.string({ maxLength: 64 }),
});

/**
 * Finite amounts only — `-0` is normalised to `0` because Prisma's JSON
 * column round-trips through `JSON.stringify` which collapses `-0` to
 * `0`, and we use deep value equality on stored payloads.
 */
const arbFiniteAmount: fc.Arbitrary<number> = fc
  .float({ noNaN: true, noDefaultInfinity: true })
  .map((n) => (Object.is(n, -0) ? 0 : n));

const arbBenefit: fc.Arbitrary<Benefit> = fc.record({
  type: fc.constantFrom<Benefit['type']>('monetary', 'non-monetary'),
  amount: fc.option(arbFiniteAmount, { nil: null }),
  description: fc.string({ maxLength: 64 }),
});

const arbApplicationStep: fc.Arbitrary<ApplicationStep> = fc.record({
  stepNumber: fc.integer({ min: 1, max: 20 }),
  action: fc.string({ minLength: 1, maxLength: 32 }),
  expectedOutcome: fc.string({ maxLength: 32 }),
});

const arbDocumentRequirement: fc.Arbitrary<DocumentRequirement> = fc.record({
  documentName: fc.string({ minLength: 1, maxLength: 24 }),
  description: fc.string({ maxLength: 32 }),
  format: fc.string({ maxLength: 12 }),
  required: fc.boolean(),
});

/**
 * Realistic-shape `SchemeObject` arbitrary. The shape lines up with the
 * crawler's serialization arbitrary so the snapshots that flow through
 * `detectChanges` are representative of production payloads. Strings
 * are kept short to bound the size of generated histories — version
 * history retention is the property under test, not throughput.
 */
const arbScheme: fc.Arbitrary<SchemeObject> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 24 }),
  description: fc.string({ minLength: 1, maxLength: 64 }),
  eligibilityCriteria: fc.array(arbEligibilityCriterion, {
    minLength: 1,
    maxLength: 3,
  }),
  benefits: fc.array(arbBenefit, { minLength: 1, maxLength: 3 }),
  sourceUrl: fc.string({ minLength: 1, maxLength: 32 }),
  ministry: fc.string({ minLength: 1, maxLength: 24 }),
  applicationProcess: fc.option(
    fc.array(arbApplicationStep, { maxLength: 3 }),
    { nil: null },
  ),
  requiredDocuments: fc.option(
    fc.array(arbDocumentRequirement, { maxLength: 3 }),
    { nil: null },
  ),
  deadline: fc.option(fc.date({ noInvalidDate: true }), { nil: null }),
});

const arbSourceUrl: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 32 })
  // Source URL is stored as a non-null string by `detectChanges` (it
  // throws on empty input), so we bias toward a valid-looking host.
  .map((s) => `https://example.gov.in/${s.replace(/\s+/g, '-')}`);

const arbDate: fc.Arbitrary<Date> = fc
  .integer({
    min: new Date('2020-01-01T00:00:00Z').getTime(),
    max: new Date('2030-01-01T00:00:00Z').getTime(),
  })
  .map((ms) => new Date(ms));

// ─── Sequence builders ───────────────────────────────────────────────────────

interface UpdateStep {
  scheme: SchemeObject;
  sourceUrl: string;
  now: Date;
}

/**
 * A sequence of update steps that are *guaranteed distinct* in their
 * snapshot — each step's `name` field is suffixed with the step index,
 * so even if the random arbitraries happen to coincide, every step
 * produces a fresh `SchemeVersion` row. This is what we need to drive
 * the retention property: we want N updates to produce N versions.
 */
const arbDistinctUpdateSequence: fc.Arbitrary<UpdateStep[]> = fc
  .array(
    fc.tuple(arbScheme, arbSourceUrl, arbDate),
    { minLength: 1, maxLength: 75 },
  )
  .map((tuples) =>
    tuples.map(([scheme, sourceUrl, now], index) => ({
      scheme: { ...scheme, name: `${scheme.name}#v${index}` },
      sourceUrl,
      now,
    })),
  );

/**
 * Mixed update sequence — some steps deliberately reuse the prior
 * snapshot, exercising the "no-op" branch of `detectChanges`. Used by
 * the completeness property so we also confirm that no row is written
 * (and therefore nothing to verify) when nothing changed.
 */
const arbMixedUpdateSequence: fc.Arbitrary<
  Array<UpdateStep & { reuse: boolean }>
> = fc
  .array(
    fc.tuple(arbScheme, arbSourceUrl, arbDate, fc.boolean()),
    { minLength: 1, maxLength: 20 },
  )
  .map((tuples) =>
    tuples.map(([scheme, sourceUrl, now, reuse], index) => ({
      scheme: { ...scheme, name: `${scheme.name}#v${index}` },
      sourceUrl,
      now,
      reuse,
    })),
  );

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a `ChangeDetectorService` whose clock returns the next value
 * from a mutable cell. Each step in a sequence sets the cell before
 * calling `detectChanges`, so the row's `changeDetectedAt` is exactly
 * the timestamp the caller intended.
 */
function makeServiceWithClock(state: FakeState): {
  service: ChangeDetectorService;
  setNow: (d: Date) => void;
} {
  let current = new Date(0);
  const service = new ChangeDetectorService({
    prisma: makeFakePrisma(state),
    now: () => current,
  });
  return {
    service,
    setNow: (d) => {
      current = d;
    },
  };
}

// ─── Property A: Completeness of change entry ────────────────────────────────

describe('Property 26 — Version History Completeness (Validates: Requirements 14.1, 14.2)', () => {
  it('every recorded change entry contains previousValue, newValue, changeDate, and sourceUrl', async () => {
    await fc.assert(
      fc.asyncProperty(arbMixedUpdateSequence, async (steps) => {
        const state = makeFakeState();
        const { service, setNow } = makeServiceWithClock(state);
        const schemeId = 'scheme-under-test';

        // Run the full sequence, tracking each step's intended snapshot
        // so non-baseline rows can be checked against the prior step.
        let prevNewValues: Record<string, unknown> | null = null;
        let lastEffectiveStep: UpdateStep | null = null;

        for (const step of steps) {
          // When `reuse` is true and we have a previous effective step,
          // re-detect with the *exact* prior scheme — this MUST be a no-op
          // (no row written, no version-number consumed).
          const effective: UpdateStep =
            step.reuse && lastEffectiveStep
              ? { ...lastEffectiveStep, sourceUrl: step.sourceUrl, now: step.now }
              : step;

          setNow(effective.now);
          const result = await service.detectChanges(
            schemeId,
            effective.scheme,
            effective.sourceUrl,
          );

          if (result.versionId === null) {
            // No-op: nothing was recorded, so there's nothing to check
            // for *this* step. Used only for sanity — `changedFields`
            // must be empty in this branch.
            expect(result.changedFields).toEqual([]);
            continue;
          }

          // A change was detected → a row was created.
          const row = state.versions.find((v) => v.id === result.versionId);
          expect(row).toBeDefined();
          if (!row) return; // narrowing for TS

          // (1) New value: always present and non-null.
          expect(row.newValues).not.toBeNull();
          expect(typeof row.newValues).toBe('object');

          // (2) Source URL: the exact URL passed to detectChanges.
          expect(row.sourceUrl).toBe(effective.sourceUrl);

          // (3) Change date: the wall-clock value at the moment of
          //     detection — we control the clock above, so it must
          //     match exactly.
          expect(row.changeDetectedAt).toBeInstanceOf(Date);
          expect(row.changeDetectedAt.getTime()).toBe(effective.now.getTime());

          // (4) Previous value: null on the very first version, equal
          //     to the prior recorded row's `newValues` afterwards.
          if (prevNewValues === null) {
            expect(row.previousValues).toBeNull();
            expect(row.versionNumber).toBe(1);
          } else {
            expect(row.previousValues).not.toBeNull();
            expect(row.previousValues).toEqual(prevNewValues);
          }

          // changedFields is non-empty whenever a row is recorded,
          // and is a subset of the diffable fields.
          const changed = row.changedFields.split(',').filter(Boolean);
          expect(changed.length).toBeGreaterThan(0);
          for (const field of changed) {
            expect(DIFFABLE_SCHEME_FIELDS as readonly string[]).toContain(field);
          }

          prevNewValues = row.newValues;
          lastEffectiveStep = effective;
        }

        // Final consistency check: version numbers form a contiguous
        // sequence 1..N (no gaps, no duplicates). This follows from
        // (1)+(4) above — each recorded row sets versionNumber to
        // prev.versionNumber + 1 — but verifying it directly catches
        // any future regression that breaks monotonicity.
        const ordered = [...state.versions].sort(
          (a, b) => a.versionNumber - b.versionNumber,
        );
        for (let i = 0; i < ordered.length; i++) {
          expect(ordered[i].versionNumber).toBe(i + 1);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // ─── Property B: Retention of ≥50 most recent versions ─────────────────────

  it('retains at least the MIN_VERSION_HISTORY (=50) most recent versions per scheme', async () => {
    await fc.assert(
      fc.asyncProperty(arbDistinctUpdateSequence, async (steps) => {
        const state = makeFakeState();
        const { service, setNow } = makeServiceWithClock(state);
        const schemeId = 'scheme-under-test';

        for (const step of steps) {
          setNow(step.now);
          await service.detectChanges(schemeId, step.scheme, step.sourceUrl);
        }

        // Every step in this sequence is guaranteed distinct (the
        // generator stamps the index into the name field), so each
        // step recorded a row. The total version count therefore
        // equals the sequence length.
        const totalRecorded = state.versions.length;
        expect(totalRecorded).toBe(steps.length);

        const deleted = await service.pruneOldVersions(schemeId);
        const remaining = state.versions.length;

        if (totalRecorded <= MIN_VERSION_HISTORY) {
          // Below the floor — pruning is a no-op.
          expect(deleted).toBe(0);
          expect(remaining).toBe(totalRecorded);
        } else {
          // Above the floor — exactly MIN_VERSION_HISTORY remain, and
          // they are the most-recent ones (highest versionNumbers).
          expect(deleted).toBe(totalRecorded - MIN_VERSION_HISTORY);
          expect(remaining).toBe(MIN_VERSION_HISTORY);

          const remainingNumbers = state.versions
            .map((v) => v.versionNumber)
            .sort((a, b) => a - b);
          const expectedFirst = totalRecorded - MIN_VERSION_HISTORY + 1;
          expect(remainingNumbers[0]).toBe(expectedFirst);
          expect(remainingNumbers[remainingNumbers.length - 1]).toBe(
            totalRecorded,
          );
        }

        // Universal floor — the system always retains *at least*
        // min(N, 50) versions, regardless of how big N is.
        expect(remaining).toBeGreaterThanOrEqual(
          Math.min(totalRecorded, MIN_VERSION_HISTORY),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
