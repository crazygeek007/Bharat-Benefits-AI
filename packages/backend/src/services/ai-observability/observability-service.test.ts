/**
 * Unit tests for the {@link ObservabilityService} orchestration layer
 * (Req 21.1, 21.2, 21.3, 21.4, 21.6, 21.7).
 *
 * These tests pin down the contract the worker layer relies on:
 *   - Persisting an exchange tags slow rows as `degraded` and fires
 *     the degraded sink (Req 21.7).
 *   - Recording feedback re-evaluates the helpfulness window so a
 *     drop below 80/100 triggers an alert (Req 21.4).
 *   - Daily metric aggregation skips unrated logs and uses the
 *     citizen's rating as ground truth (Req 21.2).
 *   - The weekly evaluation cadence is honoured by
 *     `shouldRunWeeklyEvaluation`.
 *   - The retention sweep removes rows older than 90 days (Req 21.1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type {
  AssistantResponse,
  RetrievedChunk,
  SourceCitation,
} from '@bharat-benefits/shared';

import {
  DEGRADED_TRACE_THRESHOLD_MS,
  EVALUATION_RUN_CADENCE_DAYS,
  HELPFULNESS_ALERT_THRESHOLD,
  HELPFULNESS_ROLLING_WINDOW,
  QUERY_LOG_RETENTION_MS,
} from './constants';
import {
  HelpfulnessMonitor,
  type AdminAlertSink,
} from './helpfulness-monitor';
import { InMemoryAIQueryLogStore } from './query-log-store';
import { InMemoryFeedbackStore } from './feedback-store';
import { InMemoryEvaluationRunStore } from './evaluation-run-store';
import {
  ObservabilityService,
  type AssistantExchange,
  type DegradedQuerySink,
} from './observability-service';
import type {
  AssistantUnderTest,
} from './evaluation-runner';
import type { EvaluationTestCase } from './types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SOURCES: SourceCitation[] = [
  {
    schemeId: 'scheme-1',
    schemeName: 'PM Kisan',
    sourceUrl: 'https://pmkisan.gov.in/',
    lastUpdated: new Date('2024-01-15T00:00:00Z'),
  },
];

const CHUNKS: RetrievedChunk[] = [
  {
    schemeId: 'scheme-1',
    chunkText: 'Eligibility…',
    chunkIndex: 0,
    similarity: 0.91,
  },
  {
    schemeId: 'scheme-2',
    chunkText: 'Benefits…',
    chunkIndex: 0,
    similarity: 0.84,
  },
];

const RESPONSE: AssistantResponse = {
  answer: 'Apply on pmkisan.gov.in.',
  sources: SOURCES,
  language: 'en',
  traceId: 'trace-1',
};

function makeExchange(overrides: Partial<AssistantExchange> = {}): AssistantExchange {
  return {
    traceId: overrides.traceId ?? 'trace-1',
    sessionId: overrides.sessionId ?? 'session-1',
    userId: overrides.userId ?? 'user-1',
    query: overrides.query ?? 'How do I apply for PM Kisan?',
    response: overrides.response ?? RESPONSE,
    retrievedChunks: overrides.retrievedChunks ?? CHUNKS,
    durationMs: overrides.durationMs ?? 1234,
    createdAt: overrides.createdAt,
  };
}

interface Harness {
  service: ObservabilityService;
  queryLogStore: InMemoryAIQueryLogStore;
  feedbackStore: InMemoryFeedbackStore;
  evaluationRunStore: InMemoryEvaluationRunStore;
  // Use the typed Mock signature so the harness preserves the sink
  // contracts. `ReturnType<typeof vi.fn>` collapses to
  // `Mock<any[], unknown>` and breaks assignability against the
  // strongly-typed values produced by `vi.fn<Parameters, Return>()`.
  alertSink: import('vitest').Mock<Parameters<AdminAlertSink>, ReturnType<AdminAlertSink>>;
  degradedSink: import('vitest').Mock<Parameters<DegradedQuerySink>, ReturnType<DegradedQuerySink>>;
}

function makeHarness(options: {
  now?: () => Date;
  degradedThresholdMs?: number;
} = {}): Harness {
  const queryLogStore = new InMemoryAIQueryLogStore();
  const feedbackStore = new InMemoryFeedbackStore();
  const evaluationRunStore = new InMemoryEvaluationRunStore();
  const alertSink = vi.fn<Parameters<AdminAlertSink>, ReturnType<AdminAlertSink>>();
  const degradedSink = vi.fn<Parameters<DegradedQuerySink>, ReturnType<DegradedQuerySink>>();
  const helpfulnessMonitor = new HelpfulnessMonitor(feedbackStore, alertSink);
  const service = new ObservabilityService(
    {
      queryLogStore,
      feedbackStore,
      helpfulnessMonitor,
      evaluationRunStore,
    },
    {
      degradedQuerySink: degradedSink,
      degradedThresholdMs: options.degradedThresholdMs,
      now: options.now,
    },
  );
  return { service, queryLogStore, feedbackStore, evaluationRunStore, alertSink, degradedSink };
}

// ─── Constructor validation ──────────────────────────────────────────────────

describe('ObservabilityService — construction', () => {
  it('rejects missing query log store', () => {
    expect(
      () =>
        new ObservabilityService({
          queryLogStore: undefined as unknown as InMemoryAIQueryLogStore,
          feedbackStore: new InMemoryFeedbackStore(),
          helpfulnessMonitor: new HelpfulnessMonitor(new InMemoryFeedbackStore()),
          evaluationRunStore: new InMemoryEvaluationRunStore(),
        }),
    ).toThrow(/queryLogStore/);
  });

  it('rejects missing feedback store', () => {
    expect(
      () =>
        new ObservabilityService({
          queryLogStore: new InMemoryAIQueryLogStore(),
          feedbackStore: undefined as unknown as InMemoryFeedbackStore,
          helpfulnessMonitor: new HelpfulnessMonitor(new InMemoryFeedbackStore()),
          evaluationRunStore: new InMemoryEvaluationRunStore(),
        }),
    ).toThrow(/feedbackStore/);
  });

  it('rejects missing helpfulness monitor', () => {
    expect(
      () =>
        new ObservabilityService({
          queryLogStore: new InMemoryAIQueryLogStore(),
          feedbackStore: new InMemoryFeedbackStore(),
          helpfulnessMonitor: undefined as unknown as HelpfulnessMonitor,
          evaluationRunStore: new InMemoryEvaluationRunStore(),
        }),
    ).toThrow(/helpfulnessMonitor/);
  });

  it('rejects missing evaluation run store', () => {
    expect(
      () =>
        new ObservabilityService({
          queryLogStore: new InMemoryAIQueryLogStore(),
          feedbackStore: new InMemoryFeedbackStore(),
          helpfulnessMonitor: new HelpfulnessMonitor(new InMemoryFeedbackStore()),
          evaluationRunStore: undefined as unknown as InMemoryEvaluationRunStore,
        }),
    ).toThrow(/evaluationRunStore/);
  });
});

// ─── recordAssistantQuery ────────────────────────────────────────────────────

describe('ObservabilityService.recordAssistantQuery (Req 21.1, 21.5, 21.7)', () => {
  it('persists the exchange with the correct fields', async () => {
    const harness = makeHarness();
    const log = await harness.service.recordAssistantQuery(makeExchange());

    expect(log.id).toBeTruthy();
    expect(log.traceId).toBe('trace-1');
    expect(log.sessionId).toBe('session-1');
    expect(log.userId).toBe('user-1');
    expect(log.query).toBe('How do I apply for PM Kisan?');
    expect(log.response).toBe('Apply on pmkisan.gov.in.');
    expect(log.language).toBe('en');
    expect(log.retrievedChunks).toHaveLength(2);
    expect(log.retrievedChunks[0]).toMatchObject({ schemeId: 'scheme-1', chunkIndex: 0 });
    expect(log.sources).toEqual(SOURCES);
    expect(log.degraded).toBe(false);

    // Round-trips through the store.
    const fromStore = await harness.queryLogStore.findByTraceId('trace-1');
    expect(fromStore).not.toBeNull();
    expect(fromStore?.id).toBe(log.id);
  });

  it('flags degraded traces and fires the degraded sink (Req 21.7)', async () => {
    const harness = makeHarness();
    const log = await harness.service.recordAssistantQuery(
      makeExchange({ traceId: 'slow-trace', durationMs: DEGRADED_TRACE_THRESHOLD_MS + 1 }),
    );
    expect(log.degraded).toBe(true);

    // Sink fires asynchronously — wait a microtask.
    await new Promise((r) => setImmediate(r));
    expect(harness.degradedSink).toHaveBeenCalledTimes(1);
    expect(harness.degradedSink).toHaveBeenCalledWith(expect.objectContaining({
      traceId: 'slow-trace',
      degraded: true,
    }));
  });

  it('does NOT flag traces at or below the threshold (Req 21.7)', async () => {
    const harness = makeHarness();
    const log = await harness.service.recordAssistantQuery(
      makeExchange({ traceId: 'fast-trace', durationMs: DEGRADED_TRACE_THRESHOLD_MS }),
    );
    expect(log.degraded).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(harness.degradedSink).not.toHaveBeenCalled();
  });

  it('rejects malformed inputs', async () => {
    const harness = makeHarness();
    await expect(
      harness.service.recordAssistantQuery(makeExchange({ traceId: '' })),
    ).rejects.toThrow(/traceId/);
    await expect(
      harness.service.recordAssistantQuery(makeExchange({ sessionId: '' })),
    ).rejects.toThrow(/sessionId/);
    await expect(
      harness.service.recordAssistantQuery(makeExchange({ query: '' })),
    ).rejects.toThrow(/query/);
    await expect(
      harness.service.recordAssistantQuery(makeExchange({ durationMs: -1 })),
    ).rejects.toThrow(/durationMs/);
    await expect(
      harness.service.recordAssistantQuery(
        makeExchange({ durationMs: Number.NaN }),
      ),
    ).rejects.toThrow(/durationMs/);
  });
});

// ─── recordFeedback / helpfulness alerting ───────────────────────────────────

describe('ObservabilityService.recordFeedback (Req 21.3, 21.4)', () => {
  it('persists the rating and returns the live snapshot', async () => {
    const harness = makeHarness();
    const { feedback, helpfulness } = await harness.service.recordFeedback({
      traceId: 'trace-1',
      userId: 'user-1',
      rating: 'helpful',
    });
    expect(feedback.traceId).toBe('trace-1');
    expect(feedback.rating).toBe('helpful');
    expect(helpfulness.ratedResponses).toBe(1);
    expect(helpfulness.helpfulCount).toBe(1);
    expect(helpfulness.shouldAlert).toBe(false); // window not full yet
  });

  it('rejects invalid rating values', async () => {
    const harness = makeHarness();
    await expect(
      harness.service.recordFeedback({
        traceId: 'trace-1',
        userId: 'user-1',
        // @ts-expect-error — testing runtime guard
        rating: 'meh',
      }),
    ).rejects.toThrow(/rating/);
  });

  it('rejects missing traceId', async () => {
    const harness = makeHarness();
    await expect(
      harness.service.recordFeedback({
        traceId: '',
        userId: 'user-1',
        rating: 'helpful',
      }),
    ).rejects.toThrow(/traceId/);
  });

  it('fires the admin alert when the rolling window dips below threshold (Req 21.4)', async () => {
    const harness = makeHarness();
    // Fill the window with exactly THRESHOLD - 1 helpful and the
    // remainder unhelpful — this is the "alert" half of the iff.
    const helpfulCount = HELPFULNESS_ALERT_THRESHOLD - 1;
    for (let i = 0; i < HELPFULNESS_ROLLING_WINDOW; i += 1) {
      await harness.service.recordFeedback({
        traceId: `trace-${i}`,
        userId: `user-${i}`,
        rating: i < helpfulCount ? 'helpful' : 'unhelpful',
      });
    }

    // The final call should have observed the full window and fired
    // the alert sink.
    expect(harness.alertSink).toHaveBeenCalled();
    const lastCall = harness.alertSink.mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({
      ratedResponses: HELPFULNESS_ROLLING_WINDOW,
      helpfulCount,
      threshold: HELPFULNESS_ALERT_THRESHOLD,
      windowSize: HELPFULNESS_ROLLING_WINDOW,
    });
  });

  it('does NOT fire when the rolling window has ≥ THRESHOLD helpful ratings (Req 21.4)', async () => {
    const harness = makeHarness();
    for (let i = 0; i < HELPFULNESS_ROLLING_WINDOW; i += 1) {
      await harness.service.recordFeedback({
        traceId: `trace-${i}`,
        userId: `user-${i}`,
        rating: i < HELPFULNESS_ALERT_THRESHOLD ? 'helpful' : 'unhelpful',
      });
    }
    expect(harness.alertSink).not.toHaveBeenCalled();
  });
});

// ─── aggregateDailyMetrics ───────────────────────────────────────────────────

describe('ObservabilityService.aggregateDailyMetrics (Req 21.2)', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('returns zero-valued metrics when no logs exist for the day', async () => {
    const metrics = await harness.service.aggregateDailyMetrics({
      date: new Date('2024-03-15T00:00:00Z'),
    });
    expect(metrics.ratedResponses).toBe(0);
    expect(metrics.precision).toBe(0);
    expect(metrics.recall).toBe(0);
    expect(metrics.date.toISOString()).toBe('2024-03-15T00:00:00.000Z');
  });

  it('skips unrated logs (no feedback ⇒ no ground truth)', async () => {
    const day = new Date('2024-03-15T12:00:00Z');
    await harness.service.recordAssistantQuery(
      makeExchange({ createdAt: day }),
    );
    const metrics = await harness.service.aggregateDailyMetrics({ date: day });
    // No feedback means we have no expected set — observation skipped,
    // ratedResponses stays at 0.
    expect(metrics.ratedResponses).toBe(0);
  });

  it('treats helpful feedback as confirmation (precision = 1)', async () => {
    const day = new Date('2024-03-15T12:00:00Z');
    await harness.service.recordAssistantQuery(
      makeExchange({ traceId: 't-good', createdAt: day }),
    );
    await harness.service.recordFeedback({
      traceId: 't-good',
      userId: 'user-1',
      rating: 'helpful',
    });

    const metrics = await harness.service.aggregateDailyMetrics({ date: day });
    expect(metrics.ratedResponses).toBe(1);
    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(1);
  });

  it('treats unhelpful feedback as zero-relevant (precision = 0)', async () => {
    const day = new Date('2024-03-15T12:00:00Z');
    await harness.service.recordAssistantQuery(
      makeExchange({ traceId: 't-bad', createdAt: day }),
    );
    await harness.service.recordFeedback({
      traceId: 't-bad',
      userId: 'user-1',
      rating: 'unhelpful',
    });

    const metrics = await harness.service.aggregateDailyMetrics({ date: day });
    expect(metrics.ratedResponses).toBe(1);
    expect(metrics.precision).toBe(0);
    // Expected set is empty when unhelpful ⇒ recall observation is
    // vacuous and skipped from the average. Mean of zero values is 0.
    expect(metrics.recall).toBe(0);
  });

  it('honours custom expectedSchemeResolver', async () => {
    const day = new Date('2024-03-15T12:00:00Z');
    const customStore = new InMemoryAIQueryLogStore();
    const customFeedback = new InMemoryFeedbackStore();
    const monitor = new HelpfulnessMonitor(customFeedback);
    const evalStore = new InMemoryEvaluationRunStore();
    const service = new ObservabilityService({
      queryLogStore: customStore,
      feedbackStore: customFeedback,
      helpfulnessMonitor: monitor,
      evaluationRunStore: evalStore,
      // Override: every log gets a fixed expected set.
      expectedSchemeResolver: () => ['scheme-1', 'scheme-3'],
    });

    await service.recordAssistantQuery(makeExchange({ createdAt: day }));
    const metrics = await service.aggregateDailyMetrics({ date: day });
    expect(metrics.ratedResponses).toBe(1);
    // Retrieved {scheme-1, scheme-2}; expected {scheme-1, scheme-3}.
    // Precision = 1 / 2; recall = 1 / 2.
    expect(metrics.precision).toBeCloseTo(0.5, 6);
    expect(metrics.recall).toBeCloseTo(0.5, 6);
  });

  it('defaults to aggregating the previous UTC day', async () => {
    const fixedNow = new Date('2024-03-16T03:00:00Z');
    const harnessWithClock = makeHarness({ now: () => fixedNow });
    const yesterday = new Date('2024-03-15T18:00:00Z');
    await harnessWithClock.service.recordAssistantQuery(
      makeExchange({ traceId: 't-y', createdAt: yesterday }),
    );
    await harnessWithClock.service.recordFeedback({
      traceId: 't-y',
      userId: 'user-1',
      rating: 'helpful',
    });

    const metrics = await harnessWithClock.service.aggregateDailyMetrics();
    expect(metrics.date.toISOString()).toBe('2024-03-15T00:00:00.000Z');
    expect(metrics.ratedResponses).toBe(1);
  });
});

// ─── runWeeklyEvaluation / cadence ───────────────────────────────────────────

describe('ObservabilityService weekly evaluation (Req 21.6)', () => {
  /**
   * Generate a deterministic test set of `count` cases keyed off
   * `scheme-N`. Each case expects the assistant to cite that scheme.
   */
  function makeTestSet(count: number): EvaluationTestCase[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `case-${i}`,
      query: `Query ${i}`,
      expectedSchemeIds: [`scheme-${i}`],
    }));
  }

  function makePerfectAssistant(): AssistantUnderTest {
    return {
      async answerQuery(query: string) {
        // Treat everything as case-i to make precision/recall = 1.
        const match = query.match(/^Query (\d+)$/);
        const idx = match ? Number(match[1]) : 0;
        return {
          answer: `Answer ${idx}`,
          sources: [
            {
              schemeId: `scheme-${idx}`,
              schemeName: `Scheme ${idx}`,
              sourceUrl: 'https://example.gov.in/',
              lastUpdated: new Date('2024-01-01T00:00:00Z'),
            },
          ],
          language: 'en',
          traceId: `trace-${idx}`,
        };
      },
    };
  }

  it('runs the evaluation and persists the summary', async () => {
    const harness = makeHarness();
    const summary = await harness.service.runWeeklyEvaluation({
      assistant: makePerfectAssistant(),
      testCases: makeTestSet(10),
      runnerOptions: { minTestSetSize: 10 },
    });
    expect(summary.totalCases).toBe(10);
    expect(summary.precision).toBe(1);
    expect(summary.recall).toBe(1);
    expect(summary.answerCorrectCount).toBe(10);

    const stored = await harness.evaluationRunStore.findById(summary.runId);
    expect(stored).not.toBeNull();
    expect(stored?.totalCases).toBe(10);
  });

  it('shouldRunWeeklyEvaluation returns true when no run exists', async () => {
    const harness = makeHarness();
    expect(await harness.service.shouldRunWeeklyEvaluation()).toBe(true);
  });

  it('shouldRunWeeklyEvaluation returns false within the cadence window', async () => {
    const fixedNow = new Date('2024-03-15T00:00:00Z');
    const harness = makeHarness({ now: () => fixedNow });
    // Persist a run that started 1 day ago.
    await harness.evaluationRunStore.save({
      runId: 'r-1',
      startedAt: new Date(fixedNow.getTime() - 24 * 60 * 60 * 1000),
      finishedAt: new Date(fixedNow.getTime() - 23 * 60 * 60 * 1000),
      totalCases: 50,
      precision: 0.9,
      recall: 0.9,
      answerCorrectCount: 45,
      results: [],
    });
    expect(await harness.service.shouldRunWeeklyEvaluation()).toBe(false);
  });

  it('shouldRunWeeklyEvaluation returns true after the cadence window', async () => {
    const fixedNow = new Date('2024-03-15T00:00:00Z');
    const harness = makeHarness({ now: () => fixedNow });
    const cadenceMs = EVALUATION_RUN_CADENCE_DAYS * 24 * 60 * 60 * 1000;
    await harness.evaluationRunStore.save({
      runId: 'r-1',
      startedAt: new Date(fixedNow.getTime() - cadenceMs - 1000),
      finishedAt: new Date(fixedNow.getTime() - cadenceMs),
      totalCases: 50,
      precision: 0.9,
      recall: 0.9,
      answerCorrectCount: 45,
      results: [],
    });
    expect(await harness.service.shouldRunWeeklyEvaluation()).toBe(true);
  });

  it('rejects an under-sized test set (Req 21.6 — at least 50 cases)', async () => {
    const harness = makeHarness();
    await expect(
      harness.service.runWeeklyEvaluation({
        assistant: makePerfectAssistant(),
        testCases: makeTestSet(10),
        // No override — defaults to MIN_EVALUATION_TEST_SET_SIZE = 50.
      }),
    ).rejects.toThrow(/at least 50 test cases/);
  });
});

