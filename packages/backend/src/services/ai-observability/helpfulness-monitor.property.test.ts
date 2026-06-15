/**
 * Property-based tests for the AI Helpfulness Alert Threshold.
 *
 * **Property 27: AI Helpfulness Alert Threshold**
 * **Validates: Requirements 21.4**
 *
 * Property statement (from design.md):
 * "For any rolling window of the most recent 100 rated Scheme_Assistant
 *  responses, the system SHALL trigger an administrator alert if and only
 *  if fewer than 80 of the 100 responses were rated as helpful."
 *
 * The pure helper {@link computeSnapshot} encodes this contract: when the
 * window has reached its full size (100 by default), the snapshot's
 * `shouldAlert` flag must hold iff `helpfulCount < threshold` (80 by
 * default). The {@link HelpfulnessMonitor} composes that helper with a
 * {@link FeedbackStore}, so we also exercise the end-to-end path via the
 * in-memory store and verify that the {@link AdminAlertSink} fires iff
 * the snapshot says it should.
 *
 * Generators are constrained to the input space the rule actually
 * cares about: a sequence of `'helpful' | 'unhelpful'` ratings whose
 * length straddles the window size, plus exact-boundary cases that
 * pin down the off-by-one shape of the iff.
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

import {
  HELPFULNESS_ALERT_THRESHOLD,
  HELPFULNESS_ROLLING_WINDOW,
} from './constants';
import {
  HelpfulnessMonitor,
  computeSnapshot,
  type AdminAlertSink,
} from './helpfulness-monitor';
import { InMemoryFeedbackStore } from './feedback-store';
import type { AIQueryFeedback, FeedbackRating } from './types';

const NUM_RUNS = 200;

const WINDOW = HELPFULNESS_ROLLING_WINDOW; // 100
const THRESHOLD = HELPFULNESS_ALERT_THRESHOLD; // 80

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const arbRating: fc.Arbitrary<FeedbackRating> = fc.constantFrom(
  'helpful',
  'unhelpful',
);

/**
 * Builds a feedback row from a rating and a sequence index. Only
 * `rating` and `createdAt` participate in the helpfulness rule, so the
 * other fields are stable filler. `createdAt` is monotonically
 * decreasing in `index` so the array we hand to `computeSnapshot`
 * already encodes the "newest-first" ordering the monitor receives
 * from {@link FeedbackStore.listMostRecent}.
 */
function makeFeedback(rating: FeedbackRating, index: number): AIQueryFeedback {
  return {
    id: `fb-${index}`,
    traceId: `trace-${index}`,
    userId: `user-${index}`,
    rating,
    comment: null,
    createdAt: new Date(2_000_000_000_000 - index * 1000),
  };
}

/**
 * A newest-first feedback list of 0..(WINDOW + 50) ratings. The upper
 * bound deliberately exceeds WINDOW so we exercise the slicing rule
 * ("only the most-recent WINDOW are considered") as well as the
 * under-filled and exactly-filled cases.
 */
const arbFeedbackList: fc.Arbitrary<AIQueryFeedback[]> = fc
  .array(arbRating, { minLength: 0, maxLength: WINDOW + 50 })
  .map((ratings) => ratings.map((r, i) => makeFeedback(r, i)));

/**
 * Builds a full WINDOW-sized feedback list whose helpful count equals
 * `helpfulCount`. The "which positions are helpful" decision is
 * randomised so the property exercises every interleaving, not just
 * the trivial "first K are helpful" arrangement.
 *
 * Constructive (no `fc.pre`): the returned arbitrary lives entirely
 * inside the partition `helpfulCount(window) = helpfulCount`, so the
 * downstream property never has to reject samples and cannot flake
 * on rare seeds. Sequential indices are assigned after the shuffle so
 * `createdAt` ordering still encodes "newest-first" the way
 * `computeSnapshot` expects.
 */
function arbFullWindowWithHelpfulCount(
  helpfulCount: number,
): fc.Arbitrary<AIQueryFeedback[]> {
  const indices = Array.from({ length: WINDOW }, (_, i) => i);
  return fc
    .shuffledSubarray(indices, { minLength: WINDOW, maxLength: WINDOW })
    .map((order) => {
      const ratings: FeedbackRating[] = order.map((idx) =>
        idx < helpfulCount ? 'helpful' : 'unhelpful',
      );
      return ratings.map((r, i) => makeFeedback(r, i));
    });
}

