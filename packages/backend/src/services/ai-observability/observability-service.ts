/**
 * Orchestration layer for the AI observability subsystem (Req 21).
 *
 * The primitives (stores, monitor, tracer, evaluation runner, RAG
 * metrics) are decoupled units — each owns one slice of the contract
 * and is unit-testable in isolation. This service ties them together
 * into the workflows the platform actually runs:
 *
 *   - {@link ObservabilityService.recordAssistantQuery} — captures a
 *     completed Scheme_Assistant exchange and persists the
 *     {@link AIQueryLog} (Req 21.1, 21.5, 21.7).
 *   - {@link ObservabilityService.recordFeedback} — wraps the
 *     {@link FeedbackStore} and re-evaluates the helpfulness window
 *     after every rating so an alert fires the moment the rolling
 *     percentage dips below the threshold (Req 21.3, 21.4).
 *   - {@link ObservabilityService.aggregateDailyMetrics} — runs the
 *     daily RAG precision / recall rollup over the past 24 hours
 *     (Req 21.2).
 *   - {@link ObservabilityService.runWeeklyEvaluation} — executes the
 *     curated QA test set against the live assistant and persists the
 *     summary (Req 21.6).
 *   - {@link ObservabilityService.pruneExpiredLogs} — enforces the
 *     90-day retention contract on the query log table (Req 21.1).
 *
 * The worker entry point in `workers/ai-observability.worker.ts`
 * schedules these methods at the cadences the requirements call for.
 */

import { performance } from 'node:perf_hooks';

import type {
  AssistantResponse,
  RetrievedChunk,
  SourceCitation,
  SupportedLanguage,
} from '@bharat-benefits/shared';

import {
  DEGRADED_TRACE_THRESHOLD_MS,
  EVALUATION_RUN_CADENCE_DAYS,
} from './constants';
import {
  EvaluationRunner,
  type AssistantUnderTest,
  type EvaluationRunnerOptions,
} from './evaluation-runner';
import type { EvaluationRunStore } from './evaluation-run-store';
import type { FeedbackStore, RecordFeedbackInput } from './feedback-store';
import {
  HelpfulnessMonitor,
  type AdminAlertSink,
  type HelpfulnessSnapshot,
} from './helpfulness-monitor';
import type { AIQueryLogStore } from './query-log-store';
import { retentionCutoff } from './query-log-store';
import {
  aggregateRatedQueries,
  truncateToUtcDay,
  type RatedQueryObservation,
} from './rag-metrics';
import { Tracer, isDegradedDuration, type Span } from './tracing';
import type {
  AIQueryFeedback,
  AIQueryLog,
  DailyRagMetrics,
  EvaluationRunSummary,
  EvaluationTestCase,
  FeedbackRating,
  LoggedRetrievedChunk,
} from './types';

// ─── Public input shapes ─────────────────────────────────────────────────────

/**
 * Snapshot of a completed Scheme_Assistant exchange. Callers populate
 * this from the assistant's outputs (query, response, retrieved chunks
 * etc.) and hand it to {@link ObservabilityService.recordAssistantQuery}.
 *
 * `durationMs` is mandatory — the assistant must already know how long
 * the pipeline took because the wall-clock duration is part of its own
 * trace. Storing it explicitly avoids a "second clock" drift between
 * the tracing layer and the persisted log row.
 */
export interface AssistantExchange {
  traceId: string;
  sessionId: string;
  userId: string | null;
  query: string;
  response: AssistantResponse;
  retrievedChunks: ReadonlyArray<RetrievedChunk>;
  durationMs: number;
  /** When the assistant produced the response. Defaults to `now()`. */
  createdAt?: Date;
}

/** Filter applied when aggregating the daily RAG metrics. */
export interface AggregateDailyMetricsOptions {
  /** Override the day to aggregate (defaults to the previous UTC day). */
  date?: Date;
}

// ─── Service options & deps ──────────────────────────────────────────────────

/**
 * Hook invoked when {@link ObservabilityService.recordAssistantQuery}
 * persists a row whose `durationMs` exceeds
 * {@link DEGRADED_TRACE_THRESHOLD_MS}. The default no-ops so tests
 * don't have to inject one. Production wiring routes this to the same
 * admin alerting channel used by {@link HelpfulnessMonitor}.
 *
 * Validates: Requirements 21.7.
 */
export type DegradedQuerySink = (
  log: AIQueryLog,
) => Promise<void> | void;

