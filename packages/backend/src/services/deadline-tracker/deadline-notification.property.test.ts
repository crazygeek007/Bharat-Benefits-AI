/**
 * Property-based tests for the boolean deadline-notification predicate
 * and the saved-scheme cap.
 *
 * **Property 15: Deadline Notification Logic**
 * **Validates: Requirements 10.1, 10.2, 10.7**
 *
 * Property statement (from design.md):
 *   For any saved scheme with a fixed deadline:
 *     (a) if the deadline is more than 7 days away, no deadline
 *         notification SHALL be sent,
 *     (b) if the deadline is within 7 days, a notification SHALL be
 *         triggered, and
 *     (c) schemes with no fixed deadline or rolling windows SHALL be
 *         excluded from all deadline-based notifications.
 *   Additionally, a citizen SHALL not be able to save more than 100
 *   schemes.
 *
 * The predicates under test are the pure helpers exported from
 * `./deadline-tracker`:
 *
 *   - `shouldSendDeadlineNotification(deadline, now)` — boolean view of
 *     "is a deadline notification due?". This is intentionally simpler
 *     than `shouldSendNotification`, which classifies the *kind* of
 *     trigger (7d / 24h / 6h) for the scheduler. Property 15 only cares
 *     about the citizen-visible "yes/no", so we test the boolean view
 *     here and leave trigger-precedence to the unit tests.
 *   - `canSaveScheme(currentSavedCount)` — boolean view of the
 *     `MAX_SAVED_SCHEMES = 100` cap (Req 10.1).
 *
 * The single universal claim is decomposed into five sub-properties so
 * a counter-example points at the precise invariant that broke:
 *
 *   A. Far-future exclusion — any deadline more than 7 days from `now`
 *      yields `false` (Req 10.2 contrapositive).
 *   B. Within-window inclusion — any deadline strictly in the future and
 *      at most 7 days out yields `true` (Req 10.2).
 *   C. Null / rolling exclusion — `null` deadlines yield `false` (Req
 *      10.7).
 *   D. Cap exclusion — saved counts ≥ 100 yield `false` for
 *      `canSaveScheme` (Req 10.1).
 *   E. Cap inclusion — saved counts in `[0, 100)` yield `true` for
 *      `canSaveScheme` (Req 10.1).
 *
 * Why a fixed `NOW`: Property 15 is independent of which exact moment
 * "now" is — it only depends on the relationship between `deadline` and
 * `now`. Anchoring `now` keeps shrinking deterministic and the tests
 * fully reproducible.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  DEADLINE_NOTIFICATION_DAYS,
  MAX_SAVED_SCHEMES,
} from '@bharat-benefits/shared';
import {
  shouldSendDeadlineNotification,
  canSaveScheme,
} from './deadline-tracker';

// ─── Tunables ───────────────────────────────────────────────────────────────

const NUM_RUNS = 200;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const NOW = new Date('2025-01-15T12:00:00.000Z');

// ─── Property A: deadlines > 7 days away → false ────────────────────────────

describe('Property 15A: deadlines more than 7 days away yield no notification (Req 10.2)', () => {
  /**
   * Generator: a deadline strictly more than 7 days from `now`. The lower
   * bound is `7 days + 1 ms` to avoid the boundary the within-window
   * property already covers; the upper bound is 5 years out, which is
   * well beyond any plausible scheme deadline yet keeps `Date` arithmetic
   * comfortably inside the safe-integer range.
   */
  const arbFarFutureDeadline = fc
    .integer({
      min: DEADLINE_NOTIFICATION_DAYS * MS_PER_DAY + 1,
      max: 5 * 365 * MS_PER_DAY,
    })
    .map((offsetMs) => new Date(NOW.getTime() + offsetMs));

  it('returns false for any deadline strictly more than 7 days in the future', () => {
    fc.assert(
      fc.property(arbFarFutureDeadline, (deadline) => {
        expect(shouldSendDeadlineNotification(deadline, NOW)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── Property B: deadlines within (0, 7d] → true ────────────────────────────

describe('Property 15B: deadlines within 7 days trigger a notification (Req 10.2)', () => {
  /**
   * Generator: a deadline strictly in the future and at most 7 days out.
   * The lower bound is `1 ms` because the predicate excludes `deadline ==
   * now` (a deadline that has just elapsed is no longer "upcoming"). The
   * upper bound is exactly `7 days` to cover the inclusive top edge.
   */
  const arbInWindowDeadline = fc
    .integer({ min: 1, max: DEADLINE_NOTIFICATION_DAYS * MS_PER_DAY })
    .map((offsetMs) => new Date(NOW.getTime() + offsetMs));

  it('returns true for any deadline strictly in the future and within 7 days', () => {
    fc.assert(
      fc.property(arbInWindowDeadline, (deadline) => {
        expect(shouldSendDeadlineNotification(deadline, NOW)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── Property C: null deadline → false (Req 10.7) ───────────────────────────

describe('Property 15C: null/rolling deadlines are excluded from notifications (Req 10.7)', () => {
  /**
   * `null` is the only value that represents a rolling / "Open / No
   * Deadline" scheme per Req 10.7, so there is nothing to randomise on
   * the deadline side. We *do* randomise `now` to demonstrate the
   * exclusion is independent of the current time — no choice of `now`
   * can cause a `null` deadline to slip through.
   */
  const arbNow = fc
    .integer({ min: -10 * 365 * MS_PER_DAY, max: 10 * 365 * MS_PER_DAY })
    .map((offsetMs) => new Date(NOW.getTime() + offsetMs));

  it('returns false for a null deadline regardless of the current time', () => {
    fc.assert(
      fc.property(arbNow, (now) => {
        expect(shouldSendDeadlineNotification(null, now)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── Property D: saved count ≥ 100 → cannot save (Req 10.1) ─────────────────

describe('Property 15D: citizens at or above the 100-scheme cap cannot save more (Req 10.1)', () => {
  /**
   * Generator: any non-negative integer at or above `MAX_SAVED_SCHEMES`.
   * Upper bound is large enough to exercise far-above-cap inputs that
   * a buggy comparison (e.g. `>` vs `>=`) might still mishandle.
   */
  const arbAtOrAboveCap = fc.integer({
    min: MAX_SAVED_SCHEMES,
    max: 1_000_000,
  });

  it('returns false for any saved count ≥ MAX_SAVED_SCHEMES', () => {
    fc.assert(
      fc.property(arbAtOrAboveCap, (count) => {
        expect(canSaveScheme(count)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── Property E: saved count < 100 → can save (Req 10.1) ────────────────────

describe('Property 15E: citizens below the 100-scheme cap can save another scheme (Req 10.1)', () => {
  /**
   * Generator: any non-negative integer strictly below the cap. The
   * range `[0, 99]` covers an empty dashboard up to one slot remaining.
   */
  const arbBelowCap = fc.integer({ min: 0, max: MAX_SAVED_SCHEMES - 1 });

  it('returns true for any saved count in [0, MAX_SAVED_SCHEMES)', () => {
    fc.assert(
      fc.property(arbBelowCap, (count) => {
        expect(canSaveScheme(count)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
