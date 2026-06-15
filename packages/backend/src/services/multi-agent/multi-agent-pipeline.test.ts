/**
 * Unit tests for the {@link MultiAgentPipeline} orchestrator.
 *
 * The pipeline is exercised end-to-end with in-memory mock agents so
 * the suite is hermetic and runs in milliseconds. Scenarios covered:
 *   - Successful end-to-end run produces a {@link PipelineResult} with
 *     a unique trace ID, an entry per executed agent, and the
 *     synthesised response (Req 25.1, 25.7, 25.10).
 *   - The Planner_Agent's routing plan controls which downstream
 *     agents run; skipped agents are bypassed entirely (Req 25.2).
 *   - The Retrieval_Agent's output is hard-capped at 10 chunks
 *     (Req 25.4).
 *   - The Compatibility_Agent's filter shrinks the chunk list before
 *     it reaches the Recommendation_Agent (Req 25.5).
 *   - Per-agent timeouts cause the offending agent to be bypassed
 *     while the rest of the pipeline continues (Req 25.9).
 *   - Failures are logged with the agent name and error reason
 *     (Req 25.9).
 *   - The total pipeline budget is enforced (Req 25.8).
 *   - {@link applyRoutingPlan} preserves pipeline order and respects
 *     the planner's required/skipped lists.
 *
 * Validates: Requirements 25.1, 25.2, 25.4, 25.5, 25.7, 25.8, 25.9, 25.10
 */

import { describe, it, expect, vi, type Mock } from 'vitest';

import {
  ALL_AGENTS,
  AGENT_TIMEOUT_MS,
  MultiAgentPipeline,
  PIPELINE_FALLBACK_RESPONSE,
  PIPELINE_TIMEOUT_MS,
  RETRIEVAL_TOP_K,
  applyRoutingPlan,
  isValidRoutingPlan,
  type AgentContext,
  type AgentFailure,
  type AgentRoutingPlan,
  type CompatibilityAgent,
  type EligibilityAgent,
  type MultiAgentPipelineDeps,
  type PipelineLogger,
  type PlannerAgent,
  type RecommendationAgent,
  type ResponseAgent,
  type RetrievalAgent,
} from './multi-agent-pipeline';
import type {
  EligibilityResult,
  Recommendation,
  RetrievedChunk,
  SourceCitation,
} from '@bharat-benefits/shared';

// ─── Mock factories ──────────────────────────────────────────────────────────

interface MockOverrides {
  plan?: AgentRoutingPlan;
  retrieved?: RetrievedChunk[];
  compatible?: RetrievedChunk[];
  incompatibleSchemeIds?: string[];
  recommendations?: Recommendation[];
  eligibility?: Map<string, EligibilityResult>;
  answer?: string;
  sources?: SourceCitation[];
}

function makeChunk(schemeId: string, idx: number = 0, similarity: number = 0.9): RetrievedChunk {
  return {
    schemeId,
    chunkText: `chunk ${idx} for ${schemeId}`,
    chunkIndex: idx,
    similarity,
  };
}

function makeRecommendation(schemeId: string, score: number): Recommendation {
  return {
    schemeId,
    matchScore: score,
    benefitAmount: 1000,
    deadline: null,
    explanation: `Recommended ${schemeId}`,
    priorityGroup: 'central',
  };
}

function makeSource(schemeId: string): SourceCitation {
  return {
    schemeId,
    schemeName: `Scheme ${schemeId}`,
    sourceUrl: `https://example.gov.in/${schemeId}`,
    lastUpdated: new Date('2024-01-01T00:00:00Z'),
  };
}

