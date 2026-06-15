/**
 * Weekly automated evaluation runner (Req 21.6).
 *
 * Executes each {@link EvaluationTestCase} against the live
 * Scheme_Assistant, records per-case precision / recall / answer-
 * correctness, and aggregates the results into an
 * {@link EvaluationRunSummary}. The cadence is enforced by the worker
 * scheduler (see `daily-crawl.worker` + future weekly-eval worker);
 * this class only knows how to execute a single run.
 *
 * The QA test set is supplied via dependency injection so admins can
 * grow it without code changes. The runner enforces the
 * {@link MIN_EVALUATION_TEST_SET_SIZE} floor on construction.
 *
 * Validates: Requirements 21.6.
 */

import { randomUUID } from 'node:crypto';

import type { AssistantResponse, SupportedLanguage } from '@bharat-benefits/shared';

import { MIN_EVALUATION_TEST_SET_SIZE } from './constants';
import { mean, precision, recall } from './rag-metrics';
import type {
  EvaluationCaseResult,
  EvaluationRunSummary,
  EvaluationTestCase,
} from './types';

/** Subset of {@link SchemeAssistant} the runner depends on. */
export interface AssistantUnderTest {
  answerQuery(
    query: string,
    sessionId: string,
    platformLanguage?: SupportedLanguage,
  ): Promise<AssistantResponse>;
}

export interface EvaluationRunnerOptions {
  /** Lower the test-set size requirement. Use only in unit tests. */
  minTestSetSize?: number;
  /** Inject a clock so tests can pin durations / `startedAt` deterministically. */
  now?: () => Date;
  /** Generate the run id. Defaults to {@link randomUUID}. */
  generateRunId?: () => string;
}

export class EvaluationRunner {
  private readonly testCases: ReadonlyArray<EvaluationTestCase>;
  private readonly minTestSetSize: number;
  private readonly now: () => Date;
  private readonly generateRunId: () => string;

  constructor(
    private readonly assistant: AssistantUnderTest,
    testCases: ReadonlyArray<EvaluationTestCase>,
    options: EvaluationRunnerOptions = {},
  ) {
    const minTestSetSize = options.minTestSetSize ?? MIN_EVALUATION_TEST_SET_SIZE;
    if (testCases.length < minTestSetSize) {
      throw new Error(
        `EvaluationRunner: at least ${minTestSetSize} test cases are required ` +
          `(got ${testCases.length})`,
      );
    }
    // Defensive copy so callers can't mutate the suite mid-run.
    this.testCases = testCases.map((c) => ({
      ...c,
      expectedSchemeIds: [...c.expectedSchemeIds],
      expectedAnswerContains: c.expectedAnswerContains
        ? [...c.expectedAnswerContains]
        : undefined,
    }));
    this.minTestSetSize = minTestSetSize;
    this.now = options.now ?? (() => new Date());
    this.generateRunId = options.generateRunId ?? (() => randomUUID());
  }

  /** Number of test cases configured. Useful for admin dashboards. */
  get testSetSize(): number {
    return this.testCases.length;
  }

  /**
   * Execute every test case sequentially. Sequential execution avoids
   * thundering the LLM provider with N concurrent requests; weekly
   * runs are not latency-critical.
   */
  async run(): Promise<EvaluationRunSummary> {
    const runId = this.generateRunId();
    const startedAt = this.now();
    const results: EvaluationCaseResult[] = [];

    for (const testCase of this.testCases) {
      const caseResult = await this.runCase(runId, testCase);
      results.push(caseResult);
    }

    const finishedAt = this.now();
    const answerCorrectCount = results.reduce(
      (acc, r) => acc + (r.answerContainsExpected ? 1 : 0),
      0,
    );
    return {
      runId,
      startedAt,
      finishedAt,
      totalCases: results.length,
      precision: mean(results.map((r) => r.precision)),
      recall: mean(results.map((r) => r.recall)),
      answerCorrectCount,
      results,
    };
  }

  private async runCase(
    runId: string,
    testCase: EvaluationTestCase,
  ): Promise<EvaluationCaseResult> {
    const sessionId = `${runId}::${testCase.id}`;
    const startedAt = this.now();
    let response: AssistantResponse;
    try {
      response = await this.assistant.answerQuery(testCase.query, sessionId);
    } catch (err) {
      // A thrown assistant means the case scored 0 across the board.
      const finishedAt = this.now();
      return {
        testCaseId: testCase.id,
        query: testCase.query,
        expectedSchemeIds: [...testCase.expectedSchemeIds],
        retrievedSchemeIds: [],
        precision: 0,
        recall: 0,
        answerContainsExpected: false,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        // Synthesise an opaque trace id so every result row still
        // carries one — admins searching for the failed case in the
        // log store will look it up via `testCaseId` regardless.
        traceId: `eval-failed::${(err as Error).message ?? 'unknown'}`,
      };
    }
    const finishedAt = this.now();
    const retrievedSchemeIds = uniqueSchemeIds(response.sources);
    return {
      testCaseId: testCase.id,
      query: testCase.query,
      expectedSchemeIds: [...testCase.expectedSchemeIds],
      retrievedSchemeIds,
      precision: precision(retrievedSchemeIds, testCase.expectedSchemeIds),
      recall: recall(retrievedSchemeIds, testCase.expectedSchemeIds),
      answerContainsExpected: matchesExpectedSubstrings(
        response.answer,
        testCase.expectedAnswerContains,
      ),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      traceId: response.traceId,
    };
  }
}

function uniqueSchemeIds(
  sources: ReadonlyArray<{ schemeId: string }>,
): string[] {
  const seen = new Set<string>();
  for (const s of sources) seen.add(s.schemeId);
  return Array.from(seen);
}

function matchesExpectedSubstrings(
  answer: string,
  expected: ReadonlyArray<string> | undefined,
): boolean {
  if (!expected || expected.length === 0) return true;
  const normalised = answer.toLowerCase();
  for (const phrase of expected) {
    if (!normalised.includes(phrase.toLowerCase())) return false;
  }
  return true;
}
