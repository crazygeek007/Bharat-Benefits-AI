/**
 * Property-based tests for the pure prerequisite-ordering helper used by
 * `CompatibilityEngine.getPrerequisites`.
 *
 * **Property 13: Prerequisite Ordering**
 * **Validates: Requirements 7.4**
 *
 * Property statement (from design.md):
 * "For any scheme with prerequisite_schemes relationships, the displayed
 * prerequisite chain SHALL form a valid topological ordering where no
 * prerequisite appears after a scheme that depends on it."
 *
 * The test exercises five universal facts about `buildPrerequisiteOrder`:
 *   1. Topological invariant — for every edge (X requires Y) where X is in
 *      the output, Y is also in the output and appears before X.
 *   2. Root excluded — the root scheme never appears in the output.
 *   3. No duplicates — every scheme in the output appears exactly once.
 *   4. Reachability — the output is exactly the set of schemes reachable
 *      from the root (excluding the root itself).
 *   5. Cycle detection — for any graph containing a cycle reachable from
 *      the root, the helper throws an `Error` rather than looping.
 *
 * The DAG arbitrary builds random graphs over n labelled nodes and only
 * permits edges from lower-indexed nodes to higher-indexed nodes; this
 * structurally guarantees acyclicity. The cyclic-graph arbitrary stitches
 * together a cycle of length k >= 2 between fresh nodes and roots the
 * traversal at one of them, so the cycle is always reachable.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildPrerequisiteOrder } from './compatibility-engine';

// ─── Tunables ────────────────────────────────────────────────────────────────

const NUM_RUNS = 200;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Reference traversal of the prerequisite graph that returns every node
 * reachable from `root` (the root itself is excluded so the output matches
 * the convention of `buildPrerequisiteOrder`).
 *
 * Used as the oracle for the reachability property.
 */
