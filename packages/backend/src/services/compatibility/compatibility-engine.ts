/**
 * Compatibility Engine — manages relationships between schemes and answers
 * compatibility questions for the citizen-facing UI.
 *
 * Responsibilities:
 *   - Surface a scheme's `can_combine_with`, `cannot_combine_with`, and
 *     `prerequisite_schemes` relationships (`getRelationships`, Req 7.1, 7.2).
 *   - Decide whether two schemes can coexist in a citizen's plan
 *     (`checkCompatibility`, Req 7.2). When no relationship is on file the
 *     pair is treated as compatible (default-compatible per Req 7.7).
 *   - Detect incompatibility warnings across a citizen's saved schemes so the
 *     UI can surface the conflict explanation when the citizen tries to save
 *     a clashing scheme (`checkSavedSchemesCompatibility`, Req 7.3).
 *   - Produce the prerequisite chain for a scheme in topological order so the
 *     citizen can see exactly which schemes must be completed first
 *     (`getPrerequisites`, Req 7.4).
 *
 * The pure helper `buildPrerequisiteOrder` is exported so the property-based
 * test for Property 13 (task 10.3) can exercise the topological-sort
 * invariant without standing up a Prisma client.
 */

import type {
  CompatibilityCheck,
  PrerequisiteChain,
  SchemeRelationship,
  SchemeRelationshipType,
} from '@bharat-benefits/shared';
import prisma from '../../lib/prisma';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Warning produced for a pair of incompatible schemes that are both either
 * saved by the citizen or about to be saved (Req 7.3).
 *
 * The two scheme refs are sorted lexicographically by id so equivalent
 * warnings produce a stable, deduplicated representation regardless of the
 * order in which the schemes were originally saved (Property 12 invariant).
 */
export interface IncompatibilityWarning {
  schemeIdA: string;
  schemeIdB: string;
  schemeNameA: string;
  schemeNameB: string;
  rule: string;
  sourceUrl: string | null;
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

const VALID_RELATIONSHIP_TYPES: ReadonlySet<SchemeRelationshipType> = new Set([
  'can_combine_with',
  'cannot_combine_with',
  'prerequisite_schemes',
]);

function isValidRelationshipType(value: string): value is SchemeRelationshipType {
  return VALID_RELATIONSHIP_TYPES.has(value as SchemeRelationshipType);
}

/**
 * Pure topological sort of a prerequisite graph.
 *
 * `prerequisitesMap` maps each scheme to the list of schemes that must be
 * completed before it (its direct prerequisites). The returned array contains
 * every prerequisite reachable from `rootSchemeId` ordered such that no
 * prerequisite appears after a scheme that depends on it (Req 7.4 /
 * Property 13). The root scheme itself is intentionally omitted from the
 * output — the chain represents the steps a citizen must complete *before*
 * applying for the root scheme.
 *
 * Cycle detection: throws an `Error` with a descriptive message when a cycle
 * is encountered. Cyclic prerequisite definitions cannot be ordered and the
 * caller is expected to surface the failure to administrators (the crawler
 * is supposed to flag such schemes on ingestion per Req 7.6).
 *
 * Pure: no I/O, no side effects, no exceptions for acyclic input.
 */
export function buildPrerequisiteOrder(
  rootSchemeId: string,
  prerequisitesMap: ReadonlyMap<string, ReadonlyArray<string>>,
): string[] {
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const order: string[] = [];

  function visit(node: string): void {
    if (visited.has(node)) return;
    if (onStack.has(node)) {
      throw new Error(
        `Cycle detected in prerequisite graph at scheme ${node} (root: ${rootSchemeId})`,
      );
    }
    onStack.add(node);
    const prereqs = prerequisitesMap.get(node) ?? [];
    for (const p of prereqs) {
      // Self-loops are degenerate cycles — surface them with the same error
      // rather than skipping silently.
      if (p === node) {
        throw new Error(
          `Self-referential prerequisite detected at scheme ${node} (root: ${rootSchemeId})`,
        );
      }
      visit(p);
    }
    onStack.delete(node);
    visited.add(node);
    if (node !== rootSchemeId) {
      order.push(node);
    }
  }

  visit(rootSchemeId);
  return order;
}

// ─── Prisma surface ──────────────────────────────────────────────────────────

/**
 * Row shape of a `SchemeCompatibility` record returned by Prisma. We declare
 * the relations as optional so unit tests can supply rows with or without the
 * eagerly-loaded `scheme` / `relatedScheme` payloads.
 */
export interface CompatibilityRow {
  id: string;
  schemeId: string;
  relatedSchemeId: string;
  relationshipType: string;
  officialRule: string | null;
  sourceUrl: string | null;
  verified: boolean;
  scheme?: { id: string; name: string } | null;
  relatedScheme?: { id: string; name: string } | null;
}

/** Saved-scheme row including just the fields we need for warnings. */
export interface SavedSchemeRow {
  scheme: { id: string; name: string };
}

/** Filter shape accepted on a single id field (string or `{ in: string[] }`). */
export type CompatibilityIdFilter = string | { in: string[] };

/** Where clause shape accepted by `schemeCompatibility.findMany`. */
export interface CompatibilityWhere {
  schemeId?: CompatibilityIdFilter;
  relatedSchemeId?: CompatibilityIdFilter;
  relationshipType?: string | { in: string[] };
  OR?: CompatibilityWhere[];
}

/**
 * Minimal Prisma surface required by the engine. Declared structurally so
 * unit tests can supply an in-memory fake without depending on the full
 * generated Prisma type surface.
 */
export interface CompatibilityEnginePrisma {
  schemeCompatibility: {
    findMany(args: {
      where?: CompatibilityWhere;
      include?: { scheme?: true; relatedScheme?: true };
    }): Promise<CompatibilityRow[]>;
  };
  scheme: {
    findMany(args: {
      where?: { id?: { in: string[] } };
    }): Promise<Array<{ id: string; name: string }>>;
  };
  savedScheme: {
    findMany(args: {
      where: { userId: string };
      include?: { scheme: true };
    }): Promise<SavedSchemeRow[]>;
  };
}

// ─── CompatibilityEngine ─────────────────────────────────────────────────────

/**
 * `CompatibilityEngine` couples the pure helpers above to a database client
 * so callers can fetch a scheme's relationships, check pairwise
 * compatibility, list incompatibility warnings, and produce ordered
 * prerequisite chains without re-implementing the Prisma queries.
 */
export class CompatibilityEngine {
  constructor(
    private readonly db: CompatibilityEnginePrisma = prisma as unknown as CompatibilityEnginePrisma,
  ) {}