// ─── pruneExpiredLogs ────────────────────────────────────────────────────────

describe('ObservabilityService.pruneExpiredLogs (Req 21.1)', () => {
  it('removes rows older than 90 days and keeps the rest', async () => {
    const fixedNow = new Date('2024-06-01T00:00:00Z');
    const harness = makeHarness({ now: () => fixedNow });
    const cutoffMs = fixedNow.getTime() - QUERY_LOG_RETENTION_MS;

    await harness.service.recordAssistantQuery(
      makeExchange({
        traceId: 'old-trace',
        createdAt: new Date(cutoffMs - 60 * 1000), // older than retention
      }),
    );
    await harness.service.recordAssistantQuery(
      makeExchange({
        traceId: 'fresh-trace',
        createdAt: new Date(fixedNow.getTime() - 60 * 1000),
      }),
    );
    expect(harness.queryLogStore.size).toBe(2);

    const pruned = await harness.service.pruneExpiredLogs();
    expect(pruned).toBe(1);
    expect(harness.queryLogStore.size).toBe(1);
    const fresh = await harness.queryLogStore.findByTraceId('fresh-trace');
    expect(fresh).not.toBeNull();
    const old = await harness.queryLogStore.findByTraceId('old-trace');
    expect(old).toBeNull();
  });

  it('returns 0 when the store is empty', async () => {
    const harness = makeHarness();
    expect(await harness.service.pruneExpiredLogs()).toBe(0);
  });
});

// ─── Tracer surface ──────────────────────────────────────────────────────────

describe('ObservabilityService tracing surface (Req 21.5, 21.7)', () => {
  it('exposes the configured tracer via .tracing', () => {
    const harness = makeHarness();
    expect(harness.service.tracing).toBeDefined();
  });

  it('startQuerySpan returns a span with a trace id', () => {
    const harness = makeHarness();
    const span = harness.service.startQuerySpan('scheme-assistant.answerQuery');
    expect(span.traceId).toMatch(/.+/);
    expect(span.parentSpanId).toBeNull();
    const finished = span.end();
    expect(finished.traceId).toBe(span.traceId);
    expect(finished.degraded).toBe(false);
  });
});