/**
 * Resolves the "expected" scheme ids for a given query log row when
 * computing daily RAG metrics from citizen feedback (Req 21.2). The
 * production implementation pulls the citizen's rating, the curated
 * test set, or admin-provided ground truth; the in-memory unit-test
 * implementation can return a static stub.
 *
 * Returning `null` (or omitting the entry) excludes the observation
 * from the daily roll-up so unsupervised queries don't dilute the
 * recall average with vacuous values.
 */
export type ExpectedSchemeResolver = (
  log: AIQueryLog,
  feedback: ReadonlyArray<AIQueryFeedback>,
) => Promise<ReadonlyArray<string> | null> | ReadonlyArray<string> | null;

export interface ObservabilityServiceDeps {
  queryLogStore: AIQueryLogStore;
  feedbackStore: FeedbackStore;
  helpfulnessMonitor: HelpfulnessMonitor;
  evaluationRunStore: EvaluationRunStore;
  /**
   * Optional explicit tracer. Production wiring usually injects an
   * OpenTelemetry-backed tracer here; tests typically omit it and let
   * the service create its own no-op tracer.
   */
  tracer?: Tracer;
  /**
   * Resolves "expected" scheme ids for daily metric aggregation
   * (Req 21.2). When omitted, the service derives expected ids from
   * citizen feedback: cited schemes for `helpful` ratings, empty for
   * `unhelpful` ratings, and `null` for unrated queries (so they're
   * skipped).
   */
  expectedSchemeResolver?: ExpectedSchemeResolver;
}