function makeMockDeps(overrides: MockOverrides = {}): {
  deps: MultiAgentPipelineDeps;
  spies: {
    planner: Mock;
    eligibility: Mock;
    retrieval: Mock;
    compatibility: Mock;
    recommendation: Mock;
    response: Mock;
  };
} {
  const defaultPlan: AgentRoutingPlan = overrides.plan ?? {
    queryType: 'information',
    requiredAgents: ['eligibility', 'retrieval', 'compatibility', 'recommendation', 'response'],
    skippedAgents: [],
  };

  const retrieved = overrides.retrieved ?? [makeChunk('s1', 0), makeChunk('s2', 1)];
  const compatibleResult = {
    compatible: overrides.compatible ?? retrieved,
    incompatibleSchemeIds: overrides.incompatibleSchemeIds ?? [],
  };
  const recommendations = overrides.recommendations ?? [
    makeRecommendation('s1', 90),
    makeRecommendation('s2', 80),
  ];
  const eligibility =
    overrides.eligibility ??
    new Map<string, EligibilityResult>([
      [
        's1',
        {
          status: 'Eligible',
          metCriteria: [],
          unmetCriteria: [],
          unevaluatedCriteria: [],
          missingProfileFields: [],
        },
      ],
    ]);
  const answer = overrides.answer ?? 'Synthesised answer';
  const sources = overrides.sources ?? [makeSource('s1')];

  const planner = vi.fn(async (_q: string, _ctx: AgentContext) => defaultPlan);
  const eligibilityFn = vi.fn(async (_ctx: AgentContext) => eligibility);
  const retrievalFn = vi.fn(async (_ctx: AgentContext) => retrieved);
  const compatibilityFn = vi.fn(async (_ctx: AgentContext) => compatibleResult);
  const recommendationFn = vi.fn(async (_ctx: AgentContext) => recommendations);
  const responseFn = vi.fn(async (_ctx: AgentContext) => ({ answer, sources }));

  const deps: MultiAgentPipelineDeps = {
    planner: { analyzeIntent: planner } as PlannerAgent,
    eligibility: { evaluate: eligibilityFn } as EligibilityAgent,
    retrieval: { retrieve: retrievalFn } as RetrievalAgent,
    compatibility: { filterIncompatible: compatibilityFn } as CompatibilityAgent,
    recommendation: { rank: recommendationFn } as RecommendationAgent,
    response: { synthesize: responseFn } as ResponseAgent,
  };

  return {
    deps,
    spies: {
      planner,
      eligibility: eligibilityFn,
      retrieval: retrievalFn,
      compatibility: compatibilityFn,
      recommendation: recommendationFn,
      response: responseFn,
    },
  };
}

