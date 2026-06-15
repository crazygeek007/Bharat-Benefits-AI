/**
 * Unit tests for the Compatibility Engine.
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.7.
 *
 * Covers:
 *   - `getRelationships` returns outgoing + incoming combine relationships
 *     and only outgoing prerequisites for the given scheme (Req 7.1, 7.2).
 *   - `checkCompatibility` returns `compatible: false` with the official
 *     rule when a `cannot_combine_with` row exists in either direction
 *     (Req 7.2), `compatible: true` with the rule when only a
 *     `can_combine_with` row exists, and default-compatible when no rows
 *     exist (Req 7.7). A scheme is always compatible with itself.
 *   - `checkSavedSchemesCompatibility` deduplicates pairwise warnings,
 *     produces a stable canonical ordering inside each warning, and
 *     surfaces the official rule (Req 7.3 / Property 12 invariant).
 *   - `getPrerequisites` walks the graph transitively, returns a valid
 *     topological ordering with 1-indexed `order`, and excludes the root
 *     scheme from the chain (Req 7.4).
 *   - `buildPrerequisiteOrder` is a pure helper that satisfies the
 *     topological-order invariant and detects cycles.
 */

import { describe, it, expect } from 'vitest';
import {
  CompatibilityEngine,
  buildPrerequisiteOrder,
  type CompatibilityEnginePrisma,
  type CompatibilityRow,
  type SavedSchemeRow,
} from './compatibility-engine';

// ─── Test fakes ──────────────────────────────────────────────────────────────

interface FakeDbInput {
  rows?: CompatibilityRow[];
  schemes?: Array<{ id: string; name: string }>;
  saved?: Record<string, SavedSchemeRow[]>;
}

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

interface WhereClause {
  schemeId?: string | { in: string[] };
  relatedSchemeId?: string | { in: string[] };
  relationshipType?: string | { in: string[] };
  OR?: WhereClause[];
}

function rowMatches(row: CompatibilityRow, where: WhereClause | undefined): boolean {
  if (!where) return true;
  if (where.OR) {
    if (!where.OR.some((sub) => rowMatches(row, sub))) return false;
  }
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

function fakeDb(input: FakeDbInput = {}): CompatibilityEnginePrisma {
  const allRows = input.rows ?? [];
  const allSchemes = input.schemes ?? [];
  const saved = input.saved ?? {};

  return {
    schemeCompatibility: {
      async findMany({ where, include }) {
        const matched = allRows.filter((row) => rowMatches(row, where));
        if (!include) return matched;
        // When `include` is requested, attach the latest available scheme
        // info from `allSchemes` (mirroring Prisma's eager loading).
        const byId = new Map(allSchemes.map((s) => [s.id, s]));
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
        if (!where || !where.id || !where.id.in) return allSchemes;
        const wanted = new Set(where.id.in);
        return allSchemes.filter((s) => wanted.has(s.id));
      },
    },
    savedScheme: {
      async findMany({ where }) {
        return saved[where.userId] ?? [];
      },
    },
  };
}

// ─── buildPrerequisiteOrder (pure helper) ────────────────────────────────────

describe('buildPrerequisiteOrder', () => {
  it('returns an empty list when the root has no prerequisites', () => {
    const map = new Map<string, string[]>([['A', []]]);
    expect(buildPrerequisiteOrder('A', map)).toEqual([]);
  });

  it('produces a valid topological order (deepest dependencies first)', () => {
    // A → B → C, A → D. Output must place B and C before A; C before B.
    const map = new Map<string, string[]>([
      ['A', ['B', 'D']],
      ['B', ['C']],
      ['C', []],
      ['D', []],
    ]);
    const order = buildPrerequisiteOrder('A', map);

    // Root scheme is excluded from the chain.
    expect(order).not.toContain('A');

    // Every prerequisite appears before any scheme that depends on it.
    const indexOf = (id: string) => order.indexOf(id);
    expect(indexOf('C')).toBeLessThan(indexOf('B'));
    // B and D are direct prereqs of A — they must both appear in the output.
    expect(order).toContain('B');
    expect(order).toContain('D');
  });

  it('detects cycles and throws a descriptive error', () => {
    const map = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['A']],
    ]);
    expect(() => buildPrerequisiteOrder('A', map)).toThrow(/Cycle detected/);
  });

  it('detects self-loops as cycles', () => {
    const map = new Map<string, string[]>([['A', ['A']]]);
    expect(() => buildPrerequisiteOrder('A', map)).toThrow(/Self-referential/);
  });

  it('handles diamond-shaped prerequisite graphs (no duplicates in the output)', () => {
    // A → B → D, A → C → D. D should appear exactly once.
    const map = new Map<string, string[]>([
      ['A', ['B', 'C']],
      ['B', ['D']],
      ['C', ['D']],
      ['D', []],
    ]);
    const order = buildPrerequisiteOrder('A', map);
    const dCount = order.filter((id) => id === 'D').length;
    expect(dCount).toBe(1);
    // D must appear before B and before C.
    expect(order.indexOf('D')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('D')).toBeLessThan(order.indexOf('C'));
  });
});

