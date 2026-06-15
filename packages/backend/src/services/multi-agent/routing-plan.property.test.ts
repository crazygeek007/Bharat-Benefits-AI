/**
 * Property-based tests for the multi-agent Planner_Agent's routing plan.
 *
 * **Property 28: Multi-Agent Planner Routing Validity**
 * **Validates: Requirements 25.2**
 *
 * Property statement (from design.md):
 *   "For any citizen query, the Planner_Agent SHALL produce a routing
 *    plan where: (a) the plan contains a valid query type from
 *    {eligibility, recommendation, information, comparison}, (b) all
 *    agents in the required list are valid agent names, and (c) required
 *    agents and skipped agents are disjoint and their union covers all
 *    pipeline agents."
 *
 * Rather than spinning up an LLM-backed planner, we exercise the two
 * pure helpers the orchestrator uses to consume any planner's output:
 *
 *   - {@link isValidRoutingPlan} encodes the well-formedness contract
 *     (a)–(c). It is the gate the orchestrator runs every planner
 *     output through before accepting the routing plan.
 *   - {@link applyRoutingPlan} flattens an accepted plan into the
 *     ordered list of agents that should execute. The orchestrator
 *     guarantees the planner runs first and the response agent always
 *     runs (so the citizen always gets an answer); both invariants are
 *     part of the routing-plan contract.
 *
 * Tests below verify four properties (numRuns: 200):
 *   1. `isValidRoutingPlan` accepts every well-formed plan built from a
 *      valid `queryType` and a partition of the non-planner agents.
 *   2. `isValidRoutingPlan` rejects plans that violate (a)–(c):
 *      invalid query types, overlapping required/skipped lists, and
 *      missing-coverage plans.
 *   3. `applyRoutingPlan` invariants — for any valid plan the result
 *      starts with `'planner'`, always includes `'response'`, contains
 *      no duplicates, and respects the pipeline order from
 *      {@link ALL_AGENTS}.
 *   4. `applyRoutingPlan` respects the skip list — every agent that is
 *      both listed in `skippedAgents` and not in `requiredAgents` is
 *      omitted from the result.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import type { AgentName, AgentRoutingPlan, QueryType } from '@bharat-benefits/shared';

import {
  ALL_AGENTS,
  applyRoutingPlan,
  isValidRoutingPlan,
} from './multi-agent-pipeline';

// ─── Tunables ────────────────────────────────────────────────────────────────

const NUM_RUNS = 200;

/** All non-planner agents that the planner is allowed to route. */
const NON_PLANNER_AGENTS: readonly AgentName[] = ALL_AGENTS.filter(
  (a) => a !== 'planner',
);

/** Every QueryType value the orchestrator currently understands. */
const VALID_QUERY_TYPES: readonly QueryType[] = [
  'eligibility',
  'recommendation',
  'information',
  'comparison',
];

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Picks one of the four allowed query types uniformly at random. */
const arbValidQueryType: fc.Arbitrary<QueryType> = fc.constantFrom(
  ...VALID_QUERY_TYPES,
);

/**
 * A query type string that is **not** a valid {@link QueryType}. We
 * filter against the valid set to avoid the (vanishingly rare) chance
 * that fast-check generates one of the four legal values by accident.
 */
const arbInvalidQueryType: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 16 })
  .filter((s) => !VALID_QUERY_TYPES.includes(s as QueryType));

/**
 * Random bipartition of the five non-planner agents into
 * (requiredAgents, skippedAgents). Each agent independently lands in
 * one bucket or the other, so:
 *   - The two arrays are disjoint by construction.
 *   - Their union is exactly NON_PLANNER_AGENTS — meeting the
 *     "covers all pipeline agents" half of property (c).
 */
const arbValidPartition: fc.Arbitrary<{
  requiredAgents: AgentName[];
  skippedAgents: AgentName[];
}> = fc
  .tuple(
    ...NON_PLANNER_AGENTS.map(() => fc.boolean()),
  )
  .map((flags) => {
    const required: AgentName[] = [];
    const skipped: AgentName[] = [];
    NON_PLANNER_AGENTS.forEach((agent, idx) => {
      if (flags[idx]) {
        required.push(agent);
      } else {
        skipped.push(agent);
      }
    });
    return { requiredAgents: required, skippedAgents: skipped };
  });

/** A fully well-formed routing plan as the orchestrator expects. */
const arbValidPlan: fc.Arbitrary<AgentRoutingPlan> = fc
  .record({
    queryType: arbValidQueryType,
    partition: arbValidPartition,
  })
  .map(({ queryType, partition }) => ({
    queryType,
    requiredAgents: partition.requiredAgents,
    skippedAgents: partition.skippedAgents,
  }));

/**
 * Plan whose `queryType` is not one of the allowed four values but
 * whose required/skipped lists are otherwise well-formed. Used to
 * isolate the rejection signal to property (a).
 */
