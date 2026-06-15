/**
 * AI Observability subsystem — public surface (Req 21).
 *
 * The platform's tracing, query logging, feedback, helpfulness
 * monitoring, and weekly evaluation primitives are all wired through
 * the {@link ObservabilityService}. Consumers should import from this
 * module rather than reaching into individual files so the internal
 * structure can be reorganised without ripple-effect changes.
 */

export {
  // Tunables (Req 21.1, 21.4, 21.6, 21.7).
  DEGRADED_TRACE_THRESHOLD_MS,
  EVALUATION_RUN_CADENCE_DAYS,
  HELPFULNESS_ALERT_THRESHOLD,
  HELPFULNESS_ROLLING_WINDOW,
  MIN_EVALUATION_TEST_SET_SIZE,
  QUERY_LOG_RETENTION_DAYS,
  QUERY_LOG_RETENTION_MS,
} from './constants';

export {
  EvaluationRunner,
  type AssistantUnderTest,
  type EvaluationRunnerOptions,
} from './evaluation-runner';

export {
  InMemoryEvaluationRunStore,
  PrismaEvaluationRunStore,
  type EvaluationRunPrismaClient,
  type EvaluationRunStore,
  type ListEvaluationRunsFilter,
} from './evaluation-run-store';

export {
  InMemoryFeedbackStore,
  PrismaFeedbackStore,
  type FeedbackPrismaClient,
  type FeedbackStore,
  type ListFeedbackFilter,
  type RecordFeedbackInput,
} from './feedback-store';

export {
  HelpfulnessMonitor,
  computeSnapshot,
  type AdminAlertSink,
  type HelpfulnessMonitorOptions,
  type HelpfulnessSnapshot,
} from './helpfulness-monitor';

export {
  defaultExpectedSchemeResolver,
  elapsedSince,
  ObservabilityService,
  type AggregateDailyMetricsOptions,
  type AssistantExchange,
  type DegradedQuerySink,
  type ExpectedSchemeResolver,
  type ObservabilityServiceDeps,
  type ObservabilityServiceOptions,
} from './observability-service';

export {
  InMemoryAIQueryLogStore,
  PrismaAIQueryLogStore,
  retentionCutoff,
  type AIQueryLogPrismaClient,
  type AIQueryLogStore,
  type ListLogsFilter,
} from './query-log-store';

export {
  aggregateEvaluationResults,
  aggregateRatedQueries,
  mean,
  precision,
  recall,
  truncateToUtcDay,
  type RatedQueryObservation,
} from './rag-metrics';

export {
  isDegradedDuration,
  Tracer,
  type DegradedTraceSink,
  type Span,
  type SpanExporter,
  type SpanStatus,
  type TracerOptions,
} from './tracing';

export type {
  AIQueryFeedback,
  AIQueryLog,
  DailyRagMetrics,
  EvaluationCaseResult,
  EvaluationRunSummary,
  EvaluationTestCase,
  FeedbackRating,
  FinishedSpan,
  LoggedRetrievedChunk,
} from './types';
