/**
 * Multi-Agent Pipeline — orchestrates the specialized agents that
 * collaborate to answer a citizen's query (Req 25.1–25.10).
 *
 * Pipeline order (Req 25.1):
 *   Planner → Eligibility → Retrieval → Compatibility → Recommendation → Response
 *
 * Responsibilities:
 *   - Planner analyses the query and produces an
 *     {@link AgentRoutingPlan} that names the agents to run and the
 *     ones to skip (Req 25.2).
 *   - Each agent gets a 5 s budget; if it blows the budget or throws,
 *     the orchestrator bypasses it, logs the failure with the agent
 *     name + error reason, and continues with the outputs collected so
 *     far (Req 25.9).
 *   - The Retrieval_Agent fetches the top 10 chunks (Req 25.4); the
 *     Compatibility_Agent filters incompatible schemes before they
 *     reach the Recommendation_Agent (Req 25.5).
 *   - The whole pipeline must finish within 10 s; once that wall-clock
 *     budget is exhausted, every remaining agent is skipped (Req 25.8).
 *   - A single trace ID is generated per query and threaded through
 *     every agent invocation so end-to-end observability is possible
 *     (Req 25.10).
 *
 * Every agent is provided to the pipeline by dependency injection so
 * the orchestrator can be unit-tested with simple in-memory fakes —
 * the LLM-backed agent implementations live elsewhere.
 */

import { randomUUID } from 'node:crypto';

import type {
  AgentName,
  AgentOutput,
  AgentRoutingPlan,
  EligibilityResult,
  PipelineResult,
  QueryType,
  Recommendation,
  RetrievedChunk,
  Scheme,
  SourceCitation,
} from '@bharat-benefits/shared';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Per-agent timeout budget in milliseconds (Req 25.9). */
export const AGENT_TIMEOUT_MS = 5_000;

/** Total pipeline timeout budget in milliseconds (Req 25.8). */
export const PIPELINE_TIMEOUT_MS = 10_000;

/** Number of chunks the Retrieval_Agent must return (Req 25.4). */
export const RETRIEVAL_TOP_K = 10;

/** Canonical, ordered list of every agent in the pipeline (Req 25.1). */
export const ALL_AGENTS: readonly AgentName[] = [
  'planner',
  'eligibility',
  'retrieval',
  'compatibility',
  'recommendation',
  'response',
] as const;

// ─── Agent context & interfaces ──────────────────────────────────────────────

/**
 * Shared context object passed to every agent. Populated as the
 * pipeline progresses so downstream agents can read upstream output
 * without taking a hard dependency on the orchestrator.
 */
export interface AgentContext {
  /** Unique trace ID propagated to every agent (Req 25.10). */
  traceId: string;
  /** Original citizen query. */
  query: string;
  /** Citizen ID — used by the Eligibility_Agent. */
  userId: string;
  /** Routing plan produced by the Planner_Agent (Req 25.2). */
  routingPlan?: AgentRoutingPlan;
  /** Eligibility decisions keyed by scheme ID (Req 25.3). */
  eligibility?: Map<string, EligibilityResult>;
  /** Top retrieved chunks from the vector DB (Req 25.4). */
  retrieved?: RetrievedChunk[];
  /** Chunks remaining after compatibility filtering (Req 25.5). */
  compatibleChunks?: RetrievedChunk[];
  /** Schemes filtered out as incompatible — kept for observability. */
  incompatibleSchemeIds?: string[];
  /** Ranked recommendations (Req 25.6). */
  recommendations?: Recommendation[];
  /** Source citations attached to the final response. */
  sources?: SourceCitation[];
}

