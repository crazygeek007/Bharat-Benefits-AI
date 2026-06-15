/**
 * Tunable thresholds for the AI observability subsystem.
 *
 * Centralised here so they can be referenced by tests and by both the
 * service implementations and the admin dashboard (Requirement 21).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Retention window for {@link AIQueryLog} rows. Anything older is
 * purged by {@link AIQueryLogStore.pruneOlderThan}.
 *
 * Validates: Requirements 21.1.
 */
export const QUERY_LOG_RETENTION_DAYS = 90;

/** Same window expressed in milliseconds for date arithmetic. */
export const QUERY_LOG_RETENTION_MS = QUERY_LOG_RETENTION_DAYS * DAY_MS;

/**
 * Size of the rolling helpfulness window. The alert fires when fewer
 * than {@link HELPFULNESS_ALERT_THRESHOLD} of the most-recent
 * {@link HELPFULNESS_ROLLING_WINDOW} rated responses were rated helpful.
 *
 * Validates: Requirements 21.4.
 */
export const HELPFULNESS_ROLLING_WINDOW = 100;

/**
 * Minimum count of "helpful" ratings inside the rolling window before
 * the system stops alerting. Equivalent to "≥ 80% helpful rate" but
 * expressed as a count to avoid floating-point comparisons.
 *
 * Validates: Requirements 21.4.
 */
export const HELPFULNESS_ALERT_THRESHOLD = 80;

/**
 * Trace duration that flips a request into the "degraded" bucket.
 *
 * Validates: Requirements 21.7.
 */
export const DEGRADED_TRACE_THRESHOLD_MS = 10_000;

/**
 * Cadence of the automated evaluation run.
 *
 * Validates: Requirements 21.6.
 */
export const EVALUATION_RUN_CADENCE_DAYS = 7;

/**
 * Minimum size of the curated QA test set. Enforced on construction of
 * the evaluation runner so a misconfigured test set never silently
 * weakens the weekly check (Req 21.6).
 */
export const MIN_EVALUATION_TEST_SET_SIZE = 50;
