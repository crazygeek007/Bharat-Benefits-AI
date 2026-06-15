/**
 * Property-based tests for incompatibility warnings produced when a citizen
 * saves clashing schemes.
 *
 * **Property 12: Incompatibility Warning on Save**
 * **Validates: Requirements 7.3**
 *
 * Property statement (from design.md):
 * "For any pair of schemes that have a `cannot_combine_with` relationship,
 *  when a citizen attempts to save both, the system SHALL produce a warning
 *  containing the conflict explanation and the official rule, regardless of
 *  the order in which the schemes are saved."
 *
 * The tests below split this universal claim into four sub-properties so
 * that a counter-example points at the precise invariant that broke:
 *
 *   1. Order independence — for any pair (A, B) with a `cannot_combine_with`
 *      row, swapping the save order of A and B (and equivalently, swapping
 *      the row's stored direction) MUST yield an identical warning.
 *   2. Warning content — the warning's `rule` and `sourceUrl` MUST be drawn
 *      verbatim from the originating row.
 *   3. Canonical ordering — every produced warning MUST satisfy
 *      `schemeIdA < schemeIdB` lexicographically so equivalent warnings
 *      collapse to a single representation.
 *   4. No false warnings — for any pair with no `cannot_combine_with` row,
 *      no warning MUST be produced (default-compatible per Req 7.7).
 *
 * The tests drive `CompatibilityEngine.checkSavedSchemesCompatibility`
 * against an in-memory fake Prisma implementation built specifically for
 * this file, so the property is exercised end-to-end (saved-scheme query →
 * compatibility query → deduplication → canonical ordering) without
 * depending on a real database.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  CompatibilityEngine,
  type CompatibilityEnginePrisma,
  type CompatibilityRow,
  type CompatibilityWhere,
  type SavedSchemeRow,
} from './compatibility-engine';

const NUM_RUNS = 150;

// ─── In-memory fake Prisma ──────────────────────────────────────────────────

/**
 * Mirrors the surface area `CompatibilityEngine` uses, with a structurally
 * faithful interpretation of the `OR`/`{ in: [...] }` filter shapes that the
 * engine emits. Tests pass a list of compatibility rows, a name registry,
 * and the saved-scheme rows for a single `userId`.
 */
function rowMatchesIdFilter(
  rowValue: string,
  filter: string | { in: string[] } | undefined,
): boolean {
  if (filter === undefined) return true;
  if (typeof filter === 'string') return rowValue === filter;
  if (filter && Array.isArray(filter.in)) return filter.in.includes(rowValue);
  return true;
}

function rowMatchesRelationshipType(
  rowValue: string,
  filter: string | { in: string[] } | undefined,
): boolean {
  if (filter === undefined) return true;
  if (typeof filter === 'string') return rowValue === filter;
  if (filter && Array.isArray(filter.in)) return filter.in.includes(rowValue);
  return true;
}

function rowMatches(row: CompatibilityRow, where: CompatibilityWhere | undefined): boolean {
  if (!where) return true;
  if (where.OR && !where.OR.some((sub) => rowMatches(row, sub))) return false;
  if (where.schemeId !== undefined && !rowMatchesIdFilter(row.schemeId, where.schemeId)) {
    return false;
  }
  if (
    where.relatedSchemeId !== undefined &&
    !rowMatchesIdFilter(row.relatedSchemeId, where.relatedSchemeId)
  ) {
    return false;
  }
  if (
    where.relationshipType !== undefined &&
    !rowMatchesRelationshipType(row.relationshipType, where.relationshipType)
  ) {
    return false;
  }
  return true;
}

interface FakeDbInput {
  rows: CompatibilityRow[];
  schemes: Array<{ id: string; name: string }>;
  saved: SavedSchemeRow[];
  userId: string;
}

function fakeDb(input: FakeDbInput): CompatibilityEnginePrisma {
  const byId = new Map(input.schemes.map((s) => [s.id, s]));
  return {
    schemeCompatibility: {
      async findMany({ where, include }) {
        const matched = input.rows.filter((row) => rowMatches(row, where));
        if (!include) return matched;
        return matched.map((row) => ({
          ...row,
          scheme: include.scheme ? byId.get(row.schemeId) ?? null : row.scheme,
          relatedScheme: include.relatedScheme
            ? byId.get(row.relatedSchemeId) ?? null
            : row.relatedScheme,
        }));
      },
    },
    scheme: {
      async findMany({ where }) {
        if (!where || !where.id || !where.id.in) return input.schemes;
        const wanted = new Set(where.id.in);
        return input.schemes.filter((s) => wanted.has(s.id));
      },
    },
    savedScheme: {
      async findMany({ where }) {
        return where.userId === input.userId ? input.saved : [];
      },
    },
  };
}