  /**
   * Returns every relationship the platform has on file for the given scheme
   * (Req 7.1, 7.2).
   *
   * Symmetric relationships (`can_combine_with` and `cannot_combine_with`)
   * are queried in both directions — if the database stores "A cannot
   * combine with B", a citizen viewing B should still see the conflict.
   * `prerequisite_schemes` is directional and only the outgoing direction is
   * returned (i.e. prerequisites *of* `schemeId`).
   *
   * Each row's `officialRule` falls back to an empty string when missing so
   * the citizen-facing type stays predictable; consumers that care about the
   * presence/absence of an official rule should check for the empty string.
   */
  async getRelationships(schemeId: string): Promise<SchemeRelationship[]> {
    if (!schemeId) {
      throw new TypeError('schemeId is required');
    }

    const rows = await this.db.schemeCompatibility.findMany({
      where: {
        OR: [{ schemeId }, { relatedSchemeId: schemeId }],
      },
      include: { scheme: true, relatedScheme: true },
    });

    const out: SchemeRelationship[] = [];
    for (const row of rows) {
      if (!isValidRelationshipType(row.relationshipType)) continue;

      const isOutgoing = row.schemeId === schemeId;
      const isIncoming = row.relatedSchemeId === schemeId;
      if (!isOutgoing && !isIncoming) continue;

      // Prerequisite relationships are directional: only show the prereqs
      // *of* `schemeId` (outgoing). Skip incoming rows where another scheme
      // lists this one as a prerequisite — that would mean "X depends on
      // schemeId" which is rendered on X's page, not here.
      if (row.relationshipType === 'prerequisite_schemes' && !isOutgoing) {
        continue;
      }

      const otherId = isOutgoing ? row.relatedSchemeId : row.schemeId;
      const other = isOutgoing ? row.relatedScheme : row.scheme;

      out.push({
        relatedSchemeId: otherId,
        relatedSchemeName: other?.name ?? '',
        type: row.relationshipType,
        officialRule: row.officialRule ?? '',
        sourceUrl: row.sourceUrl ?? '',
      });
    }

    return out;
  }

