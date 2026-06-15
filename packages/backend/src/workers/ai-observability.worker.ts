/**
 * AI Observability Worker — entry point.
 *
 * Schedules the cadenced jobs the {@link ObservabilityService} exposes:
 *
 *   - Daily retention sweep on the assistant query logs (Req 21.1).
 *   - Daily RAG precision / recall aggregation (Req 21.2).
 *   - Daily helpfulness-window evaluation (Req 21.4) — also fires on
 *     every ratings event, this is a belt-and-braces sweep so a quiet
 *     day doesn't mask a regression.
 *   - Weekly automated evaluation against the curated QA test set
 *     (Req 21.6).
 *
 * In production the application typically uses an external scheduler
 * (cron, BullMQ, AWS EventBridge) that invokes
 * {@link runAiObservabilityCycle} once per day. The
 * {@link startAiObservabilitySchedule} helper provides a simple
 * in-process scheduler for development / single-instance deployments.
 */

import {
  EVALUATION_RUN_CADENCE_DAYS,
  type DailyRagMetrics,
  type EvaluationRunSummary,
  type EvaluationTestCase,
  type ObservabilityService,
  type AssistantUnderTest,
} from '../services/ai-observability';

/** Logger surface — kept narrow so the same shape works for tests / pino / console. */
export interface AiObservabilityLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

/**
 * Production-grade structured logger built on top of pino so observability
 * cycle output ends up in the same aggregation pipeline as HTTP logs.
 * Falls back to console when pino isn't reachable (test environments).
 */
type PinoLikeLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};
type PinoFactory = (opts: unknown) => PinoLikeLogger;

function createConsoleLogger(): AiObservabilityLogger {
  try {
    // pino's CJS export is callable directly; the `.default` shape only
    // exists when interop layers (esModuleInterop) wrap the module. We
    // try both shapes so the worker stays portable across bundlers.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pinoModule = require('pino') as PinoFactory | { default: PinoFactory };
    const factory: PinoFactory =
      typeof pinoModule === 'function'
        ? pinoModule
        : (pinoModule as { default: PinoFactory }).default;
    const logger = factory({ name: 'ai-observability', level: process.env.LOG_LEVEL ?? 'info' });
    return {
      info: (msg, ctx) => logger.info(ctx ?? {}, msg),
      warn: (msg, ctx) => logger.warn(ctx ?? {}, msg),
      error: (msg, ctx) => logger.error(ctx ?? {}, msg),
    };
  } catch {
    return {
      info: (msg, ctx) => console.log(`[ai-observability] ${msg}`, ctx ?? {}),
      warn: (msg, ctx) => console.warn(`[ai-observability] ${msg}`, ctx ?? {}),
      error: (msg, ctx) => console.error(`[ai-observability] ${msg}`, ctx ?? {}),
    };
  }
}

const consoleLogger: AiObservabilityLogger = createConsoleLogger();

/** Outcome of a single observability cycle. */
export interface AiObservabilityCycleResult {
  prunedLogs: number;
  dailyMetrics: DailyRagMetrics;
  helpfulnessAlerted: boolean;
  evaluation: EvaluationRunSummary | null;
  /** When the cycle started (UTC). */
  startedAt: Date;
  /** When the cycle finished (UTC). */
  finishedAt: Date;
}

export interface AiObservabilityCycleOptions {
  service: ObservabilityService;
  /**
   * Assistant under test for the weekly evaluation. Required when
   * the cycle's weekly evaluation step needs to fire; if absent and
   * the weekly cadence has elapsed, the cycle logs a warning and
   * skips the evaluation.
   */
  assistant?: AssistantUnderTest;
  /**
   * Curated QA test set (Req 21.6). Required alongside `assistant`.
   * The {@link ObservabilityService} re-validates the size minimum.
   */
  testCases?: ReadonlyArray<EvaluationTestCase>;
  /** Inject a logger; defaults to a console-based implementation. */
  logger?: AiObservabilityLogger;
  /** Inject a clock for deterministic tests. */
  now?: () => Date;
  /** Force the weekly evaluation to run regardless of cadence. */
  forceWeeklyEvaluation?: boolean;
}