/**
 * Full window whose helpful count is ≥ THRESHOLD. Constructed
 * directly from a uniform integer in `[THRESHOLD, WINDOW]` so every
 * sample satisfies the partition without rejection.
 */
const arbFullWindowAtLeastThreshold: fc.Arbitrary<AIQueryFeedback[]> = fc
  .integer({ min: THRESHOLD, max: WINDOW })
  .chain((helpfulCount) => arbFullWindowWithHelpfulCount(helpfulCount));

/**
 * Full window whose helpful count is < THRESHOLD. Constructed from
 * `[0, THRESHOLD - 1]` for the same reason.
 */
const arbFullWindowBelowThreshold: fc.Arbitrary<AIQueryFeedback[]> = fc
  .integer({ min: 0, max: THRESHOLD - 1 })
  .chain((helpfulCount) => arbFullWindowWithHelpfulCount(helpfulCount));

// ─── Reference predicate ─────────────────────────────────────────────────────

/**
 * Direct restatement of Property 27. Used as the oracle for the
 * bidirectional equivalence test below.
 */
function shouldAlertReference(
  feedback: ReadonlyArray<AIQueryFeedback>,
  windowSize: number,
  threshold: number,
): boolean {
  const considered = feedback.slice(0, windowSize);
  if (considered.length < windowSize) return false;
  const helpful = considered.filter((f) => f.rating === 'helpful').length;
  return helpful < threshold;
}

// ─── Property tests ──────────────────────────────────────────────────────────

