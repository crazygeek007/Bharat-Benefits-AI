/**
 * RAG quality metrics — daily precision and recall (Req 21.2).
 *
 * Definitions (set-based, scheme-id level):
 *   - **precision** = |retrieved ∩ expected| / |retrieved|
 *   - **recall**    = |retrieved ∩ expected| / |expected|
 *
 * Both are computed at the scheme level (deduplicated) rather than
 * chunk level. Expected sets come from either:
 *   1. The curated evaluation test set (Req 21.6), or
 *   2. Citizen-supplied "helpful / unhelpful" feedback aggregated per
 *      logged query — `helpful` ⇒ the cited schemes are counted as
 *      relevant; `unhelpful` ⇒ they are counted as irrelevant.
 *
 * The functions in this module are pure so they can be unit-tested
 * without a database; the orchestration layer in observability-service
 * supplies the inputs.
 */

import type { DailyRagMetrics, EvaluationCaseResult } from './types';

/** Set-based precision computation. Returns `0` when retrieved is empty. */
export function precision(
  retrieved: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
): number {
  const retrievedSet = new Set(retrieved);
  if (retrievedSet.size === 0) return 0;
  const expectedSet = new Set(expected);
  let hits = 0;
  for (const id of retrievedSet) {
    if (expectedSet.has(id)) hits += 1;
  }
  return hits / retrievedSet.size;
}

/** Set-based recall computation. Returns `1` when expected is empty. */
export function recall(
  retrieved: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
): number {
  const expectedSet = new Set(expected);
  if (expectedSet.size === 0) {
    // Convention: when no relevant items exist, perfect recall is
    // vacuously true. Caller-side filtering decides whether to count
    // these vacuous records when averaging.
    return 1;
  }
  const retrievedSet = new Set(retrieved);
  let hits = 0;
  for (const id of expectedSet) {
    if (retrievedSet.has(id)) hits += 1;
  }
  return hits / expectedSet.size;
}

/** Mean of an array of numbers, returning `0` for an empty input. */
export function mean(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// ─── Aggregation helpers ─────────────────────────────────────────────────────

/**
 * Aggregate the per-case results from an evaluation run into a single
 * {@link DailyRagMetrics} record. Used by the weekly evaluation runner
 * to also feed Req 21.2's daily precision / recall plot.
 */
export function aggregateEvaluationResults(
  date: Date,
  cases: ReadonlyArray<EvaluationCaseResult>,
): DailyRagMetrics {
  return {
    date: truncateToUtcDay(date),
    ratedResponses: cases.length,
    precision: mean(cases.map((c) => c.precision)),
    recall: mean(cases.map((c) => c.recall)),
  };
}

/**
 * Aggregate per-query observations (one row per {@link AIQueryLog} that
 * was rated by a citizen) into a daily metrics record.
 */
export interface RatedQueryObservation {
  retrievedSchemeIds: ReadonlyArray<string>;
  expectedSchemeIds: ReadonlyArray<string>;
}

export function aggregateRatedQueries(
  date: Date,
  observations: ReadonlyArray<RatedQueryObservation>,
): DailyRagMetrics {
  const precisions = observations.map((o) =>
    precision(o.retrievedSchemeIds, o.expectedSchemeIds),
  );
  // Skip observations where `expected` is empty when computing recall —
  // they would otherwise inflate the average with vacuous 1.0 values.
  const recallEligible = observations.filter((o) => o.expectedSchemeIds.length > 0);
  const recalls = recallEligible.map((o) =>
    recall(o.retrievedSchemeIds, o.expectedSchemeIds),
  );
  return {
    date: truncateToUtcDay(date),
    ratedResponses: observations.length,
    precision: mean(precisions),
    recall: mean(recalls),
  };
}

/** Truncate `date` to the start of its UTC day. */
export function truncateToUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}