// ─── getRelationships ────────────────────────────────────────────────────────

describe('CompatibilityEngine.getRelationships', () => {
  it('returns combine relationships in both directions and prerequisites only outgoing', async () => {
    const rows: CompatibilityRow[] = [
      // A can combine with B (outgoing).
      {
        id: 'r1',
        schemeId: 'A',
        relatedSchemeId: 'B',
        relationshipType: 'can_combine_with',
        officialRule: 'Both schemes allowed together.',
        sourceUrl: 'https://example.gov.in/r1',
        verified: true,
      },
      // C cannot combine with A (incoming for A).
      {
        id: 'r2',
        schemeId: 'C',
        relatedSchemeId: 'A',
        relationshipType: 'cannot_combine_with',
        officialRule: 'Mutually exclusive.',
        sourceUrl: 'https://example.gov.in/r2',
        verified: true,
      },
      // A requires P (prerequisite, outgoing for A).
      {
        id: 'r3',
        schemeId: 'A',
        relatedSchemeId: 'P',
        relationshipType: 'prerequisite_schemes',
        officialRule: 'Must complete P first.',
        sourceUrl: 'https://example.gov.in/r3',
        verified: true,
      },
      // X requires A (prerequisite, incoming for A — should NOT show up).
      {
        id: 'r4',
        schemeId: 'X',
        relatedSchemeId: 'A',
        relationshipType: 'prerequisite_schemes',
        officialRule: 'X depends on A.',
        sourceUrl: 'https://example.gov.in/r4',
        verified: true,
      },
    ];
    const schemes = [
      { id: 'A', name: 'Scheme A' },
      { id: 'B', name: 'Scheme B' },
      { id: 'C', name: 'Scheme C' },
      { id: 'P', name: 'Scheme P' },
      { id: 'X', name: 'Scheme X' },
    ];

    const engine = new CompatibilityEngine(fakeDb({ rows, schemes }));
    const rels = await engine.getRelationships('A');

    const ids = rels.map((r) => r.relatedSchemeId).sort();
    expect(ids).toEqual(['B', 'C', 'P']);

    const byId = new Map(rels.map((r) => [r.relatedSchemeId, r]));
    expect(byId.get('B')?.type).toBe('can_combine_with');
    expect(byId.get('C')?.type).toBe('cannot_combine_with');
    expect(byId.get('P')?.type).toBe('prerequisite_schemes');

    // Names from eager-loaded scheme data.
    expect(byId.get('B')?.relatedSchemeName).toBe('Scheme B');
    expect(byId.get('C')?.relatedSchemeName).toBe('Scheme C');
    expect(byId.get('P')?.relatedSchemeName).toBe('Scheme P');
  });

  it('returns an empty list for a scheme with no relationships', async () => {
    const engine = new CompatibilityEngine(fakeDb({ rows: [], schemes: [] }));
    const rels = await engine.getRelationships('Z');
    expect(rels).toEqual([]);
  });

  it('rejects an empty schemeId', async () => {
    const engine = new CompatibilityEngine(fakeDb());
    await expect(engine.getRelationships('')).rejects.toThrow(TypeError);
  });

  it('skips rows with unknown relationship types', async () => {
    const rows: CompatibilityRow[] = [
      {
        id: 'r1',
        schemeId: 'A',
        relatedSchemeId: 'B',
        relationshipType: 'mystery_relation',
        officialRule: '',
        sourceUrl: null,
        verified: true,
      },
    ];
    const engine = new CompatibilityEngine(fakeDb({ rows }));
    expect(await engine.getRelationships('A')).toEqual([]);
  });
});