function makeRecordingLogger(): PipelineLogger & { records: AgentFailure[] } {
  const records: AgentFailure[] = [];
  return {
    records,
    warn: (failure) => {
      records.push(failure);
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MultiAgentPipeline.processQuery', () => {
  it('runs every required agent in order and returns a PipelineResult', async () => {
    const { deps, spies } = makeMockDeps();
    const pipeline = new MultiAgentPipeline(deps);

    const result = await pipeline.processQuery('Am I eligible for PM-Kisan?', 'user-1');

    expect(result.response).toBe('Synthesised answer');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.schemeId).toBe('s1');
    expect(typeof result.traceId).toBe('string');
    expect(result.traceId.length).toBeGreaterThan(0);
    expect(result.totalDuration).toBeGreaterThanOrEqual(0);

    // Every pipeline agent should have an entry in agentOutputs.
    for (const agent of ALL_AGENTS) {
      const out = result.agentOutputs.get(agent);
      expect(out, `expected output for ${agent}`).toBeDefined();
      expect(out?.success).toBe(true);
    }

    // Each spy should be invoked exactly once.
    expect(spies.planner).toHaveBeenCalledTimes(1);
    expect(spies.eligibility).toHaveBeenCalledTimes(1);
    expect(spies.retrieval).toHaveBeenCalledTimes(1);
    expect(spies.compatibility).toHaveBeenCalledTimes(1);
    expect(spies.recommendation).toHaveBeenCalledTimes(1);
    expect(spies.response).toHaveBeenCalledTimes(1);
  });

  it('threads the same traceId through every agent (Req 25.10)', async () => {
    const { deps, spies } = makeMockDeps();
    const pipeline = new MultiAgentPipeline(deps);

    const result = await pipeline.processQuery('what schemes apply?', 'user-2');

    const callContexts = [
      spies.planner.mock.calls[0]?.[1],
      spies.eligibility.mock.calls[0]?.[0],
      spies.retrieval.mock.calls[0]?.[0],
      spies.compatibility.mock.calls[0]?.[0],
      spies.recommendation.mock.calls[0]?.[0],
      spies.response.mock.calls[0]?.[0],
    ] as AgentContext[];

    for (const ctx of callContexts) {
      expect(ctx.traceId).toBe(result.traceId);
    }
  });

  it('skips agents the planner marks as skipped (Req 25.2)', async () => {
    const { deps, spies } = makeMockDeps({
      plan: {
        queryType: 'information',
        requiredAgents: ['retrieval', 'response'],
        skippedAgents: ['eligibility', 'compatibility', 'recommendation'],
      },
    });
    const pipeline = new MultiAgentPipeline(deps);

    const result = await pipeline.processQuery('Tell me about PMAY', 'user-3');

    expect(spies.planner).toHaveBeenCalledTimes(1);
    expect(spies.retrieval).toHaveBeenCalledTimes(1);
    expect(spies.response).toHaveBeenCalledTimes(1);
    expect(spies.eligibility).not.toHaveBeenCalled();
    expect(spies.compatibility).not.toHaveBeenCalled();
    expect(spies.recommendation).not.toHaveBeenCalled();

    expect(result.agentOutputs.has('eligibility')).toBe(false);
    expect(result.agentOutputs.has('recommendation')).toBe(false);
    expect(result.agentOutputs.get('retrieval')?.success).toBe(true);
  });

  it('caps retrieval output at 10 chunks (Req 25.4)', async () => {
    const big: RetrievedChunk[] = Array.from({ length: 20 }, (_, i) => makeChunk(`s${i}`, i));
    const { deps, spies } = makeMockDeps({ retrieved: big });
    const pipeline = new MultiAgentPipeline(deps);

    await pipeline.processQuery('q', 'user-4');

    // The compatibility agent should receive at most RETRIEVAL_TOP_K
    // chunks via the shared context.
    const ctx = spies.compatibility.mock.calls[0]?.[0] as AgentContext;
    expect(ctx.retrieved?.length).toBe(RETRIEVAL_TOP_K);
  });

  it('passes filtered chunks from compatibility to recommendation (Req 25.5)', async () => {
    const retrieved = [makeChunk('s1'), makeChunk('s2'), makeChunk('s3')];
    const compatible = [makeChunk('s1'), makeChunk('s3')];
    const { deps, spies } = makeMockDeps({
      retrieved,
      compatible,
      incompatibleSchemeIds: ['s2'],
    });
    const pipeline = new MultiAgentPipeline(deps);

    await pipeline.processQuery('q', 'user-5');

    const ctx = spies.recommendation.mock.calls[0]?.[0] as AgentContext;
    expect(ctx.compatibleChunks).toEqual(compatible);
    expect(ctx.incompatibleSchemeIds).toEqual(['s2']);
  });

  it('bypasses an agent that exceeds its 5s timeout and continues (Req 25.9)', async () => {
    const logger = makeRecordingLogger();
    const slowRetrieve: RetrievalAgent = {
      retrieve: () =>
        new Promise<RetrievedChunk[]>((resolve) => {
          setTimeout(() => resolve([makeChunk('late')]), 200);
        }),
    };
    const { deps, spies } = makeMockDeps();
    const pipeline = new MultiAgentPipeline(
      { ...deps, retrieval: slowRetrieve },
      { agentTimeoutMs: 20, logger },
    );

    const result = await pipeline.processQuery('q', 'user-6');

    const retrievalOut = result.agentOutputs.get('retrieval');
    expect(retrievalOut?.success).toBe(false);
    expect(retrievalOut?.result).toBeNull();

    // Pipeline still continues to response.
    expect(spies.response).toHaveBeenCalledTimes(1);
    expect(result.response).toBe('Synthesised answer');

    // Failure is logged with agent name and a reason mentioning the timeout.
    const retrievalFailure = logger.records.find((r) => r.agentName === 'retrieval');
    expect(retrievalFailure).toBeDefined();
    expect(retrievalFailure?.reason).toMatch(/timeout/i);
  });

  it('logs failures with agent name and error reason when an agent throws (Req 25.9)', async () => {
    const logger = makeRecordingLogger();
    const erroringEligibility: EligibilityAgent = {
      evaluate: async () => {
        throw new Error('boom');
      },
    };
    const { deps, spies } = makeMockDeps();
    const pipeline = new MultiAgentPipeline(
      { ...deps, eligibility: erroringEligibility },
      { logger },
    );

    const result = await pipeline.processQuery('q', 'user-7');

    const out = result.agentOutputs.get('eligibility');
    expect(out?.success).toBe(false);

    const failure = logger.records.find((r) => r.agentName === 'eligibility');
    expect(failure).toBeDefined();
    expect(failure?.reason).toBe('boom');

    // Downstream agents still ran.
    expect(spies.retrieval).toHaveBeenCalledTimes(1);
    expect(spies.response).toHaveBeenCalledTimes(1);
  });

  it('falls back to a default routing plan when the planner fails', async () => {
    const logger = makeRecordingLogger();
    const failingPlanner: PlannerAgent = {
      analyzeIntent: async () => {
        throw new Error('planner offline');
      },
    };
    const { deps, spies } = makeMockDeps();
    const pipeline = new MultiAgentPipeline({ ...deps, planner: failingPlanner }, { logger });

    const result = await pipeline.processQuery('q', 'user-8');

    expect(spies.eligibility).toHaveBeenCalledTimes(1);
    expect(spies.retrieval).toHaveBeenCalledTimes(1);
    expect(spies.response).toHaveBeenCalledTimes(1);
    expect(result.response).toBe('Synthesised answer');
    expect(logger.records.some((r) => r.agentName === 'planner')).toBe(true);
  });

  it('aborts remaining agents when the total pipeline budget is exhausted (Req 25.8)', async () => {
    let now = 0;
    const clock = () => now;
    const { deps, spies } = makeMockDeps();

    // Make each agent consume 4s of virtual wall-clock time.
    const advance = (ms: number) => () => {
      now += ms;
    };
    spies.planner.mockImplementation(async (_q, _ctx) => {
      advance(4_000)();
      return {
        queryType: 'information',
        requiredAgents: ['eligibility', 'retrieval', 'compatibility', 'recommendation', 'response'],
        skippedAgents: [],
      } as AgentRoutingPlan;
    });
    spies.eligibility.mockImplementation(async () => {
      advance(4_000)();
      return new Map();
    });
    spies.retrieval.mockImplementation(async () => {
      advance(4_000)();
      return [makeChunk('late')];
    });

    const logger = makeRecordingLogger();
    const pipeline = new MultiAgentPipeline(deps, {
      now: clock,
      pipelineTimeoutMs: PIPELINE_TIMEOUT_MS,
      logger,
    });

    const result = await pipeline.processQuery('q', 'user-9');

    // Planner + eligibility + retrieval consumed 12s of virtual time;
    // the orchestrator should bypass everything from compatibility on.
    expect(spies.compatibility).not.toHaveBeenCalled();
    expect(spies.recommendation).not.toHaveBeenCalled();
    expect(spies.response).not.toHaveBeenCalled();
    expect(result.response).toBe(PIPELINE_FALLBACK_RESPONSE);

    // The bypassed response is recorded as failed for observability.
    expect(result.agentOutputs.get('response')?.success).toBe(false);
  });

  it('rejects empty query and userId', async () => {
    const { deps } = makeMockDeps();
    const pipeline = new MultiAgentPipeline(deps);

    await expect(pipeline.processQuery('', 'user-1')).rejects.toThrow(/query/);
    await expect(pipeline.processQuery('q', '')).rejects.toThrow(/userId/);
  });

  it('uses the configured timeouts', () => {
    const { deps } = makeMockDeps();
    const pipeline = new MultiAgentPipeline(deps);
    // Sanity check that the defaults match the documented constants.
    expect(AGENT_TIMEOUT_MS).toBe(5_000);
    expect(PIPELINE_TIMEOUT_MS).toBe(10_000);
    expect(pipeline).toBeInstanceOf(MultiAgentPipeline);
  });
});