export interface PlannerAgent {
  /**
   * Returns a routing plan whose `requiredAgents` and `skippedAgents`
   * partition every agent in {@link ALL_AGENTS} except `planner`
   * itself (the planner is always required and is not listed).
   *
   * Receives an optional `AbortSignal` that fires when the per-agent
   * timeout elapses. Implementations that make HTTP calls SHOULD pass
   * the signal to `fetch` so the underlying request is cancelled rather
   * than continuing in the background.
   */
  analyzeIntent(
    query: string,
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<AgentRoutingPlan>;
}

export interface EligibilityAgent {
  /**
   * Evaluates eligibility for the citizen against a set of candidate
   * schemes (typically populated from upstream context or an internal
   * lookup). Returns a map keyed by scheme ID. The signal fires when
   * the per-agent timeout elapses.
   */
  evaluate(
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<Map<string, EligibilityResult>>;
}

export interface RetrievalAgent {
  /**
   * Performs semantic search and returns the top
   * {@link RETRIEVAL_TOP_K} chunks (Req 25.4). The signal fires when
   * the per-agent timeout elapses — wire it through to your vector DB
   * client so cancelled queries don't keep spending compute.
   */
  retrieve(
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<RetrievedChunk[]>;
}

export interface CompatibilityAgent {
  /**
   * Filters incompatible schemes out of the retrieved chunk list
   * (Req 25.5). Implementations may consult the Compatibility_Engine
   * but the pipeline only requires the filtered output.
   */
  filterIncompatible(
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<{
    compatible: RetrievedChunk[];
    incompatibleSchemeIds: string[];
  }>;
}

export interface RecommendationAgent {
  /**
   * Ranks the surviving schemes using the Match_Score + state-aware
   * prioritisation logic (Req 25.6).
   */
  rank(
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<Recommendation[]>;
}

export interface ResponseAgent {
  /**
   * Synthesises the final user-facing answer from upstream outputs
   * (Req 25.7). Returns the answer text plus the citations the
   * orchestrator should attach to {@link PipelineResult.sources}.
   *
   * The signal is the most important here — response agents typically
   * call an LLM, and a stalled LLM call is the primary reason for
   * pipeline budget exhaustion. Pass it through to your LLM client.
   */
  synthesize(
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<{
    answer: string;
    sources: SourceCitation[];
  }>;
}

// ─── Routing plan helpers ────────────────────────────────────────────────────

/**
 * Pure helper that flattens a routing plan to the ordered list of
 * agents that should actually execute. Exported separately so that
 * property tests 9.4 and 9.5 can exercise the routing logic without
 * spinning up the full pipeline.
 *
 * Guarantees (used by Property 28):
 *   - The planner is always first.
 *   - The result is a subset of {@link ALL_AGENTS} preserving pipeline
 *     order.
 *   - No agent appears more than once.
 *   - Skipped agents are omitted; the response agent is always
 *     retained because it is the only way to produce an answer
 *     (Req 25.7) and the planner cannot meaningfully skip it.
 */
export function applyRoutingPlan(plan: AgentRoutingPlan): AgentName[] {
  const skipped = new Set(plan.skippedAgents);
  const required = new Set<AgentName>(plan.requiredAgents);
  // Planner & response are mandatory regardless of what the plan says.
  required.add('planner');
  required.add('response');

  const ordered: AgentName[] = [];
  for (const agent of ALL_AGENTS) {
    // The planner is implicit in the plan but we still need to run it
    // first in the pipeline.
    if (agent === 'planner') {
      ordered.push(agent);
      continue;
    }
    if (skipped.has(agent) && !required.has(agent)) {
      continue;
    }
    if (required.has(agent)) {
      ordered.push(agent);
    }
  }
  return ordered;
}

/**
 * Validates a routing plan against the invariants the orchestrator
 * relies on. Returns `true` when the plan is well-formed.
 *
 * Invariants (Property 28):
 *   - `queryType` is one of the allowed {@link QueryType} values.
 *   - Every entry in `requiredAgents`/`skippedAgents` is a valid
 *     {@link AgentName}.
 *   - The two lists are disjoint.
 *   - Their union covers every non-planner agent in the pipeline.
 */
export function isValidRoutingPlan(plan: AgentRoutingPlan): boolean {
  const validQueryTypes: QueryType[] = ['eligibility', 'recommendation', 'information', 'comparison'];
  if (!validQueryTypes.includes(plan.queryType)) return false;

  const validAgents = new Set<AgentName>(ALL_AGENTS);
  for (const a of plan.requiredAgents) {
    if (!validAgents.has(a)) return false;
  }
  for (const a of plan.skippedAgents) {
    if (!validAgents.has(a)) return false;
  }

  const required = new Set(plan.requiredAgents);
  for (const a of plan.skippedAgents) {
    if (required.has(a)) return false;
  }

  const union = new Set<AgentName>([...plan.requiredAgents, ...plan.skippedAgents]);
  for (const a of ALL_AGENTS) {
    if (a === 'planner') continue; // planner is implicit, never listed
    if (!union.has(a)) return false;
  }
  return true;
}

// ─── Pipeline failure logging ────────────────────────────────────────────────

export interface AgentFailure {
  agentName: AgentName;
  reason: string;
  durationMs: number;
}

/** Pluggable failure logger so tests can assert on log output. */
export interface PipelineLogger {
  warn(failure: AgentFailure): void;
}

const defaultLogger: PipelineLogger = {
  warn: (failure) => {
    // eslint-disable-next-line no-console
    console.warn(
      `[multi-agent-pipeline] agent="${failure.agentName}" failed in ${failure.durationMs}ms: ${failure.reason}`,
    );
  },
};

// ─── Service ─────────────────────────────────────────────────────────────────

export interface MultiAgentPipelineDeps {
  planner: PlannerAgent;
  eligibility: EligibilityAgent;
  retrieval: RetrievalAgent;
  compatibility: CompatibilityAgent;
  recommendation: RecommendationAgent;
  response: ResponseAgent;
}

export interface MultiAgentPipelineOptions {
  /** Override the per-agent timeout (defaults to 5 000 ms). */
  agentTimeoutMs?: number;
  /** Override the total pipeline timeout (defaults to 10 000 ms). */
  pipelineTimeoutMs?: number;
  /** Custom logger (defaults to a console-based implementation). */
  logger?: PipelineLogger;
  /** Override `Date.now`-style clock for deterministic tests. */
  now?: () => number;
}

/**
 * Sentinel response when no agent could produce an answer. Mirrors the
 * tone of the assistant's refusal (Req 6.3) so the user is never met
 * with a blank reply.
 */
export const PIPELINE_FALLBACK_RESPONSE =
  "I couldn't process your query end-to-end right now. Please try again or check official scheme sources.";

export class MultiAgentPipeline {
  private readonly planner: PlannerAgent;
  private readonly eligibility: EligibilityAgent;
  private readonly retrieval: RetrievalAgent;
  private readonly compatibility: CompatibilityAgent;
  private readonly recommendation: RecommendationAgent;
  private readonly response: ResponseAgent;
  private readonly agentTimeoutMs: number;
  private readonly pipelineTimeoutMs: number;
  private readonly logger: PipelineLogger;
  private readonly now: () => number;