// ─── checkCompatibility ──────────────────────────────────────────────────────

describe('CompatibilityEngine.checkCompatibility', () => {
  it('returns default-compatible when no relationship is on file (Req 7.7)', async () => {
    const engine = new CompatibilityEngine(fakeDb({ rows: [] }));
    const result = await engine.checkCompatibility('A', 'B');
    expect(result).toEqual({ compatible: true, rule: null, sourceUrl: null });
  });

  it('returns incompatible when a cannot_combine_with row exists in either direction (Req 7.2)', async () => {
    const rows: CompatibilityRow[] = [
      {
        id: 'r1',
        schemeId: 'A',
        relatedSchemeId: 'B',
        relationshipType: 'cannot_combine_with',
        officialRule: 'A and B cannot be claimed together.',
        sourceUrl: 'https://example.gov.in/rule',
        verified: true,
      },
    ];
    const engine = new CompatibilityEngine(fakeDb({ rows }));

    const ab = await engine.checkCompatibility('A', 'B');
    const ba = await engine.checkCompatibility('B', 'A');
    expect(ab.compatible).toBe(false);
    expect(ba.compatible).toBe(false);
    expect(ab.rule).toBe('A and B cannot be claimed together.');
    expect(ba.rule).toBe('A and B cannot be claimed together.');
    expect(ab.sourceUrl).toBe('https://example.gov.in/rule');
  });

  it('returns compatible with the official rule for can_combine_with rows', async () => {
    const rows: CompatibilityRow[] = [
      {
        id: 'r1',
        schemeId: 'A',
        relatedSchemeId: 'B',
        relationshipType: 'can_combine_with',
        officialRule: 'A and B may be combined.',
        sourceUrl: 'https://example.gov.in/can',
        verified: true,
      },
    ];
    const engine = new CompatibilityEngine(fakeDb({ rows }));
    const result = await engine.checkCompatibility('A', 'B');
    expect(result.compatible).toBe(true);
    expect(result.rule).toBe('A and B may be combined.');
    expect(result.sourceUrl).toBe('https://example.gov.in/can');
  });

  it('prefers cannot_combine_with over can_combine_with when both exist', async () => {
    const rows: CompatibilityRow[] = [
      {
        id: 'r1',
        schemeId: 'A',
        relatedSchemeId: 'B',
        relationshipType: 'can_combine_with',
        officialRule: 'A and B may be combined.',
        sourceUrl: null,
        verified: true,
      },
      {
        id: 'r2',
        schemeId: 'B',
        relatedSchemeId: 'A',
        relationshipType: 'cannot_combine_with',
        officialRule: 'But not in this case.',
        sourceUrl: 'https://example.gov.in/exception',
        verified: true,
      },
    ];
    const engine = new CompatibilityEngine(fakeDb({ rows }));
    const result = await engine.checkCompatibility('A', 'B');
    expect(result.compatible).toBe(false);
    expect(result.rule).toBe('But not in this case.');
  });

  it('treats a scheme as compatible with itself', async () => {
    const engine = new CompatibilityEngine(fakeDb());
    const result = await engine.checkCompatibility('A', 'A');
    expect(result).toEqual({ compatible: true, rule: null, sourceUrl: null });
  });

  it('rejects empty scheme ids', async () => {
    const engine = new CompatibilityEngine(fakeDb());
    await expect(engine.checkCompatibility('', 'B')).rejects.toThrow(TypeError);
    await expect(engine.checkCompatibility('A', '')).rejects.toThrow(TypeError);
  });
});

