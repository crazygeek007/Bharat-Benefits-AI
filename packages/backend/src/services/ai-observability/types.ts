/**
 * Shared types for the AI observability subsystem.
 *
 * All persistence-facing types are pure data so they can be serialised
 * to JSON, replayed in evaluation runs, and stored in either Postgres
 * or an in-memory test store without coupling to Prisma's generated
 * model classes.
 */

import type { SourceCitation, SupportedLanguage } from '@bharat-benefits/shared';

// ─── Logged Scheme_Assistant exchanges (Req 21.1) ────────────────────────────

/**
 * Snapshot of a single retrieved RAG chunk persisted with the query log.
 *
 * Stored verbatim so future evaluation runs can recompute precision and
 * recall without re-querying the vector index (Req 21.2). The chunk
 * text is bounded by the assistant's retrieval pipeline and we store it
 * unmodified; pruning happens during the 90-day retention sweep.
 */
export interface LoggedRetrievedChunk {
  /** Scheme the chunk belongs to. */
  schemeId: string;
  /** Raw chunk text shown to the LLM. */
  chunkText: string;
  /** Position of the chunk inside its parent scheme document. */
  chunkIndex: number;
  /** Cosine similarity reported by the vector index. */
  similarity: number;
}

/**
 * Persisted record for a single Scheme_Assistant query. One row per
 * answered query so feedback, ratings, and trace metadata can join
 * back via {@link AIQueryLog.traceId}.
 *
 * Validates: Requirements 21.1, 21.5.
 */
export interface AIQueryLog {
  /** Unique identifier for the persisted log row. */
  id: string;
  /**
   * Distributed-trace id propagated from the assistant. Stable across
   * the request, the eligibility / retrieval / response agents, and
   * any downstream observability records (Req 21.5).
   */
  traceId: string;
  /** Conversation / session id so multi-turn exchanges can be reconstructed. */
  sessionId: string;
  /** Authenticated user id, when the request carried one. */
  userId: string | null;
  /** Citizen's raw query string. */
  query: string;
  /** Assistant's final answer. */
  response: string;
  /** Top-K chunks retrieved from the vector DB for this query. */
  retrievedChunks: LoggedRetrievedChunk[];
  /** Citations attached to the assistant's response. */
  sources: SourceCitation[];
  /** Language the response was generated in. */
  language: SupportedLanguage;
  /** Wall-clock duration of the assistant pipeline in milliseconds. */
  durationMs: number;
  /**
   * `true` when {@link durationMs} exceeds the degradation threshold
   * (Req 21.7). Persisted so dashboards do not need to recompute the
   * rule per query.
   */
  degraded: boolean;
  /** When the query was answered. */
  createdAt: Date;
}

// ─── Feedback (Req 21.3, 21.4) ───────────────────────────────────────────────

/** Citizen rating for an individual response. */
export type FeedbackRating = 'helpful' | 'unhelpful';

/**
 * Feedback record attached to a previously-logged query via traceId.
 *
 * Validates: Requirements 21.3.
 */
export interface AIQueryFeedback {
  id: string;
  /** Trace id of the rated response (joins to {@link AIQueryLog.traceId}). */
  traceId: string;
  /** User who submitted the rating. May be null for anonymous sessions. */
  userId: string | null;
  rating: FeedbackRating;
  /** Optional free-text comment from the citizen. */
  comment: string | null;
  createdAt: Date;
}

// ─── Daily RAG metrics (Req 21.2) ────────────────────────────────────────────

/**
 * Daily-rolled-up RAG quality metrics. Stored once per UTC day so the
 * admin dashboard can plot the historical curve cheaply.
 *
 * Validates: Requirements 21.2.
 */
export interface DailyRagMetrics {
  /** UTC date (truncated to midnight) the metrics describe. */
  date: Date;
  /** Number of rated responses considered for the day. */
  ratedResponses: number;
  /** Mean precision across the rated responses (range [0, 1]). */
  precision: number;
  /** Mean recall across the rated responses (range [0, 1]). */
  recall: number;
}

// ─── Evaluation runs (Req 21.6) ──────────────────────────────────────────────

/** A single QA pair from the curated evaluation test set. */
export interface EvaluationTestCase {
  /** Stable identifier so we can correlate runs over time. */
  id: string;
  query: string;
  /**
   * Identifiers of the schemes the assistant SHOULD cite. Used as the
   * ground-truth set when computing precision / recall.
   */
  expectedSchemeIds: string[];
  /**
   * Optional substrings that MUST appear in the assistant's answer.
   * Provides a coarse correctness signal without needing an LLM judge.
   */
  expectedAnswerContains?: string[];
}

/** Per-test-case outcome from an evaluation run. */
export interface EvaluationCaseResult {
  testCaseId: string;
  query: string;
  expectedSchemeIds: string[];
  retrievedSchemeIds: string[];
  /** Precision over retrieved scheme ids. */
  precision: number;
  /** Recall over retrieved scheme ids. */
  recall: number;
  /**
   * Whether every required substring (when configured) was present in
   * the assistant's answer.
   */
  answerContainsExpected: boolean;
  durationMs: number;
  traceId: string;
}

/**
 * Aggregated result of running the full evaluation set.
 *
 * Validates: Requirements 21.6.
 */
export interface EvaluationRunSummary {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  totalCases: number;
  /**
   * Mean precision across every test case. `0` when the test set is
   * empty so consumers don't have to special-case `NaN`.
   */
  precision: number;
  /** Mean recall across every test case. */
  recall: number;
  /**
   * Number of cases where every required answer substring was present.
   */
  answerCorrectCount: number;
  results: EvaluationCaseResult[];
}

// ─── Tracing (Req 21.5, 21.7) ────────────────────────────────────────────────

/**
 * Snapshot of a finished span. Compatible with the OpenTelemetry data
 * model so production wiring can swap in the official SDK without
 * touching consumers.
 */
export interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  attributes: Record<string, string | number | boolean>;
  status: 'ok' | 'error';
  errorMessage: string | null;
  /**
   * `true` when {@link durationMs} > {@link DEGRADED_TRACE_THRESHOLD_MS}.
   * Validates: Requirements 21.7.
   */
  degraded: boolean;
}