  constructor(deps: MultiAgentPipelineDeps, options: MultiAgentPipelineOptions = {}) {
    if (!deps.planner) throw new Error('MultiAgentPipeline: planner agent is required');
    if (!deps.eligibility) throw new Error('MultiAgentPipeline: eligibility agent is required');
    if (!deps.retrieval) throw new Error('MultiAgentPipeline: retrieval agent is required');
    if (!deps.compatibility) throw new Error('MultiAgentPipeline: compatibility agent is required');
    if (!deps.recommendation) throw new Error('MultiAgentPipeline: recommendation agent is required');
    if (!deps.response) throw new Error('MultiAgentPipeline: response agent is required');

    this.planner = deps.planner;
    this.eligibility = deps.eligibility;
    this.retrieval = deps.retrieval;
    this.compatibility = deps.compatibility;
    this.recommendation = deps.recommendation;
    this.response = deps.response;
    this.agentTimeoutMs = options.agentTimeoutMs ?? AGENT_TIMEOUT_MS;
    this.pipelineTimeoutMs = options.pipelineTimeoutMs ?? PIPELINE_TIMEOUT_MS;
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Runs the multi-agent pipeline end-to-end for a single query.
   *
   * The method always resolves with a {@link PipelineResult} — even
   * when individual agents fail or the pipeline budget is exhausted —
   * so callers do not have to handle exceptions for non-fatal agent
   * problems (Req 25.9).
   */
  async processQuery(query: string, userId: string): Promise<PipelineResult> {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new TypeError('processQuery: query must be a non-empty string');
    }
    if (typeof userId !== 'string' || userId.trim().length === 0) {
      throw new TypeError('processQuery: userId must be a non-empty string');
    }

    const traceId = randomUUID();
    const startedAt = this.now();
    const agentOutputs = new Map<AgentName, AgentOutput>();
    const context: AgentContext = { traceId, query, userId };

    // ── 1. Planner ─────────────────────────────────────────────────────────
    const plannerOutput = await this.runAgent('planner', (signal) =>
      this.planner.analyzeIntent(query, context, signal),
    );
    agentOutputs.set('planner', plannerOutput);
    if (plannerOutput.success && isValidRoutingPlan(plannerOutput.result as AgentRoutingPlan)) {
      context.routingPlan = plannerOutput.result as AgentRoutingPlan;
    } else {
      // Default routing: run every downstream agent. Ensures we still
      // produce a useful answer when the planner fails (Req 25.9).
      context.routingPlan = {
        queryType: 'information',
        requiredAgents: ALL_AGENTS.filter((a) => a !== 'planner') as AgentName[],
        skippedAgents: [],
      };
    }

    const orderedAgents = applyRoutingPlan(context.routingPlan);

    // ── 2. Eligibility ─────────────────────────────────────────────────────
    if (this.shouldRun(orderedAgents, 'eligibility') && !this.outOfBudget(startedAt)) {
      const out = await this.runAgent('eligibility', (signal) =>
        this.eligibility.evaluate(context, signal),
      );
      agentOutputs.set('eligibility', out);
      if (out.success && out.result instanceof Map) {
        context.eligibility = out.result as Map<string, EligibilityResult>;
      }
    }

    // ── 3. Retrieval ───────────────────────────────────────────────────────
    if (this.shouldRun(orderedAgents, 'retrieval') && !this.outOfBudget(startedAt)) {
      const out = await this.runAgent('retrieval', (signal) =>
        this.retrieval.retrieve(context, signal),
      );
      agentOutputs.set('retrieval', out);
      if (out.success && Array.isArray(out.result)) {
        // Hard-cap to RETRIEVAL_TOP_K so misbehaving agents cannot
        // overwhelm downstream stages (Req 25.4).
        context.retrieved = (out.result as RetrievedChunk[]).slice(0, RETRIEVAL_TOP_K);
      }
    }

    // ── 4. Compatibility ──────────────────────────────────────────────────
    if (
      this.shouldRun(orderedAgents, 'compatibility') &&
      !this.outOfBudget(startedAt) &&
      Array.isArray(context.retrieved)
    ) {
      const out = await this.runAgent('compatibility', (signal) =>
        this.compatibility.filterIncompatible(context, signal),
      );
      agentOutputs.set('compatibility', out);
      if (
        out.success &&
        out.result &&
        typeof out.result === 'object' &&
        Array.isArray((out.result as { compatible?: unknown }).compatible)
      ) {
        const r = out.result as {
          compatible: RetrievedChunk[];
          incompatibleSchemeIds: string[];
        };
        context.compatibleChunks = r.compatible;
        context.incompatibleSchemeIds = r.incompatibleSchemeIds ?? [];
      } else {
        // On failure, fall through with the unfiltered list so the
        // downstream agents still have data to work with.
        context.compatibleChunks = context.retrieved;
        context.incompatibleSchemeIds = [];
      }
    } else if (Array.isArray(context.retrieved)) {
      context.compatibleChunks = context.retrieved;
      context.incompatibleSchemeIds = [];
    }

    // ── 5. Recommendation ─────────────────────────────────────────────────
    if (this.shouldRun(orderedAgents, 'recommendation') && !this.outOfBudget(startedAt)) {
      const out = await this.runAgent('recommendation', (signal) =>
        this.recommendation.rank(context, signal),
      );
      agentOutputs.set('recommendation', out);
      if (out.success && Array.isArray(out.result)) {
        context.recommendations = out.result as Recommendation[];
      }
    }

    // ── 6. Response ───────────────────────────────────────────────────────
    let answer = PIPELINE_FALLBACK_RESPONSE;
    let sources: SourceCitation[] = [];
    if (this.shouldRun(orderedAgents, 'response') && !this.outOfBudget(startedAt)) {
      const out = await this.runAgent('response', (signal) =>
        this.response.synthesize(context, signal),
      );
      agentOutputs.set('response', out);
      if (
        out.success &&
        out.result &&
        typeof out.result === 'object' &&
        typeof (out.result as { answer?: unknown }).answer === 'string'
      ) {
        const r = out.result as { answer: string; sources?: SourceCitation[] };
        answer = r.answer;
        sources = Array.isArray(r.sources) ? r.sources : [];
      }
    } else {
      // Pipeline budget exhausted before the response agent could
      // run. Still record the bypass so observability is complete
      // (Req 25.9, 25.10).
      const out: AgentOutput = {
        agentName: 'response',
        result: null,
        duration: 0,
        success: false,
      };
      agentOutputs.set('response', out);
      this.logger.warn({
        agentName: 'response',
        reason: 'pipeline budget exhausted before response agent could run',
        durationMs: this.now() - startedAt,
      });
    }

    const totalDuration = this.now() - startedAt;
    return {
      response: answer,
      sources,
      traceId,
      agentOutputs,
      totalDuration,
    };
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private shouldRun(orderedAgents: AgentName[], agent: AgentName): boolean {
    return orderedAgents.includes(agent);
  }

  private outOfBudget(startedAt: number): boolean {
    return this.now() - startedAt >= this.pipelineTimeoutMs;
  }

  /**
   * Wraps an agent invocation with a per-agent timeout and converts
   * thrown errors / timeouts into a non-throwing
   * {@link AgentOutput}. Failures are logged with the agent name and
   * reason so operators can correlate by trace ID (Req 25.9).
   *
   * The supplied `fn` receives an `AbortSignal` that fires when the
   * per-agent timeout elapses. Implementations that make HTTP calls
   * (Gemini, Pinecone, etc.) SHOULD pass the signal through so the
   * underlying request is cancelled instead of continuing in the
   * background and burning compute / cost after the orchestrator has
   * already moved on.
   */
  private async runAgent<T>(
    agentName: AgentName,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<AgentOutput> {
    const startedAt = this.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = setTimeout(() => {
        controller.abort(
          new Error(`agent ${agentName} exceeded ${this.agentTimeoutMs}ms timeout`),
        );
      }, this.agentTimeoutMs);
      // Don't keep the event loop alive solely for the timeout.
      if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }

      // Race the agent against the abort signal so the timeout still
      // surfaces as a rejection on agents that ignore the signal — but
      // willing implementations get clean cancellation via `signal`.
      const timeoutRejection = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            const reason = controller.signal.reason;
            reject(
              reason instanceof Error
                ? reason
                : new Error(
                    `agent ${agentName} aborted: ${String(reason ?? 'unknown')}`,
                  ),
            );
          },
          { once: true },
        );
      });

      const result = await Promise.race([fn(controller.signal), timeoutRejection]);
      const duration = this.now() - startedAt;
      return {
        agentName,
        result: result as unknown,
        duration,
        success: true,
      };
    } catch (err) {
      const duration = this.now() - startedAt;
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn({ agentName, reason, durationMs: duration });
      return {
        agentName,
        result: null,
        duration,
        success: false,
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      // Ensure the abort signal fires on the success path too — cleans
      // up any listeners attached inside `fn` that gate on `signal`.
      if (!controller.signal.aborted) {
        controller.abort(new Error('agent completed'));
      }
    }
  }
}

// ─── Convenience re-exports ──────────────────────────────────────────────────

export type {
  AgentName,
  AgentOutput,
  AgentRoutingPlan,
  PipelineResult,
  QueryType,
  Recommendation,
  RetrievedChunk,
  Scheme,
  SourceCitation,
  EligibilityResult,
};