// ─── checkSavedSchemesCompatibility ──────────────────────────────────────────

describe('CompatibilityEngine.checkSavedSchemesCompatibility', () => {
  const schemes = [
    { id: 'A', name: 'Scheme A' },
    { id: 'B', name: 'Scheme B' },
    { id: 'C', name: 'Scheme C' },
  ];

  function rowAB(): CompatibilityRow {
    return {
      id: 'r-ab',
      schemeId: 'A',
      relatedSchemeId: 'B',
      relationshipType: 'cannot_combine_with',
      officialRule: 'A and B are mutually exclusive.',
      sourceUrl: 'https://example.gov.in/ab',
      verified: true,
    };
  }

  it('returns one warning per incompatible saved-scheme pair, ordered canonically', async () => {
    const engine = new CompatibilityEngine(
      fakeDb({
        rows: [rowAB()],
        schemes,
        saved: {
          'user-1': [{ scheme: schemes[0] }, { scheme: schemes[1] }],
        },
      }),
    );
    const warnings = await engine.checkSavedSchemesCompatibility('user-1');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      schemeIdA: 'A',
      schemeIdB: 'B',
      schemeNameA: 'Scheme A',
      schemeNameB: 'Scheme B',
      rule: 'A and B are mutually exclusive.',
      sourceUrl: 'https://example.gov.in/ab',
    });
  });

  it('produces identical warnings regardless of the order schemes were saved (Property 12)', async () => {
    const dbForward = fakeDb({
      rows: [rowAB()],
      schemes,
      saved: {
        'user-1': [{ scheme: schemes[0] }, { scheme: schemes[1] }],
      },
    });
    const dbReverse = fakeDb({
      rows: [rowAB()],
      schemes,
      saved: {
        'user-1': [{ scheme: schemes[1] }, { scheme: schemes[0] }],
      },
    });
    const forward = await new CompatibilityEngine(dbForward).checkSavedSchemesCompatibility(
      'user-1',
    );
    const reverse = await new CompatibilityEngine(dbReverse).checkSavedSchemesCompatibility(
      'user-1',
    );
    expect(forward).toEqual(reverse);
  });

  it('deduplicates when the database stores the conflict in both directions', async () => {
    const reverseRow: CompatibilityRow = {
      ...rowAB(),
      id: 'r-ba',
      schemeId: 'B',
      relatedSchemeId: 'A',
    };
    const engine = new CompatibilityEngine(
      fakeDb({
        rows: [rowAB(), reverseRow],
        schemes,
        saved: {
          'user-1': [{ scheme: schemes[0] }, { scheme: schemes[1] }],
        },
      }),
    );
    const warnings = await engine.checkSavedSchemesCompatibility('user-1');
    expect(warnings).toHaveLength(1);
  });

  it('returns an empty list when the citizen has fewer than two saved schemes', async () => {
    const engine = new CompatibilityEngine(
      fakeDb({
        rows: [rowAB()],
        schemes,
        saved: { 'user-1': [{ scheme: schemes[0] }] },
      }),
    );
    expect(await engine.checkSavedSchemesCompatibility('user-1')).toEqual([]);
  });

  it('returns warnings only involving the candidate when one is supplied', async () => {
    // user-1 already has A & C (compatible — no row), now wants to add B.
    // Only the A-B conflict should surface (not an unrelated saved-pair).
    const engine = new CompatibilityEngine(
      fakeDb({
        rows: [rowAB()],
        schemes,
        saved: {
          'user-1': [{ scheme: schemes[0] }, { scheme: schemes[2] }],
        },
      }),
    );
    const warnings = await engine.checkSavedSchemesCompatibility('user-1', 'B');
    expect(warnings).toHaveLength(1);
    expect([warnings[0].schemeIdA, warnings[0].schemeIdB].sort()).toEqual(['A', 'B']);
  });

  it('rejects an empty userId', async () => {
    const engine = new CompatibilityEngine(fakeDb());
    await expect(engine.checkSavedSchemesCompatibility('')).rejects.toThrow(TypeError);
  });
});