// ─── Arbitraries ────────────────────────────────────────────────────────────

/**
 * Two distinct scheme ids drawn from a small alphabet so that:
 *   - a meaningful number of pairs are generated rather than astronomically
 *     unique strings,
 *   - shrinking lands on short, readable counter-examples,
 *   - lexicographic ordering is well-defined and deterministic.
 */
const arbSchemeId = fc.stringMatching(/^[A-Z]{1,4}$/);

/** Two distinct ids, with no ordering assumption. */
const arbDistinctPair: fc.Arbitrary<[string, string]> = fc
  .tuple(arbSchemeId, arbSchemeId)
  .filter(([a, b]) => a !== b);

/**
 * A non-empty official rule. We exclude the empty string because the
 * property explicitly asserts that the warning's `rule` equals the row's
 * `officialRule`, and the engine substitutes empty string for null —
 * separating those concerns keeps the property statements unambiguous.
 */
const arbOfficialRule = fc
  .string({ minLength: 1, maxLength: 120 })
  .filter((s) => s.trim().length > 0);

const arbSourceUrl = fc.option(
  fc
    .stringMatching(/^[A-Za-z0-9_/-]{1,40}$/)
    .map((suffix) => `https://example.gov.in/${suffix}`),
  { nil: null },
);

const USER_ID = 'user-1';

/**
 * Generator for the "cannot_combine_with" scenario. Produces:
 *   - a pair (A, B),
 *   - a row stored in either direction (A→B or B→A) — picked randomly to
 *     model the fact that the database may store the relation either way,
 *   - the saved-scheme order (forward or reverse) — so we can compare the
 *     warning produced when the citizen saves A then B versus B then A.
 */
interface CannotPairScenario {
  ids: [string, string];
  rowDirection: 'forward' | 'reverse';
  saveOrder: 'forward' | 'reverse';
  officialRule: string;
  sourceUrl: string | null;
}

const arbCannotPairScenario: fc.Arbitrary<CannotPairScenario> = fc.record({
  ids: arbDistinctPair,
  rowDirection: fc.constantFrom<'forward' | 'reverse'>('forward', 'reverse'),
  saveOrder: fc.constantFrom<'forward' | 'reverse'>('forward', 'reverse'),
  officialRule: arbOfficialRule,
  sourceUrl: arbSourceUrl,
});

/**
 * Build the engine inputs (rows, schemes, saved) for a given scenario.
 */
function buildScenario(scenario: CannotPairScenario): FakeDbInput {
  const [a, b] = scenario.ids;
  const [rowFrom, rowTo] =
    scenario.rowDirection === 'forward' ? [a, b] : [b, a];
  const row: CompatibilityRow = {
    id: `row-${rowFrom}-${rowTo}`,
    schemeId: rowFrom,
    relatedSchemeId: rowTo,
    relationshipType: 'cannot_combine_with',
    officialRule: scenario.officialRule,
    sourceUrl: scenario.sourceUrl,
    verified: true,
  };
  const schemes = [
    { id: a, name: `Scheme ${a}` },
    { id: b, name: `Scheme ${b}` },
  ];
  const saved: SavedSchemeRow[] =
    scenario.saveOrder === 'forward'
      ? [{ scheme: schemes[0] }, { scheme: schemes[1] }]
      : [{ scheme: schemes[1] }, { scheme: schemes[0] }];
  return { rows: [row], schemes, saved, userId: USER_ID };
}

// ─── Property tests ─────────────────────────────────────────────────────────