const arbInvalidQueryTypePlan: fc.Arbitrary<AgentRoutingPlan> = fc
  .record({
    queryType: arbInvalidQueryType,
    partition: arbValidPartition,
  })
  .map(({ queryType, partition }) => ({
    // Cast through unknown so TS doesn't reject the deliberately bad value.
    queryType: queryType as unknown as QueryType,
    requiredAgents: partition.requiredAgents,
    skippedAgents: partition.skippedAgents,
  }));

/**
 * Plan that injects at least one agent into both `requiredAgents`
 * and `skippedAgents`, violating disjointness. We start from a valid
 * partition and pick a random non-planner agent to duplicate into the
 * other list, guaranteeing the overlap regardless of the partition's
 * shape.
 */
const arbOverlappingPlan: fc.Arbitrary<AgentRoutingPlan> = fc
  .record({
    queryType: arbValidQueryType,
    partition: arbValidPartition,
    duplicate: fc.constantFrom(...NON_PLANNER_AGENTS),
  })
  .map(({ queryType, partition, duplicate }) => {
    const required = new Set(partition.requiredAgents);
    const skipped = new Set(partition.skippedAgents);
    required.add(duplicate);
    skipped.add(duplicate);
    return {
      queryType,
      requiredAgents: Array.from(required),
      skippedAgents: Array.from(skipped),
    };
  });

/**
 * Plan that drops at least one non-planner agent from both lists,
 * violating coverage. We start from a valid partition and remove a
 * random non-planner agent from whichever list currently holds it.
 */
const arbMissingCoveragePlan: fc.Arbitrary<AgentRoutingPlan> = fc
  .record({
    queryType: arbValidQueryType,
    partition: arbValidPartition,
    omit: fc.constantFrom(...NON_PLANNER_AGENTS),
  })
  .map(({ queryType, partition, omit }) => ({
    queryType,
    requiredAgents: partition.requiredAgents.filter((a) => a !== omit),
    skippedAgents: partition.skippedAgents.filter((a) => a !== omit),
  }));

// ─── Property tests ──────────────────────────────────────────────────────────

describe('isValidRoutingPlan — Property 28', () => {
  it('accepts well-formed plans built from a valid partition', () => {
    fc.assert(
      fc.property(arbValidPlan, (plan) => {
        expect(isValidRoutingPlan(plan)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects plans whose queryType is not one of the four legal values', () => {
    fc.assert(
      fc.property(arbInvalidQueryTypePlan, (plan) => {
        expect(isValidRoutingPlan(plan)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects plans where required and skipped lists overlap', () => {
    fc.assert(
      fc.property(arbOverlappingPlan, (plan) => {
        // Sanity: the construction must actually produce an overlap.
        const required = new Set(plan.requiredAgents);
        const overlap = plan.skippedAgents.some((a) => required.has(a));
        fc.pre(overlap);
        expect(isValidRoutingPlan(plan)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects plans missing coverage of some non-planner agent', () => {
    fc.assert(
      fc.property(arbMissingCoveragePlan, (plan) => {
        // Sanity: the construction must actually drop coverage.
        const union = new Set<AgentName>([
          ...plan.requiredAgents,
          ...plan.skippedAgents,
        ]);
        const missing = NON_PLANNER_AGENTS.some((a) => !union.has(a));
        fc.pre(missing);
        expect(isValidRoutingPlan(plan)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('applyRoutingPlan — Property 28', () => {
  it('returns an agent list whose first element is "planner"', () => {
    fc.assert(
      fc.property(arbValidPlan, (plan) => {
        const ordered = applyRoutingPlan(plan);
        expect(ordered[0]).toBe('planner');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('always includes the response agent — even if not listed in required', () => {
    fc.assert(
      fc.property(arbValidPlan, (plan) => {
        const ordered = applyRoutingPlan(plan);
        expect(ordered).toContain('response');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('contains no duplicate agent entries', () => {
    fc.assert(
      fc.property(arbValidPlan, (plan) => {
        const ordered = applyRoutingPlan(plan);
        expect(new Set(ordered).size).toBe(ordered.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('preserves the canonical pipeline order from ALL_AGENTS', () => {
    fc.assert(
      fc.property(arbValidPlan, (plan) => {
        const ordered = applyRoutingPlan(plan);
        // Every entry must come from ALL_AGENTS, and the relative
        // order must match the canonical ordering.
        const canonicalIndices = ordered.map((a) => ALL_AGENTS.indexOf(a));
        expect(canonicalIndices.every((i) => i >= 0)).toBe(true);
        for (let i = 1; i < canonicalIndices.length; i += 1) {
          expect(canonicalIndices[i]).toBeGreaterThan(canonicalIndices[i - 1]);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('respects the skip list — agents only in skippedAgents do not appear', () => {
    fc.assert(
      fc.property(arbValidPlan, (plan) => {
        const ordered = applyRoutingPlan(plan);
        const required = new Set(plan.requiredAgents);
        for (const agent of plan.skippedAgents) {
          // Mandatory agents (planner, response) are always retained
          // regardless of the plan; everyone else honours the skip list.
          if (agent === 'planner' || agent === 'response') continue;
          if (required.has(agent)) continue;
          expect(ordered).not.toContain(agent);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