describe('applyRoutingPlan', () => {
  it('returns agents in pipeline order with planner first', () => {
    const plan: AgentRoutingPlan = {
      queryType: 'recommendation',
      requiredAgents: ['recommendation', 'response', 'retrieval'],
      skippedAgents: ['eligibility', 'compatibility'],
    };
    const ordered = applyRoutingPlan(plan);
    expect(ordered).toEqual(['planner', 'retrieval', 'recommendation', 'response']);
  });

  it('always includes planner and response even when omitted from required', () => {
    const plan: AgentRoutingPlan = {
      queryType: 'information',
      requiredAgents: [],
      skippedAgents: ['eligibility', 'retrieval', 'compatibility', 'recommendation', 'response'],
    };
    const ordered = applyRoutingPlan(plan);
    expect(ordered[0]).toBe('planner');
    expect(ordered).toContain('response');
  });

  it('omits agents not in the required list', () => {
    const plan: AgentRoutingPlan = {
      queryType: 'information',
      requiredAgents: ['response'],
      skippedAgents: ['eligibility', 'retrieval', 'compatibility', 'recommendation'],
    };
    const ordered = applyRoutingPlan(plan);
    expect(ordered).toEqual(['planner', 'response']);
  });

  it('produces no duplicates', () => {
    const plan: AgentRoutingPlan = {
      queryType: 'eligibility',
      requiredAgents: ['eligibility', 'retrieval', 'compatibility', 'recommendation', 'response'],
      skippedAgents: [],
    };
    const ordered = applyRoutingPlan(plan);
    expect(new Set(ordered).size).toBe(ordered.length);
  });
});

describe('isValidRoutingPlan', () => {
  it('accepts a well-formed plan', () => {
    expect(
      isValidRoutingPlan({
        queryType: 'information',
        requiredAgents: ['retrieval', 'response'],
        skippedAgents: ['eligibility', 'compatibility', 'recommendation'],
      }),
    ).toBe(true);
  });

  it('rejects an unknown query type', () => {
    expect(
      isValidRoutingPlan({
        queryType: 'gibberish' as never,
        requiredAgents: ['retrieval', 'response'],
        skippedAgents: ['eligibility', 'compatibility', 'recommendation'],
      }),
    ).toBe(false);
  });

  it('rejects overlapping required and skipped lists', () => {
    expect(
      isValidRoutingPlan({
        queryType: 'information',
        requiredAgents: ['retrieval', 'response'],
        skippedAgents: ['retrieval', 'eligibility', 'compatibility', 'recommendation'],
      }),
    ).toBe(false);
  });

  it('rejects when an agent is neither required nor skipped', () => {
    expect(
      isValidRoutingPlan({
        queryType: 'information',
        requiredAgents: ['retrieval'],
        skippedAgents: ['eligibility'],
      }),
    ).toBe(false);
  });
});