  /**
   * Decides whether two schemes can be combined (Req 7.2, Req 7.7).
   *
   * Rules:
   *   - If any `cannot_combine_with` relationship exists between the pair
   *     (in either direction), the schemes are NOT compatible. The
   *     accompanying official rule and source URL come from that row.
   *   - If a `can_combine_with` relationship exists with no contradicting
   *     `cannot_combine_with`, the schemes are compatible and the official
   *     rule is surfaced.
   *   - If no relationship is on file the schemes are *default-compatible*
   *     (Req 7.7) — `compatible: true`, `rule: null`, `sourceUrl: null`.
   *   - A scheme is always compatible with itself; this guards UI flows that
   *     accidentally compare a scheme against its own id.
   */
  async checkCompatibility(
    schemeIdA: string,
    schemeIdB: string,
  ): Promise<CompatibilityCheck> {
    if (!schemeIdA || !schemeIdB) {
      throw new TypeError('Both schemeIdA and schemeIdB are required');
    }
    if (schemeIdA === schemeIdB) {
      return { compatible: true, rule: null, sourceUrl: null };
    }

    const rows = await this.db.schemeCompatibility.findMany({
      where: {
        OR: [
          { schemeId: schemeIdA, relatedSchemeId: schemeIdB },
          { schemeId: schemeIdB, relatedSchemeId: schemeIdA },
        ],
      },
    });

    let cannot: CompatibilityRow | null = null;
    let can: CompatibilityRow | null = null;
    for (const row of rows) {
      if (row.relationshipType === 'cannot_combine_with') {
        // First incompatibility wins — break early for a deterministic
        // answer.
        cannot = row;
        break;
      }
      if (row.relationshipType === 'can_combine_with' && can === null) {
        can = row;
      }
    }

    if (cannot) {
      return {
        compatible: false,
        rule: cannot.officialRule ?? '',
        sourceUrl: cannot.sourceUrl ?? null,
      };
    }
    if (can) {
      return {
        compatible: true,
        rule: can.officialRule ?? '',
        sourceUrl: can.sourceUrl ?? null,
      };
    }
    // Default-compatible per Req 7.7.
    return { compatible: true, rule: null, sourceUrl: null };
  }