describe('Property 12: Incompatibility Warning on Save', () => {
  // ── (1) Order independence ────────────────────────────────────────────────
  // The same pair (A, B) with the same `cannot_combine_with` row produces
  // the same warning whether the citizen saved A first or B first, AND
  // whether the row is stored as A→B or B→A.
  it('produces an identical warning regardless of save order or row direction', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          ids: arbDistinctPair,
          officialRule: arbOfficialRule,
          sourceUrl: arbSourceUrl,
        }),
        async ({ ids, officialRule, sourceUrl }) => {
          const variants: Array<['forward' | 'reverse', 'forward' | 'reverse']> = [
            ['forward', 'forward'],
            ['forward', 'reverse'],
            ['reverse', 'forward'],
            ['reverse', 'reverse'],
          ];

          const results = [];
          for (const [rowDirection, saveOrder] of variants) {
            const input = buildScenario({
              ids,
              rowDirection,
              saveOrder,
              officialRule,
              sourceUrl,
            });
            const engine = new CompatibilityEngine(fakeDb(input));
            results.push(await engine.checkSavedSchemesCompatibility(USER_ID));
          }

          // Every variant yields exactly one warning…
          for (const r of results) {
            expect(r).toHaveLength(1);
          }
          // …and every warning is structurally identical to the first.
          const reference = results[0];
          for (const r of results.slice(1)) {
            expect(r).toEqual(reference);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // ── (2) Warning content ───────────────────────────────────────────────────
  // The warning's `rule` and `sourceUrl` are propagated verbatim from the
  // originating row, regardless of which direction it was stored.
  it('propagates the official rule and sourceUrl verbatim from the row', async () => {
    await fc.assert(
      fc.asyncProperty(arbCannotPairScenario, async (scenario) => {
        const input = buildScenario(scenario);
        const engine = new CompatibilityEngine(fakeDb(input));
        const warnings = await engine.checkSavedSchemesCompatibility(USER_ID);

        expect(warnings).toHaveLength(1);
        const w = warnings[0];
        expect(w.rule).toBe(scenario.officialRule);
        expect(w.sourceUrl).toBe(scenario.sourceUrl);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // ── (3) Canonical ordering ────────────────────────────────────────────────
  // Every produced warning satisfies schemeIdA < schemeIdB lexicographically,
  // and the names attached to those ids are consistent with the registry.
  it('orders schemeIdA < schemeIdB lexicographically in every warning', async () => {
    await fc.assert(
      fc.asyncProperty(arbCannotPairScenario, async (scenario) => {
        const input = buildScenario(scenario);
        const engine = new CompatibilityEngine(fakeDb(input));
        const warnings = await engine.checkSavedSchemesCompatibility(USER_ID);

        expect(warnings).toHaveLength(1);
        const w = warnings[0];
        expect(w.schemeIdA < w.schemeIdB).toBe(true);
        // Name attribution follows the canonical id order.
        expect(w.schemeNameA).toBe(`Scheme ${w.schemeIdA}`);
        expect(w.schemeNameB).toBe(`Scheme ${w.schemeIdB}`);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // ── (4) No false warnings ─────────────────────────────────────────────────
  // For any pair (A, B) with no `cannot_combine_with` row — including the
  // case where only a `can_combine_with` row exists — no warning is emitted
  // (default-compatible per Req 7.7).
  it('produces no warning when no cannot_combine_with row exists', async () => {
    const arbNonConflictRelType = fc.constantFrom<string>(
      // No row at all is modelled by the empty rows[] case below; here we
      // exercise the case where a row exists but is not cannot_combine_with.
      'can_combine_with',
      'prerequisite_schemes',
    );

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          ids: arbDistinctPair,
          includeRow: fc.boolean(),
          relType: arbNonConflictRelType,
          saveOrder: fc.constantFrom<'forward' | 'reverse'>('forward', 'reverse'),
        }),
        async ({ ids, includeRow, relType, saveOrder }) => {
          const [a, b] = ids;
          const schemes = [
            { id: a, name: `Scheme ${a}` },
            { id: b, name: `Scheme ${b}` },
          ];
          const rows: CompatibilityRow[] = includeRow
            ? [
                {
                  id: `row-${a}-${b}`,
                  schemeId: a,
                  relatedSchemeId: b,
                  relationshipType: relType,
                  officialRule: 'unrelated rule',
                  sourceUrl: null,
                  verified: true,
                },
              ]
            : [];
          const saved: SavedSchemeRow[] =
            saveOrder === 'forward'
              ? [{ scheme: schemes[0] }, { scheme: schemes[1] }]
              : [{ scheme: schemes[1] }, { scheme: schemes[0] }];

          const engine = new CompatibilityEngine(
            fakeDb({ rows, schemes, saved, userId: USER_ID }),
          );
          const warnings = await engine.checkSavedSchemesCompatibility(USER_ID);
          expect(warnings).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
