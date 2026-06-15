/**
 * Helpfulness alert monitor.
 *
 * Implements the rolling-window contract from Property 27 / Req 21.4:
 * for the most-recent {@link HELPFULNESS_ROLLING_WINDOW} rated
 * Scheme_Assistant responses, fire an admin alert iff fewer than
 * {@link HELPFULNESS_ALERT_THRESHOLD} of them were rated "helpful".
 *
 * The window only "warms up" once {@link HELPFULNESS_ROLLING_WINDOW}
 * ratings exist. Before that we surface the running rate but do NOT
 * fire alerts — small sample sizes would otherwise trigger spurious
 * pages on cold-start days.
 *
 * Validates: Requirements 21.4.
 */

import {
  HELPFULNESS_ALERT_THRESHOLD,
  HELPFULNESS_ROLLING_WINDOW,
} from './constants';
import type { FeedbackStore } from './feedback-store';
import type { AIQueryFeedback } from './types';

/** Snapshot of the helpfulness rolling window. */
export interface HelpfulnessSnapshot {
  /** Total rated responses considered (≤ {@link HELPFULNESS_ROLLING_WINDOW}). */
  ratedResponses: number;
  /** Count of responses rated `helpful` inside the window. */
  helpfulCount: number;
  /** Helpful rate in [0, 1]. `0` when no ratings have been collected. */
  helpfulRate: number;
  /**
   * `true` when the alert condition holds:
   *   - the window has reached its full size, AND
   *   - the helpful count is strictly less than the alert threshold.
   *
   * Validates: Requirements 21.4.
   */
  shouldAlert: boolean;
  /** Threshold the count is compared against (cached for telemetry). */
  threshold: number;
  /** Window size used (cached for telemetry). */
  windowSize: number;
}

/**
 * Sink invoked by the monitor when the alert condition fires. The
 * production wiring routes this to the platform's admin notification
 * channel; tests inject a vi.fn().
 */
export type AdminAlertSink = (alert: {
  message: string;
  helpfulCount: number;
  ratedResponses: number;
  helpfulRate: number;
  threshold: number;
  windowSize: number;
  evaluatedAt: Date;
}) => Promise<void> | void;

export interface HelpfulnessMonitorOptions {
  /** Override the rolling-window size. Defaults to 100 (Req 21.4). */
  windowSize?: number;
  /** Override the helpful-count alert threshold. Defaults to 80 (Req 21.4). */
  threshold?: number;
}

export class HelpfulnessMonitor {
  private readonly windowSize: number;
  private readonly threshold: number;

  constructor(
    private readonly feedbackStore: FeedbackStore,
    private readonly alertSink: AdminAlertSink = async () => undefined,
    options: HelpfulnessMonitorOptions = {},
  ) {
    const windowSize = options.windowSize ?? HELPFULNESS_ROLLING_WINDOW;
    const threshold = options.threshold ?? HELPFULNESS_ALERT_THRESHOLD;
    if (!Number.isInteger(windowSize) || windowSize <= 0) {
      throw new Error('HelpfulnessMonitor: windowSize must be a positive integer');
    }
    if (!Number.isInteger(threshold) || threshold < 0) {
      throw new Error('HelpfulnessMonitor: threshold must be a non-negative integer');
    }
    if (threshold > windowSize) {
      throw new Error(
        'HelpfulnessMonitor: threshold cannot exceed the rolling window size',
      );
    }
    this.windowSize = windowSize;
    this.threshold = threshold;
  }

  /**
   * Computes the helpfulness snapshot for the most-recent ratings.
   * Pure read against the {@link FeedbackStore} — no side effects.
   */
  async snapshot(): Promise<HelpfulnessSnapshot> {
    const recent = await this.feedbackStore.listMostRecent(this.windowSize);
    return computeSnapshot(recent, this.windowSize, this.threshold);
  }

  /**
   * Evaluate the rolling window and, if the alert condition holds,
   * dispatch a single notification through {@link AdminAlertSink}.
   *
   * Returns the snapshot it computed so callers can log / surface the
   * underlying numbers regardless of whether an alert fired.
   */
  async evaluateAndAlert(now: Date = new Date()): Promise<HelpfulnessSnapshot> {
    const snap = await this.snapshot();
    if (snap.shouldAlert) {
      await this.alertSink({
        message: `Scheme_Assistant helpful rate dropped below ${this.threshold}/${this.windowSize}`,
        helpfulCount: snap.helpfulCount,
        ratedResponses: snap.ratedResponses,
        helpfulRate: snap.helpfulRate,
        threshold: this.threshold,
        windowSize: this.windowSize,
        evaluatedAt: now,
      });
    }
    return snap;
  }
}

/**
 * Pure helper that classifies a slice of feedback rows. Exposed so
 * tests can exercise the rule without standing up a store.
 */
export function computeSnapshot(
  feedback: ReadonlyArray<AIQueryFeedback>,
  windowSize: number,
  threshold: number,
): HelpfulnessSnapshot {
  const considered = feedback.slice(0, windowSize);
  const ratedResponses = considered.length;
  let helpfulCount = 0;
  for (const row of considered) {
    if (row.rating === 'helpful') helpfulCount += 1;
  }
  const helpfulRate = ratedResponses === 0 ? 0 : helpfulCount / ratedResponses;
  // We only fire alerts once the window is fully populated. A 2-rating
  // sample with one "unhelpful" should not alert — that is noise, not
  // a quality regression (Req 21.4).
  const shouldAlert = ratedResponses >= windowSize && helpfulCount < threshold;
  return {
    ratedResponses,
    helpfulCount,
    helpfulRate,
    shouldAlert,
    threshold,
    windowSize,
  };
}