describe('Property 27: AI Helpfulness Alert Threshold', () => {
  // 1. Bidirectional iff — the heart of Property 27.
  //    snapshot.shouldAlert ⇔ (window full ∧ helpfulCount < threshold).
  it('shouldAlert ⇔ (window full ∧ helpfulCount < threshold) (Req 21.4)', () => {
    fc.assert(
      fc.property(arbFeedbackList, (feedback) => {
        const snap = computeSnapshot(feedback, WINDOW, THRESHOLD);
        const expected = shouldAlertReference(feedback, WINDOW, THRESHOLD);
        expect(snap.shouldAlert).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // 2. Acceptance over a fully-populated window:
  //    helpfulCount ≥ THRESHOLD ⇒ no alert.
  //    Generator is constrained directly to the partition, so we
  //    never rely on `fc.pre` and the test cannot flake on seeds.
  it('full window with ≥ THRESHOLD helpful ratings does not alert (Req 21.4)', () => {
    fc.assert(
      fc.property(arbFullWindowAtLeastThreshold, (feedback) => {
        const helpful = feedback.filter((f) => f.rating === 'helpful').length;
        expect(helpful).toBeGreaterThanOrEqual(THRESHOLD);
        const snap = computeSnapshot(feedback, WINDOW, THRESHOLD);
        expect(snap.ratedResponses).toBe(WINDOW);
        expect(snap.helpfulCount).toBe(helpful);
        expect(snap.shouldAlert).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // 3. Rejection over a fully-populated window:
  //    helpfulCount < THRESHOLD ⇒ alert.
  //    Same constructive generator approach as test #2.
  it('full window with < THRESHOLD helpful ratings alerts (Req 21.4)', () => {
    fc.assert(
      fc.property(arbFullWindowBelowThreshold, (feedback) => {
        const helpful = feedback.filter((f) => f.rating === 'helpful').length;
        expect(helpful).toBeLessThan(THRESHOLD);
        const snap = computeSnapshot(feedback, WINDOW, THRESHOLD);
        expect(snap.ratedResponses).toBe(WINDOW);
        expect(snap.helpfulCount).toBe(helpful);
        expect(snap.shouldAlert).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // 4. Under-filled window must never alert. The rule only applies to
  //    "the most recent 100 rated responses" — fewer than 100 ratings
  //    means the window has not warmed up yet, so no alert can fire
  //    regardless of helpful count.
  it('under-filled window (< WINDOW ratings) never alerts (Req 21.4)', () => {
    const arbUnderFilled = fc
      .array(arbRating, { minLength: 0, maxLength: WINDOW - 1 })
      .map((ratings) => ratings.map((r, i) => makeFeedback(r, i)));
    fc.assert(
      fc.property(arbUnderFilled, (feedback) => {
        const snap = computeSnapshot(feedback, WINDOW, THRESHOLD);
        expect(snap.ratedResponses).toBe(feedback.length);
        expect(snap.shouldAlert).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // 5. Slicing — only the most-recent WINDOW responses are considered.
  //    Ratings beyond index WINDOW-1 must not affect the alert decision.
  it('only the most-recent WINDOW ratings drive the decision (Req 21.4)', () => {
    fc.assert(
      fc.property(arbFeedbackList, (feedback) => {
        const truncated = feedback.slice(0, WINDOW);
        const snapAll = computeSnapshot(feedback, WINDOW, THRESHOLD);
        const snapTrunc = computeSnapshot(truncated, WINDOW, THRESHOLD);
        expect(snapAll.shouldAlert).toBe(snapTrunc.shouldAlert);
        expect(snapAll.helpfulCount).toBe(snapTrunc.helpfulCount);
        expect(snapAll.ratedResponses).toBe(snapTrunc.ratedResponses);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // 6. Boundary — exactly THRESHOLD helpful in a full window must NOT
  //    alert, and exactly THRESHOLD - 1 MUST alert. This pins the
  //    "fewer than 80" half of the iff: the comparison is strict.
  it('boundary: helpfulCount = THRESHOLD does not alert; THRESHOLD - 1 does (Req 21.4)', () => {
    const arbBoundary = fc.integer({ min: 0, max: WINDOW }).chain(
      (helpfulCount) =>
        arbFullWindowWithHelpfulCount(helpfulCount).map((feedback) => ({
          feedback,
          helpfulCount,
        })),
    );

    fc.assert(
      fc.property(arbBoundary, ({ feedback, helpfulCount }) => {
        const snap = computeSnapshot(feedback, WINDOW, THRESHOLD);
        expect(snap.helpfulCount).toBe(helpfulCount);
        expect(snap.ratedResponses).toBe(WINDOW);
        expect(snap.shouldAlert).toBe(helpfulCount < THRESHOLD);
      }),
      { numRuns: NUM_RUNS },
    );

    // Pin the two specific boundary points the rule turns on.
    const atThreshold = Array.from({ length: WINDOW }, (_, i) =>
      makeFeedback(i < THRESHOLD ? 'helpful' : 'unhelpful', i),
    );
    const oneBelowThreshold = Array.from({ length: WINDOW }, (_, i) =>
      makeFeedback(i < THRESHOLD - 1 ? 'helpful' : 'unhelpful', i),
    );
    expect(
      computeSnapshot(atThreshold, WINDOW, THRESHOLD).shouldAlert,
    ).toBe(false);
    expect(
      computeSnapshot(oneBelowThreshold, WINDOW, THRESHOLD).shouldAlert,
    ).toBe(true);
  });

  // 7. End-to-end: the monitor's alert sink fires iff snapshot.shouldAlert.
  //    This wires Property 27 through the FeedbackStore so the live code
  //    path — not just the pure helper — is covered.
  it('HelpfulnessMonitor.evaluateAndAlert dispatches iff shouldAlert (Req 21.4)', async () => {
    await fc.assert(
      fc.asyncProperty(arbFeedbackList, async (feedback) => {
        const store = new InMemoryFeedbackStore();
        // Seed the store. record() requires a unique (traceId, userId)
        // pair per row; our generator already produces unique traceIds.
        // We pass `now` so newest-first ordering matches what the pure
        // helper saw above.
        for (const row of feedback) {
          await store.record({
            traceId: row.traceId,
            userId: row.userId,
            rating: row.rating,
            now: row.createdAt,
          });
        }

        const sink = vi.fn<Parameters<AdminAlertSink>, ReturnType<AdminAlertSink>>();
        const monitor = new HelpfulnessMonitor(store, sink);
        const snap = await monitor.evaluateAndAlert();

        if (snap.shouldAlert) {
          expect(sink).toHaveBeenCalledTimes(1);
          const payload = sink.mock.calls[0][0];
          expect(payload.helpfulCount).toBe(snap.helpfulCount);
          expect(payload.ratedResponses).toBe(snap.ratedResponses);
          expect(payload.threshold).toBe(THRESHOLD);
          expect(payload.windowSize).toBe(WINDOW);
        } else {
          expect(sink).not.toHaveBeenCalled();
        }
      }),
      { numRuns: 50 }, // smaller — each run does WINDOW+ async store writes
    );
  });
});
