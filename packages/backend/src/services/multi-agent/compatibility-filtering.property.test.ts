/**
 * Property-based test for compatibility filtering inside the
 * multi-agent pipeline.
 *
 * **Property 29: Compatibility Filtering in Pipeline**
 * **Validates: Requirements 25.5**
 *
 * Property statement (from design.md):
 *   "For any set of schemes retrieved by the Retrieval_Agent, the
 *    Compatibility_Agent SHALL remove schemes that form
 *    `cannot_combine_with` pairs such that no two remaining schemes in
 *    the output are incompatible with each other."
 *
 * Operationalised against the pipeline's contract: after the
 * Compatibility_Agent runs, the chunks the orchestrator hands to the
 * Recommendation_Agent (`context.compatibleChunks`) MUST NOT contain
 * any chunk whose `schemeId` is in the `incompatibleSchemeIds` list
 * the Compatibility_Agent reported.
 *
 * The test exercises three universal facts about the orchestrator's
 * compatibility-filter contract:
 *
 *   1. **Filter contract** — the recommendation agent never sees a
 *      chunk whose schemeId is in the `incompatibleSchemeIds` list.
 *   2. **No invented chunks** — every chunk reaching recommendation
 *      came from the original retrieval output (the orchestrator
 *      doesn't fabricate chunks during filtering).
 *   3. **Disjoint partition** — `incompatibleSchemeIds` and the
 *      schemeIds of `compatibleChunks` are disjoint sets.
 *
 * The fake CompatibilityAgent filters by the spec contract: it removes
 * exactly the chunks whose schemeId is in the incompatible subset and
 * reports that subset back. Property 29 then checks that the pipeline
 * faithfully threads that filtered list through to the
 * Recommendation_Agent without re-introducing or fabricating chunks.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  MultiAgentPipeline,
  type AgentContext,
  type CompatibilityAgent,
  type EligibilityAgent,
  type MultiAgentPipelineDeps,
  type PlannerAgent,
  type RecommendationAgent,
  type ResponseAgent,
  type RetrievalAgent,
} from './multi-agent-pipeline';
import type {
  AgentRoutingPlan,
  EligibilityResult,
  Recommendation,
  RetrievedChunk,
  SourceCitation,
} from '@bharat-benefits/shared';

// ─── Tunables ────────────────────────────────────────────────────────────────

const NUM_RUNS = 200;

/** Pipeline hard-caps retrieval at 10 chunks; keep generators within bounds
 *  so the property reasons about exactly the chunks the orchestrator sees. */
const MAX_CHUNKS = 10;

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Small label space for scheme IDs so duplicates are likely — multiple
 *  chunks per scheme is the realistic case the filter must handle. */
const arbSchemeId: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 25 })
  .map((n) => `scheme-${n}`);

const arbChunk: fc.Arbitrary<RetrievedChunk> = fc.record({
  schemeId: arbSchemeId,
  chunkText: fc.string({ maxLength: 32 }),
  similarity: fc.double({ min: 0, max: 1, noNaN: true }),
  chunkIndex: fc.nat(20),
});

const arbRetrievedChunks: fc.Arbitrary<RetrievedChunk[]> = fc.array(arbChunk, {
  minLength: 0,
  maxLength: MAX_CHUNKS,
});

interface Scenario {
  retrieved: RetrievedChunk[];
  incompatibleSchemeIds: string[];
}

/**
 * Scenario arbitrary: a list of retrieved chunks plus an arbitrary
 * subset of *their* unique schemeIds chosen to be incompatible. This
 * subset is what a real CompatibilityEngine would produce after
 * resolving `cannot_combine_with` relationships, so it's the natural
 * input space for the pipeline contract under test.
 */
const arbScenario: fc.Arbitrary<Scenario> = arbRetrievedChunks.chain((retrieved) => {
  const uniqueIds = Array.from(new Set(retrieved.map((c) => c.schemeId)));
  const arbIncompatible: fc.Arbitrary<string[]> =
    uniqueIds.length === 0 ? fc.constant<string[]>([]) : fc.subarray(uniqueIds);
  return arbIncompatible.map((incompatibleSchemeIds) => ({
    retrieved,
    incompatibleSchemeIds,
  }));
});

// ─── Pipeline fakes ──────────────────────────────────────────────────────────

const ALL_DOWNSTREAM_PLAN: AgentRoutingPlan = {
  queryType: 'recommendation',
  requiredAgents: ['eligibility', 'retrieval', 'compatibility', 'recommendation', 'response'],
  skippedAgents: [],
};

const fakePlanner: PlannerAgent = {
  analyzeIntent: async () => ALL_DOWNSTREAM_PLAN,
};