// ─── getPrerequisites ────────────────────────────────────────────────────────

describe('CompatibilityEngine.getPrerequisites', () => {
  function pre(
    schemeId: string,
    relatedSchemeId: string,
    id = `${schemeId}-${relatedSchemeId}`,
  ): CompatibilityRow {
    return {
      id,
      schemeId,
      relatedSchemeId,
      relationshipType: 'prerequisite_schemes',
      officialRule: '',
      sourceUrl: null,
      verified: true,
    };
  }

  it('returns an empty chain when the scheme has no prerequisites', async () => {
    const engine = new CompatibilityEngine(
      fakeDb({ rows: [], schemes: [{ id: 'A', name: 'A' }] }),
    );
    const chain = await engine.getPrerequisites('A');
    expect(chain).toEqual({ schemeId: 'A', prerequisites: [] });
  });

  it('walks transitively and returns a valid topological order', async () => {
    // A requires B; B requires C. Order should be [C, B] with 1-indexed
    // `order` starting at 1.
    const rows = [pre('A', 'B'), pre('B', 'C')];
    const schemes = [
      { id: 'A', name: 'Scheme A' },
      { id: 'B', name: 'Scheme B' },
      { id: 'C', name: 'Scheme C' },
    ];
    const engine = new CompatibilityEngine(fakeDb({ rows, schemes }));
    const chain = await engine.getPrerequisites('A');

    expect(chain.schemeId).toBe('A');
    const ids = chain.prerequisites.map((p) => p.schemeId);
    expect(ids).toContain('B');
    expect(ids).toContain('C');
    expect(ids).not.toContain('A');
    // C must appear before B (deepest dependencies first).
    expect(ids.indexOf('C')).toBeLessThan(ids.indexOf('B'));

    // 1-indexed contiguous order.
    expect(chain.prerequisites.map((p) => p.order)).toEqual([1, 2]);
    // Names are resolved.
    expect(chain.prerequisites.find((p) => p.schemeId === 'C')?.schemeName).toBe(
      'Scheme C',
    );
    expect(chain.prerequisites.find((p) => p.schemeId === 'B')?.schemeName).toBe(
      'Scheme B',
    );
  });

  it('handles a diamond-shaped prerequisite graph', async () => {
    // A → B, A → C, B → D, C → D. D should appear once and before B and C.
    const rows = [pre('A', 'B'), pre('A', 'C'), pre('B', 'D'), pre('C', 'D')];
    const schemes = [
      { id: 'A', name: 'A' },
      { id: 'B', name: 'B' },
      { id: 'C', name: 'C' },
      { id: 'D', name: 'D' },
    ];
    const engine = new CompatibilityEngine(fakeDb({ rows, schemes }));
    const chain = await engine.getPrerequisites('A');

    const ids = chain.prerequisites.map((p) => p.schemeId);
    expect(ids.filter((id) => id === 'D')).toHaveLength(1);
    expect(ids.indexOf('D')).toBeLessThan(ids.indexOf('B'));
    expect(ids.indexOf('D')).toBeLessThan(ids.indexOf('C'));
  });

  it('throws on a cyclic prerequisite graph', async () => {
    const rows = [pre('A', 'B'), pre('B', 'A')];
    const engine = new CompatibilityEngine(
      fakeDb({
        rows,
        schemes: [
          { id: 'A', name: 'A' },
          { id: 'B', name: 'B' },
        ],
      }),
    );
    await expect(engine.getPrerequisites('A')).rejects.toThrow(/Cycle detected/);
  });

  it('rejects an empty schemeId', async () => {
    const engine = new CompatibilityEngine(fakeDb());
    await expect(engine.getPrerequisites('')).rejects.toThrow(TypeError);
  });
});