  /**
   * Returns one warning per pair of incompatible schemes among the citizen's
   * saved schemes (Req 7.3).
   *
   * If `candidateSchemeId` is supplied it is treated as a not-yet-saved
   * scheme being added — the method then returns warnings for every saved
   * scheme that conflicts with the candidate, even if no other saved-scheme
   * pair is incompatible.
   *
   * Warnings are deduplicated across both directions: a single
   * `cannot_combine_with` row produces exactly one warning regardless of
   * which scheme is on which side. The schemes inside each warning are
   * ordered with the lexicographically-smaller id as `schemeIdA` so two
   * citizens who saved the same pair in opposite order receive identical
   * warning objects (Property 12 invariant).
   */
  async checkSavedSchemesCompatibility(
    userId: string,
    candidateSchemeId?: string,
  ): Promise<IncompatibilityWarning[]> {
    if (!userId) {
      throw new TypeError('userId is required');
    }

    const savedRows = await this.db.savedScheme.findMany({
      where: { userId },
      include: { scheme: true },
    });

    // Build the universe of scheme ids we need to consider — saved schemes
    // plus the optional candidate. Use a Map so we keep names alongside ids.
    const schemeNames = new Map<string, string>();
    for (const row of savedRows) {
      if (row.scheme) schemeNames.set(row.scheme.id, row.scheme.name);
    }

    if (candidateSchemeId && !schemeNames.has(candidateSchemeId)) {
      const [candidate] = await this.db.scheme.findMany({
        where: { id: { in: [candidateSchemeId] } },
      });
      schemeNames.set(candidateSchemeId, candidate?.name ?? '');
    }

    const allIds = Array.from(schemeNames.keys());
    if (allIds.length < 2) return [];

    // Pull every cannot_combine_with row that touches any of these schemes.
    const rows = await this.db.schemeCompatibility.findMany({
      where: {
        relationshipType: 'cannot_combine_with',
        OR: [
          { schemeId: { in: allIds } },
          { relatedSchemeId: { in: allIds } },
        ],
      },
    });

    const idSet = new Set(allIds);
    const seen = new Set<string>();
    const warnings: IncompatibilityWarning[] = [];

    for (const row of rows) {
      if (row.relationshipType !== 'cannot_combine_with') continue;
      const a = row.schemeId;
      const b = row.relatedSchemeId;
      if (!idSet.has(a) || !idSet.has(b)) continue;
      if (a === b) continue;

      // Canonical ordering so (A,B) and (B,A) collapse into one warning.
      const [low, high] = a < b ? [a, b] : [b, a];
      const key = `${low}::${high}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // If a candidate was supplied and the warning does not involve it,
      // skip — Req 7.3 talks about warnings produced by the act of saving,
      // so when scoping to a candidate we don't surface unrelated conflicts.
      if (candidateSchemeId && low !== candidateSchemeId && high !== candidateSchemeId) {
        continue;
      }

      warnings.push({
        schemeIdA: low,
        schemeIdB: high,
        schemeNameA: schemeNames.get(low) ?? '',
        schemeNameB: schemeNames.get(high) ?? '',
        rule: row.officialRule ?? '',
        sourceUrl: row.sourceUrl ?? null,
      });
    }

    return warnings;
  }

  /**
   * Returns the prerequisite chain for a scheme as a topologically-ordered
   * list of dependencies (Req 7.4). The root scheme itself is excluded from
   * the chain — the chain is the list of steps a citizen must complete
   * *before* applying for the root scheme.
   *
   * The traversal walks the prerequisite graph transitively: if A requires
   * B and B requires C, the chain returned for A is [C, B] (deepest first).
   * Each entry's `order` is its position in the chain (1-indexed) so
   * downstream UIs can render numbered steps directly.
   *
   * Cycles in the prerequisite graph throw an error (the crawler is
   * responsible for flagging cyclic schemes per Req 7.6 — hitting one here
   * means the data is inconsistent and the failure should propagate so it's
   * visible).
   */
  async getPrerequisites(schemeId: string): Promise<PrerequisiteChain> {
    if (!schemeId) {
      throw new TypeError('schemeId is required');
    }

    // Walk the prerequisite graph breadth-first to discover every reachable
    // scheme, fetching one layer at a time so we touch the database O(depth)
    // times rather than O(nodes) times.
    const prerequisitesMap = new Map<string, string[]>();
    const queue: string[] = [schemeId];
    const seen = new Set<string>([schemeId]);

    while (queue.length > 0) {
      const layer = queue.splice(0, queue.length);
      const rows = await this.db.schemeCompatibility.findMany({
        where: {
          relationshipType: 'prerequisite_schemes',
          schemeId: { in: layer },
        },
      });

      for (const id of layer) {
        if (!prerequisitesMap.has(id)) prerequisitesMap.set(id, []);
      }

      for (const row of rows) {
        if (row.relationshipType !== 'prerequisite_schemes') continue;
        const list = prerequisitesMap.get(row.schemeId);
        if (!list) continue;
        list.push(row.relatedSchemeId);
        if (!seen.has(row.relatedSchemeId)) {
          seen.add(row.relatedSchemeId);
          queue.push(row.relatedSchemeId);
        }
      }
    }

    const ordered = buildPrerequisiteOrder(schemeId, prerequisitesMap);

    if (ordered.length === 0) {
      return { schemeId, prerequisites: [] };
    }

    // Resolve scheme names in a single round-trip.
    const names = new Map<string, string>();
    const nameRows = await this.db.scheme.findMany({
      where: { id: { in: ordered } },
    });
    for (const r of nameRows) names.set(r.id, r.name);

    return {
      schemeId,
      prerequisites: ordered.map((id, index) => ({
        schemeId: id,
        schemeName: names.get(id) ?? '',
        order: index + 1,
      })),
    };
  }
}

/** Default singleton suitable for HTTP handlers and downstream services. */
export const compatibilityEngine = new CompatibilityEngine();