export interface ObservabilityServiceOptions {
  /**
   * Sink invoked for every persisted query log whose `durationMs`
   * exceeds the degradation threshold (Req 21.7).
   */
  degradedQuerySink?: DegradedQuerySink;
  /**
   * Override the degradation threshold (defaults to
   * {@link DEGRADED_TRACE_THRESHOLD_MS}). Lower this in tests to make
   * the rule observable without sleeping for 10 seconds.
   */
  degradedThresholdMs?: number;
  /** Inject a clock so tests can pin "now" deterministically. */
  now?: () => Date;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ObservabilityService {
  private readonly queryLogStore: AIQueryLogStore;
  private readonly feedbackStore: FeedbackStore;
  private readonly helpfulnessMonitor: HelpfulnessMonitor;
  private readonly evaluationRunStore: EvaluationRunStore;
  private readonly tracer: Tracer;
  private readonly expectedSchemeResolver: ExpectedSchemeResolver;
  private readonly degradedQuerySink: DegradedQuerySink;
  private readonly degradedThresholdMs: number;
  private readonly now: () => Date;

  constructor(
    deps: ObservabilityServiceDeps,
    options: ObservabilityServiceOptions = {},
  ) {
    if (!deps.queryLogStore) {
      throw new Error('ObservabilityService: queryLogStore is required');
    }
    if (!deps.feedbackStore) {
      throw new Error('ObservabilityService: feedbackStore is required');
    }
    if (!deps.helpfulnessMonitor) {
      throw new Error('ObservabilityService: helpfulnessMonitor is required');
    }
    if (!deps.evaluationRunStore) {
      throw new Error('ObservabilityService: evaluationRunStore is required');
    }

    this.queryLogStore = deps.queryLogStore;
    this.feedbackStore = deps.feedbackStore;
    this.helpfulnessMonitor = deps.helpfulnessMonitor;
    this.evaluationRunStore = deps.evaluationRunStore;
    this.tracer = deps.tracer ?? new Tracer();
    this.expectedSchemeResolver =
      deps.expectedSchemeResolver ?? defaultExpectedSchemeResolver;
    this.degradedQuerySink = options.degradedQuerySink ?? (() => undefined);
    this.degradedThresholdMs =
      options.degradedThresholdMs ?? DEGRADED_TRACE_THRESHOLD_MS;
    this.now = options.now ?? (() => new Date());
  }

  /** Expose the tracer so higher layers can start child spans. */
  get tracing(): Tracer {
    return this.tracer;
  }

  /**
   * Convenience wrapper around {@link Tracer.startSpan} so call sites
   * never have to import the tracer module directly. The returned span
   * carries a stable trace id callers persist on the resulting
   * {@link AssistantExchange}.
   *
   * Validates: Requirements 21.5.
   */
  startQuerySpan(name: string, parent?: { traceId: string; spanId: string }): Span {
    return this.tracer.startSpan(name, parent);
  }

  /**
   * Persist a completed Scheme_Assistant exchange.
   *
   * - Stores the query, retrieved context, and response (Req 21.1).
   * - Tags the row as `degraded` when the duration exceeds the 10s
   *   threshold and dispatches the degraded sink (Req 21.7).
   * - Returns the persisted row so callers can attach it to logs /
   *   downstream analytics.
   */
  async recordAssistantQuery(exchange: AssistantExchange): Promise<AIQueryLog> {
    if (typeof exchange.traceId !== 'string' || exchange.traceId.length === 0) {
      throw new TypeError('recordAssistantQuery: traceId must be a non-empty string');
    }
    if (typeof exchange.sessionId !== 'string' || exchange.sessionId.length === 0) {
      throw new TypeError('recordAssistantQuery: sessionId must be a non-empty string');
    }
    if (typeof exchange.query !== 'string' || exchange.query.length === 0) {
      throw new TypeError('recordAssistantQuery: query must be a non-empty string');
    }
    if (!exchange.response || typeof exchange.response.answer !== 'string') {
      throw new TypeError('recordAssistantQuery: response.answer is required');
    }
    if (!Number.isFinite(exchange.durationMs) || exchange.durationMs < 0) {
      throw new TypeError(
        'recordAssistantQuery: durationMs must be a non-negative finite number',
      );
    }

    const createdAt = exchange.createdAt ?? this.now();
    const degraded = isDegradedDuration(exchange.durationMs, this.degradedThresholdMs);

    const log = await this.queryLogStore.append({
      traceId: exchange.traceId,
      sessionId: exchange.sessionId,
      userId: exchange.userId,
      query: exchange.query,
      response: exchange.response.answer,
      retrievedChunks: toLoggedChunks(exchange.retrievedChunks),
      sources: copySources(exchange.response.sources),
      language: exchange.response.language,
      durationMs: Math.round(exchange.durationMs),
      degraded,
      createdAt,
    });

    if (degraded) {
      // Fire-and-forget so a slow alerting channel never blocks the
      // assistant's response path. Errors are swallowed deliberately —
      // we'd rather lose a single alert than back-pressure the request.
      Promise.resolve(this.degradedQuerySink(log)).catch(() => undefined);
    }

    return log;
  }

  /**
   * Capture a citizen's helpful / unhelpful rating and immediately
   * re-evaluate the rolling helpfulness window. Returns both the
   * stored row and the snapshot the helpfulness monitor produced so
   * callers can surface live numbers in the UI without a second round
   * trip (Req 21.3, 21.4).
   */
  async recordFeedback(input: RecordFeedbackInput): Promise<{
    feedback: AIQueryFeedback;
    helpfulness: HelpfulnessSnapshot;
  }> {
    if (typeof input.traceId !== 'string' || input.traceId.length === 0) {
      throw new TypeError('recordFeedback: traceId must be a non-empty string');
    }
    if (input.rating !== 'helpful' && input.rating !== 'unhelpful') {
      throw new TypeError(
        `recordFeedback: rating must be 'helpful' or 'unhelpful' (got ${String(input.rating)})`,
      );
    }
    const feedback = await this.feedbackStore.record(input);
    const helpfulness = await this.helpfulnessMonitor.evaluateAndAlert(this.now());
    return { feedback, helpfulness };
  }

  /**
   * Compute the daily RAG precision / recall rollup for the supplied
   * day (defaults to the previous UTC day so the worker can run
   * shortly after midnight without missing late-evening traffic).
   *
   * Validates: Requirements 21.2.
   */
  async aggregateDailyMetrics(
    options: AggregateDailyMetricsOptions = {},
  ): Promise<DailyRagMetrics> {
    const day = truncateToUtcDay(options.date ?? this.previousUtcDay());
    const next = new Date(day.getTime() + 24 * 60 * 60 * 1000);

    const logs = await this.queryLogStore.list({
      since: day,
      before: next,
    });

    const observations: RatedQueryObservation[] = [];
    for (const log of logs) {
      const feedback = await this.feedbackStore.list({ traceId: log.traceId });
      const expected = await this.expectedSchemeResolver(log, feedback);
      if (!expected) continue;
      const retrieved = uniqueSchemeIds(log.retrievedChunks);
      observations.push({
        retrievedSchemeIds: retrieved,
        expectedSchemeIds: expected,
      });
    }

    return aggregateRatedQueries(day, observations);
  }

  /**
   * Execute the curated QA test set against the supplied assistant.
   * The runner enforces the 50-case minimum from
   * {@link MIN_EVALUATION_TEST_SET_SIZE}; the result is persisted to
   * the {@link EvaluationRunStore} for the admin dashboard.
   *
   * Validates: Requirements 21.6.
   */
  async runWeeklyEvaluation(params: {
    assistant: AssistantUnderTest;
    testCases: ReadonlyArray<EvaluationTestCase>;
    /**
     * Override runner options. Most callers should leave this empty;
     * tests use it to dial down the minimum test-set size.
     */
    runnerOptions?: EvaluationRunnerOptions;
  }): Promise<EvaluationRunSummary> {
    const runner = new EvaluationRunner(
      params.assistant,
      params.testCases,
      params.runnerOptions ?? {},
    );
    const summary = await runner.run();
    await this.evaluationRunStore.save(summary);
    return summary;
  }

  /**
   * Decide whether the weekly evaluation should run now based on the
   * cadence in {@link EVALUATION_RUN_CADENCE_DAYS} and the most recent
   * persisted run. Useful for an idempotent worker that wakes daily
   * but only fires the heavy run once per cadence.
   */
  async shouldRunWeeklyEvaluation(now: Date = this.now()): Promise<boolean> {
    const latest = await this.evaluationRunStore.latest();
    if (!latest) return true;
    const cadenceMs = EVALUATION_RUN_CADENCE_DAYS * 24 * 60 * 60 * 1000;
    return now.getTime() - latest.startedAt.getTime() >= cadenceMs;
  }

  /**
   * Drop every {@link AIQueryLog} older than 90 days (Req 21.1). The
   * {@link FeedbackStore} rows referenced by those logs are removed
   * automatically by the FK cascade declared in the migration.
   */
  async pruneExpiredLogs(now: Date = this.now()): Promise<number> {
    const cutoff = retentionCutoff(now);
    return this.queryLogStore.pruneOlderThan(cutoff);
  }

  /**
   * Re-run the helpfulness check on demand. Useful for the admin
   * dashboard, which surfaces the live snapshot regardless of whether
   * any new ratings just arrived.
   */
  async helpfulnessSnapshot(): Promise<HelpfulnessSnapshot> {
    return this.helpfulnessMonitor.snapshot();
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private previousUtcDay(): Date {
    const now = this.now();
    const today = truncateToUtcDay(now);
    return new Date(today.getTime() - 24 * 60 * 60 * 1000);
  }
}

// ─── Free helpers (exported so the worker layer can reuse them) ──────────────

/**
 * Default expected-scheme resolver: derive ground truth from the
 * citizen's own rating.
 *
 * - `helpful`   ⇒ the cited schemes count as relevant (the citizen
 *                 confirmed the answer was useful).
 * - `unhelpful` ⇒ the expected set is empty (the cited schemes are
 *                 treated as irrelevant; precision drops, recall is
 *                 vacuous and skipped by the aggregator).
 * - unrated     ⇒ `null` (skip — we have no ground truth).
 *
 * If a single trace carries multiple feedback rows (re-rating), the
 * most-recent row wins.
 */
export function defaultExpectedSchemeResolver(
  log: AIQueryLog,
  feedback: ReadonlyArray<AIQueryFeedback>,
): ReadonlyArray<string> | null {
  if (feedback.length === 0) return null;
  // FeedbackStore.list returns newest-first.
  const latest = feedback[0];
  if (latest.rating === 'helpful') {
    return uniqueSchemeIds(log.retrievedChunks);
  }
  // unhelpful — none of the cited schemes are relevant.
  return [];
}

function toLoggedChunks(
  chunks: ReadonlyArray<RetrievedChunk>,
): LoggedRetrievedChunk[] {
  const out: LoggedRetrievedChunk[] = [];
  for (const c of chunks) {
    out.push({
      schemeId: c.schemeId,
      chunkText: c.chunkText,
      chunkIndex: c.chunkIndex,
      similarity: c.similarity,
    });
  }
  return out;
}

function copySources(sources: ReadonlyArray<SourceCitation>): SourceCitation[] {
  return sources.map((s) => ({ ...s }));
}

function uniqueSchemeIds(
  chunks: ReadonlyArray<{ schemeId: string }>,
): string[] {
  const seen = new Set<string>();
  for (const c of chunks) seen.add(c.schemeId);
  return Array.from(seen);
}

// ─── perf timer (re-export keeps the API surface small) ─────────────────────

/**
 * Returns an elapsed-millisecond duration since `start`. Convenience
 * wrapper around `performance.now()` so callers that already imported
 * the observability surface don't have to reach into `node:perf_hooks`
 * directly.
 */
export function elapsedSince(start: number): number {
  return performance.now() - start;
}

export type {
  AIQueryFeedback,
  AIQueryLog,
  DailyRagMetrics,
  EvaluationRunSummary,
  EvaluationTestCase,
  FeedbackRating,
  HelpfulnessSnapshot,
  LoggedRetrievedChunk,
  Span,
  SupportedLanguage,
  AdminAlertSink,
};