function reachableFrom(
  root: string,
  prerequisites: ReadonlyMap<string, ReadonlyArray<string>>,
): Set<string> {
  const reached = new Set<string>();
  const stack: string[] = [];
  for (const p of prerequisites.get(root) ?? []) {
    if (!reached.has(p)) {
      reached.add(p);
      stack.push(p);
    }
  }
  while (stack.length > 0) {
    const node = stack.pop() as string;
    for (const p of prerequisites.get(node) ?? []) {
      if (!reached.has(p)) {
        reached.add(p);
        stack.push(p);
      }
    }
  }
  return reached;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

interface DAG {
  /** Node labels in lexicographic order: `S0`, `S1`, …, `S(n-1)`. */
  nodes: string[];
  /** Adjacency map. `prerequisites.get(Si)` ⊆ `{S(i+1), …, S(n-1)}`. */
  prerequisites: Map<string, string[]>;
  /** Root for the traversal; chosen uniformly at random from `nodes`. */
  root: string;
}

/**
 * Arbitrary acyclic prerequisite graph over n ∈ [1, 10] nodes.
 *
 * Edges are constrained to go from lower-indexed nodes to higher-indexed
 * nodes, which guarantees no cycle can exist. The root is chosen uniformly
 * at random across all nodes — this exercises both the case where the root
 * has descendants (smaller index) and the case where it sits at the
 * "boundary" of the DAG (largest index → empty output).
 *
 * `fc.subarray` yields a deduplicated subset of its input preserving the
 * original element order, so the prerequisite lists never contain
 * duplicates.
 */
const arbDAG: fc.Arbitrary<DAG> = fc.integer({ min: 1, max: 10 }).chain((n) => {
  const nodes = Array.from({ length: n }, (_, i) => `S${i}`);
  // For each node `Si`, prerequisites are drawn from strictly higher-indexed
  // nodes — this enforces the DAG property structurally.
  const perNodePrereqs = nodes.map((_, i) => {
    const candidates = nodes.slice(i + 1);
    return candidates.length === 0
      ? (fc.constant([]) as fc.Arbitrary<string[]>)
      : fc.subarray(candidates);
  });
  return fc
    .tuple(fc.tuple(...perNodePrereqs), fc.integer({ min: 0, max: n - 1 }))
    .map(([allPrereqs, rootIdx]) => {
      const prerequisites = new Map<string, string[]>();
      nodes.forEach((node, i) => {
        prerequisites.set(node, [...allPrereqs[i]]);
      });
      return { nodes, prerequisites, root: nodes[rootIdx] };
    });
});

interface CyclicGraph {
  prerequisites: Map<string, string[]>;
  root: string;
}

/**
 * Arbitrary prerequisite graph that contains a cycle reachable from the
 * root.
 *
 * The cycle has length k ∈ [2, 8] (length 1 would be a self-loop, which
 * `buildPrerequisiteOrder` reports under a different error message; we want
 * the multi-node cycle path here). Cycle nodes are labelled `C0` through
 * `C(k-1)` and wired so `Ci` requires `C((i + 1) mod k)`. The root is `C0`,
 * guaranteeing the cycle is encountered by the traversal.
 *
 * A handful of "extra" nodes labelled `E0`, `E1`, … are added with random
 * prerequisites to ensure the cycle detection still fires when the graph
 * contains additional structure. Extras are intentionally unreachable from
 * the root so they never influence the traversal regardless of any cycles
 * they may form among themselves.
 */
const arbCyclicGraph: fc.Arbitrary<CyclicGraph> = fc
  .integer({ min: 2, max: 8 })
  .chain((cycleLen) => {
    const cycleNodes = Array.from({ length: cycleLen }, (_, i) => `C${i}`);
    return fc.integer({ min: 0, max: 5 }).chain((numExtras) => {
      const extras = Array.from({ length: numExtras }, (_, i) => `E${i}`);
      const candidatePool = [...cycleNodes, ...extras];
      const extraPrereqArbs =
        extras.length === 0
          ? fc.constant<string[][]>([])
          : fc.tuple(...extras.map(() => fc.subarray(candidatePool)));
      return extraPrereqArbs.map((extraPrereqs) => {
        const prerequisites = new Map<string, string[]>();
        cycleNodes.forEach((node, i) => {
          prerequisites.set(node, [cycleNodes[(i + 1) % cycleLen]]);
        });
        extras.forEach((node, i) => {
          prerequisites.set(node, [...extraPrereqs[i]]);
        });
        return { prerequisites, root: cycleNodes[0] };
      });
    });
  });

// ─── Property tests ──────────────────────────────────────────────────────────

describe('Property 13: Prerequisite Ordering', () => {
  it('produces a valid topological ordering for every acyclic prerequisite graph', () => {
    fc.assert(
      fc.property(arbDAG, ({ prerequisites, root }) => {
        const order = buildPrerequisiteOrder(root, prerequisites);
        const position = new Map<string, number>();
        order.forEach((node, i) => position.set(node, i));

        // For every edge (X requires Y), if X is in the output then Y must
        // also be in the output and Y must appear strictly before X.
        for (const [x, prereqs] of prerequisites) {
          if (!position.has(x)) continue; // X not reachable; skip.
          const xPos = position.get(x) as number;
          for (const y of prereqs) {
            expect(
              position.has(y),
              `prerequisite ${y} of ${x} missing from output`,
            ).toBe(true);
            const yPos = position.get(y) as number;
            expect(yPos).toBeLessThan(xPos);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never includes the root scheme in the output', () => {
    fc.assert(
      fc.property(arbDAG, ({ prerequisites, root }) => {
        const order = buildPrerequisiteOrder(root, prerequisites);
        expect(order).not.toContain(root);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('contains no duplicates — every scheme appears exactly once', () => {
    fc.assert(
      fc.property(arbDAG, ({ prerequisites, root }) => {
        const order = buildPrerequisiteOrder(root, prerequisites);
        const unique = new Set(order);
        expect(unique.size).toBe(order.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('output set equals the schemes reachable from the root (and excludes the unreachable)', () => {
    fc.assert(
      fc.property(arbDAG, ({ prerequisites, root, nodes }) => {
        const order = buildPrerequisiteOrder(root, prerequisites);
        const reachable = reachableFrom(root, prerequisites);
        expect(new Set(order)).toEqual(reachable);
        // Sanity: no node outside the reachable set leaks into the output.
        for (const node of nodes) {
          if (node === root) continue;
          if (!reachable.has(node)) {
            expect(order).not.toContain(node);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('throws an Error for any prerequisite graph with a cycle reachable from the root', () => {
    fc.assert(
      fc.property(arbCyclicGraph, ({ prerequisites, root }) => {
        expect(() => buildPrerequisiteOrder(root, prerequisites)).toThrow(Error);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
