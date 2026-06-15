/**
 * Unit tests for the AI observability worker (Req 21.1, 21.2, 21.4, 21.6).
 *
 * The worker is a thin scheduler that strings together the
 * {@link ObservabilityService}'s methods and shape-converts logs / errors.
 * These tests verify the orchestration:
 *   - All four cycle steps run in order, and the result aggregates
 *     their outputs.
 *   - A single failed step does not abort subsequent steps — each step
 *     is wrapped in its own try/catch.
 *   - The weekly evaluation honours `shouldRunWeeklyEvaluation` so the
 *     daily cycle can wake up safely without re-running it.
 *   - When the assistant or test-set is missing but the evaluation is
 *     due, the worker emits a warning and skips rather than throwing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  EVALUATION_RUN_CADENCE_DAYS,
  HelpfulnessMonitor,
  InMemoryAIQueryLogStore,
  InMemoryEvaluationRunStore,
  InMemoryFeedbackStore,
  ObservabilityService,
} from '../services/ai-observability';
import {
  runAiObservabilityCycle,
  type AiObservabilityLogger,
} from './ai-observability.worker';
import type {
  AssistantUnderTest,
  EvaluationTestCase,
} from '../services/ai-observability';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLogger(): AiObservabilityLogger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeService(now: () => Date = () => new Date()): {
  service: ObservabilityService;
  evaluationRunStore: InMemoryEvaluationRunStore;
  queryLogStore: InMemoryAIQueryLogStore;
} {
  const queryLogStore = new InMemoryAIQueryLogStore();
  const feedbackStore = new InMemoryFeedbackStore();
  const evaluationRunStore = new InMemoryEvaluationRunStore();
  const service = new ObservabilityService(
    {
      queryLogStore,
      feedbackStore,
      helpfulnessMonitor: new HelpfulnessMonitor(feedbackStore),
      evaluationRunStore,
    },
    { now },
  );
  return { service, evaluationRunStore, queryLogStore };
}

function makeTestSet(count: number): EvaluationTestCase[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `case-${i}`,
    query: `Query ${i}`,
    expectedSchemeIds: [`scheme-${i}`],
  }));
}

function makeAssistant(): AssistantUnderTest {
  return {
    async answerQuery(query: string) {
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

// ─── Cycle smoke tests ───────────────────────────────────────────────────────

describe('runAiObservabilityCycle', () => {
  let logger: ReturnType<typeof makeLogger>;
  beforeEach(() => {
    logger = makeLogger();
  });

  it('runs every step and reports the aggregated result', async () => {
    const fixedNow = new Date('2024-04-01T00:00:00Z');
    const { service } = makeService(() => fixedNow);

    const result = await runAiObservabilityCycle({
      service,
      assistant: makeAssistant(),
      testCases: makeTestSet(10),
      logger,
      now: () => fixedNow,
    });

    expect(result.prunedLogs).toBe(0);
    expect(result.dailyMetrics.ratedResponses).toBe(0);
    expect(result.helpfulnessAlerted).toBe(false);
    // No prior evaluation ⇒ the cycle should have run one. But the
    // default test-set requires 50 cases unless we override
    // runnerOptions, which the worker can't do. Confirm the worker
    // logged a warning and skipped.
    expect(result.evaluation).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled(); // assistant + cases were provided
    expect(logger.error).toHaveBeenCalled(); // 50-case minimum failure logged
    expect(result.startedAt).toEqual(fixedNow);
    expect(result.finishedAt).toEqual(fixedNow);
  });

  it('skips weekly evaluation when not due', async () => {
    const fixedNow = new Date('2024-04-01T00:00:00Z');
    const { service, evaluationRunStore } = makeService(() => fixedNow);
    // Mark a recent evaluation so the cadence check returns false.
    await evaluationRunStore.save({
      runId: 'r-recent',
      startedAt: new Date(fixedNow.getTime() - 24 * 60 * 60 * 1000),
      finishedAt: new Date(fixedNow.getTime() - 23 * 60 * 60 * 1000),
      totalCases: 50,
      precision: 0.95,
      recall: 0.95,
      answerCorrectCount: 48,
      results: [],
    });

    const result = await runAiObservabilityCycle({
      service,
      logger,
      now: () => fixedNow,
    });
    expect(result.evaluation).toBeNull();
    // Evaluation step should have logged "not due — skipping".
    const skipLog = logger.info.mock.calls.find(([msg]) =>
      typeof msg === 'string' && msg.includes('not due'),
    );
    expect(skipLog).toBeTruthy();
  });

  it('warns and skips evaluation when due but assistant/testCases missing', async () => {
    const fixedNow = new Date('2024-04-01T00:00:00Z');
    const { service } = makeService(() => fixedNow);

    const result = await runAiObservabilityCycle({
      service,
      logger,
      now: () => fixedNow,
      // No assistant / testCases — but no prior run ⇒ evaluation is due.
    });
    expect(result.evaluation).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Weekly evaluation due'),
      expect.any(Object),
    );
  });

  it('continues running subsequent steps when one step throws', async () => {
    const fixedNow = new Date('2024-04-01T00:00:00Z');
    const { service } = makeService(() => fixedNow);

    // Force the retention sweep to throw.
    const pruneSpy = vi
      .spyOn(service, 'pruneExpiredLogs')
      .mockRejectedValueOnce(new Error('db down'));

    const result = await runAiObservabilityCycle({
      service,
      logger,
      now: () => fixedNow,
    });
    expect(pruneSpy).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Retention sweep failed',
      expect.objectContaining({ error: 'db down' }),
    );
    // dailyMetrics.aggregateDailyMetrics still ran with default values.
    expect(result.dailyMetrics).toBeDefined();
    // helpfulnessSnapshot still produced a result, so helpfulnessAlerted
    // is observable (stays false).
    expect(result.helpfulnessAlerted).toBe(false);
  });

  it('runs the weekly evaluation when forced and inputs are valid', async () => {
    const fixedNow = new Date('2024-04-01T00:00:00Z');
    const { service, evaluationRunStore } = makeService(() => fixedNow);
    // Persist a recent run so the cadence-check would normally skip.
    await evaluationRunStore.save({
      runId: 'r-recent',
      startedAt: new Date(fixedNow.getTime() - 60 * 1000),
      finishedAt: new Date(fixedNow.getTime() - 30 * 1000),
      totalCases: 50,
      precision: 0.95,
      recall: 0.95,
      answerCorrectCount: 48,
      results: [],
    });

    // We can't actually pass the 50-case minimum from the worker
    // (forceWeeklyEvaluation lets us override the cadence, not the
    // minimum), but we expose the cadence path here by giving a full
    // 50-case test set.
    const result = await runAiObservabilityCycle({
      service,
      assistant: makeAssistant(),
      testCases: makeTestSet(50),
      forceWeeklyEvaluation: true,
      logger,
      now: () => fixedNow,
    });
    expect(result.evaluation).not.toBeNull();
    expect(result.evaluation?.totalCases).toBe(50);
  });

  it('reports cadence in days when skipping evaluation', async () => {
    const fixedNow = new Date('2024-04-01T00:00:00Z');
    const { service, evaluationRunStore } = makeService(() => fixedNow);
    await evaluationRunStore.save({
      runId: 'r-recent',
      startedAt: new Date(fixedNow.getTime() - 1000),
      finishedAt: new Date(fixedNow.getTime() - 500),
      totalCases: 50,
      precision: 0.95,
      recall: 0.95,
      answerCorrectCount: 48,
      results: [],
    });
    await runAiObservabilityCycle({ service, logger, now: () => fixedNow });
    const skipLog = logger.info.mock.calls.find(([msg]) =>
      typeof msg === 'string' && msg.includes('not due'),
    );
    expect(skipLog?.[1]).toEqual({ cadenceDays: EVALUATION_RUN_CADENCE_DAYS });
  });
});