const fakeEligibility: EligibilityAgent = {
  evaluate: async () => new Map<string, EligibilityResult>(),
};

const fakeResponse: ResponseAgent = {
  synthesize: async () => ({
    answer: 'ok',
    sources: [] as SourceCitation[],
  }),
};

/**
 * Builds a fake CompatibilityAgent that mirrors the spec contract:
 * remove every chunk whose schemeId is in `incompatibleSchemeIds` and
 * report that list back.
 *
 * The agent reads the retrieved chunks from the shared context, just
 * like the real implementation. This keeps the test honest — the
 * orchestrator is what we are exercising, not a stand-in pure
 * function.
 */
function makeFakeCompatibility(incompatibleSchemeIds: string[]): CompatibilityAgent {
  const banned = new Set(incompatibleSchemeIds);
  return {
    filterIncompatible: async (ctx: AgentContext) => {
      const retrieved = Array.isArray(ctx.retrieved) ? ctx.retrieved : [];
      const compatible = retrieved.filter((c) => !banned.has(c.schemeId));
      return { compatible, incompatibleSchemeIds: [...incompatibleSchemeIds] };
    },
  };
}

/**
 * Builds a recording RecommendationAgent that snapshots the chunks the
 * orchestrator hands it via `context.compatibleChunks`. The snapshot
 * is what Property 29 checks against — anything else (mocks, spies,
 * assertions inside the agent) would obscure the actual pipeline
 * behaviour.
 */
function makeRecordingRecommendation(record: { received: RetrievedChunk[] | undefined }): RecommendationAgent {
  return {
    rank: async (ctx: AgentContext) => {
      record.received = Array.isArray(ctx.compatibleChunks)
        ? [...ctx.compatibleChunks]
        : undefined;
      return [] as Recommendation[];
    },
  };
}

function buildDeps(scenario: Scenario, record: { received: RetrievedChunk[] | undefined }): MultiAgentPipelineDeps {
  const fakeRetrieval: RetrievalAgent = {
    retrieve: async () => scenario.retrieved,
  };
  return {
    planner: fakePlanner,
    eligibility: fakeEligibility,
    retrieval: fakeRetrieval,
    compatibility: makeFakeCompatibility(scenario.incompatibleSchemeIds),
    recommendation: makeRecordingRecommendation(record),
    response: fakeResponse,
  };
}

// ─── Property tests ──────────────────────────────────────────────────────────

describe('Property 29: Compatibility Filtering in Pipeline', () => {
  it('never lets a chunk in incompatibleSchemeIds reach the Recommendation_Agent', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const record: { received: RetrievedChunk[] | undefined } = { received: undefined };
        const pipeline = new MultiAgentPipeline(buildDeps(scenario, record), {
          // Silence the pipeline's default console logger during the
          // many runs fast-check executes.
          logger: { warn: () => undefined },
        });

        await pipeline.processQuery('q', 'user-prop29');

        expect(record.received, 'recommendation agent did not run').toBeDefined();
        const banned = new Set(scenario.incompatibleSchemeIds);
        for (const chunk of record.received as RetrievedChunk[]) {
          expect(
            banned.has(chunk.schemeId),
            `chunk for ${chunk.schemeId} leaked past compatibility filter`,
          ).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('only forwards chunks that came from the original retrieval output', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const record: { received: RetrievedChunk[] | undefined } = { received: undefined };
        const pipeline = new MultiAgentPipeline(buildDeps(scenario, record), {
          logger: { warn: () => undefined },
        });

        await pipeline.processQuery('q', 'user-prop29');

        expect(record.received).toBeDefined();
        // Reference identity is preserved through the pipeline, so the
        // strongest "no invented chunks" check is a strict membership
        // test against the original retrieval list.
        for (const chunk of record.received as RetrievedChunk[]) {
          expect(
            scenario.retrieved.includes(chunk),
            'recommendation context contained a chunk the retrieval agent never produced',
          ).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('partitions schemeIds: incompatibleSchemeIds is disjoint from compatibleChunks schemeIds', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const record: { received: RetrievedChunk[] | undefined } = { received: undefined };
        const pipeline = new MultiAgentPipeline(buildDeps(scenario, record), {
          logger: { warn: () => undefined },
        });

        await pipeline.processQuery('q', 'user-prop29');

        expect(record.received).toBeDefined();
        const compatibleSchemeIds = new Set(
          (record.received as RetrievedChunk[]).map((c) => c.schemeId),
        );
        for (const id of scenario.incompatibleSchemeIds) {
          expect(
            compatibleSchemeIds.has(id),
            `schemeId ${id} appears in both incompatible and compatible sets`,
          ).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