/**
 * Run a single observability cycle. Each step is independent —
 * failure of one (e.g. retention sweep against a temporarily
 * unavailable DB) does not prevent the rest from executing. The
 * function never throws; failures are surfaced through the logger.
 */
export async function runAiObservabilityCycle(
  options: AiObservabilityCycleOptions,
): Promise<AiObservabilityCycleResult> {
  const logger = options.logger ?? consoleLogger;
  const now = options.now ?? (() => new Date());
  const startedAt = now();

  // ── 1. Retention sweep (Req 21.1) ─────────────────────────────────────────
  let prunedLogs = 0;
  try {
    prunedLogs = await options.service.pruneExpiredLogs(now());
    logger.info('Retention sweep complete', { prunedLogs });
  } catch (err) {
    logger.error('Retention sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 2. Daily RAG metrics (Req 21.2) ───────────────────────────────────────
  let dailyMetrics: DailyRagMetrics = {
    date: startedAt,
    ratedResponses: 0,
    precision: 0,
    recall: 0,
  };
  try {
    dailyMetrics = await options.service.aggregateDailyMetrics();
    logger.info('Daily RAG metrics aggregated', {
      date: dailyMetrics.date.toISOString(),
      ratedResponses: dailyMetrics.ratedResponses,
      precision: dailyMetrics.precision,
      recall: dailyMetrics.recall,
    });
  } catch (err) {
    logger.error('Daily RAG metrics aggregation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 3. Helpfulness sweep (Req 21.4) ───────────────────────────────────────
  let helpfulnessAlerted = false;
  try {
    const snapshot = await options.service.helpfulnessSnapshot();
    helpfulnessAlerted = snapshot.shouldAlert;
    logger.info('Helpfulness snapshot evaluated', {
      ratedResponses: snapshot.ratedResponses,
      helpfulCount: snapshot.helpfulCount,
      helpfulRate: snapshot.helpfulRate,
      shouldAlert: snapshot.shouldAlert,
    });
  } catch (err) {
    logger.error('Helpfulness snapshot failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 4. Weekly evaluation (Req 21.6) ───────────────────────────────────────
  let evaluation: EvaluationRunSummary | null = null;
  try {
    const due =
      options.forceWeeklyEvaluation ??
      (await options.service.shouldRunWeeklyEvaluation(now()));
    if (due) {
      if (!options.assistant || !options.testCases) {
        logger.warn(
          'Weekly evaluation due but assistant or testCases not provided; skipping',
          { hasAssistant: Boolean(options.assistant), testCases: options.testCases?.length ?? 0 },
        );
      } else {
        evaluation = await options.service.runWeeklyEvaluation({
          assistant: options.assistant,
          testCases: options.testCases,
        });
        logger.info('Weekly evaluation complete', {
          runId: evaluation.runId,
          totalCases: evaluation.totalCases,
          precision: evaluation.precision,
          recall: evaluation.recall,
          answerCorrectCount: evaluation.answerCorrectCount,
        });
      }
    } else {
      logger.info('Weekly evaluation not due — skipping', {
        cadenceDays: EVALUATION_RUN_CADENCE_DAYS,
      });
    }
  } catch (err) {
    logger.error('Weekly evaluation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const finishedAt = now();
  return {
    prunedLogs,
    dailyMetrics,
    helpfulnessAlerted,
    evaluation,
    startedAt,
    finishedAt,
  };
}

/**
 * Simple in-process schedule. Runs the cycle immediately, then once
 * every `intervalMs` (default 24 hours). Returns a stop function.
 *
 * Production deployments should prefer an external scheduler — this
 * helper exists for development / single-instance deployments where
 * pulling in BullMQ or node-cron is overkill.
 */
export function startAiObservabilitySchedule(
  options: AiObservabilityCycleOptions & { intervalMs?: number } = {} as AiObservabilityCycleOptions,
): () => void {
  const intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
  const logger = options.logger ?? consoleLogger;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await runAiObservabilityCycle(options);
    } catch (err) {
      logger.error('Unhandled error during observability cycle', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // First run on the next tick so the caller can attach listeners
  // before the work starts.
  setImmediate(tick);
  const handle = setInterval(tick, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
