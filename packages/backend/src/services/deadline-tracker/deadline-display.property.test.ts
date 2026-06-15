/**
 * Property-based tests for the calendar/timeline view filter that powers
 * the Benefits Dashboard.
 *
 * **Property 30: Deadline Display Filtering**
 * **Validates: Requirements 10.4**
 *
 * Property statement (from design.md / tasks.md):
 * "For any saved scheme with a deadline, the calendar/timeline view SHALL
 *  display the scheme if and only if its deadline is within the next 90
 *  days from the current date."
 *
 * The pure helper under test is `getDeadlinesWithinWindow` exported from
 * `./deadline-tracker`. It accepts an array of saved-scheme records, a
 * window length in days, and a `now` Date, and returns the subset whose
 * `scheme.deadline` lies in `[now, now + days]` (inclusive on both ends).
 * Schemes with `deadline === null` (rolling / "Open / No Deadline" per
 * Req 10.7) are always excluded.
 *
 * The single universal claim above is decomposed into five sub-properties
 * so that a counter-example points at the precise invariant that broke:
 *
 *   1. Inclusion — any deadline in `[now, now+90d]` MUST appear in the
 *      output.
 *   2. Exclusion (future-far) — any deadline strictly greater than
 *      `now+90d` MUST NOT appear in the output.
 *   3. Exclusion (past) — any deadline strictly less than `now` MUST NOT
 *      appear in the output.
 *   4. Exclusion (null) — entries with `deadline === null` MUST NOT appear
 *      regardless of the rest of the input mix.
 *   5. Boundary — deadlines exactly at `now+90d` MUST be included and
 *      deadlines at `now+90d+1ms` MUST be excluded (the upper edge is
 *      closed, anything past it is not).
 *
 * The arbitraries deliberately mix all four offset categories (in-window,
 * past, future-far, null) inside a single list so that the filter is
 * exercised against realistic, heterogeneous input on every run.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  DEADLINE_DISPLAY_WINDOW_DAYS,
} from '@bharat-benefits/shared';
import { getDeadlinesWithinWindow } from './deadline-tracker';

// ─── Tunables ────────────────────────────────────────────────────────────────

const NUM_RUNS = 200;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A fixed reference `now` keeps shrinking deterministic and avoids any
 * dependency on the system clock during the test run. Property 30 is
 * independent of which exact moment "now" is — it only depends on the
 * relationship between `deadline` and `now` — so a single anchor is
 * sufficient and the tests remain fully reproducible.
 */
const NOW = new Date('2025-01-15T12:00:00.000Z');

// ─── Categorised offset arbitraries ─────────────────────────────────────────

/**
 * Categorical tag attached to each generated entry so the test can both
 * (a) build the deadline at the correct distance from `now`, and
 * (b) assert the right inclusion/exclusion outcome regardless of the
 * filter's internal logic.
 */
type Category = 'in-window' | 'past' | 'future-far' | 'null';

interface CategorisedOffset {
  category: Category;
  /** Milliseconds offset from `now`, or `null` for the rolling case. */
  offsetMs: number | null;
}

/**
 * In-window offsets: anywhere from `now` (offset 0) up to and including
 * `now + DEADLINE_DISPLAY_WINDOW_DAYS` (offset 90 days). Drawn at
 * millisecond resolution so the boundary is exercised with high
 * probability across 200 runs without needing a separate boundary case.
 */
const arbInWindowOffset: fc.Arbitrary<CategorisedOffset> = fc
  .integer({ min: 0, max: DEADLINE_DISPLAY_WINDOW_DAYS * MS_PER_DAY })
  .map((offsetMs) => ({ category: 'in-window' as const, offsetMs }));

/**
 * Past offsets: 1 ms to 30 days into the past. The 30-day cap is chosen
 * because it is well outside any plausible "almost-due" boundary and
 * therefore unambiguously excluded — a tighter range would only stress
 * the same property the boundary test already covers.
 */
const arbPastOffset: fc.Arbitrary<CategorisedOffset> = fc
  .integer({ min: 1, max: 30 * MS_PER_DAY })
  .map((ms) => ({ category: 'past' as const, offsetMs: -ms }));

/**
 * Future-far offsets: strictly more than 90 days out, capped at 365 days.
 * Lower bound is `90 days + 1 ms` to keep the boundary cleanly separated
 * from the in-window category.
 */
const arbFutureFarOffset: fc.Arbitrary<CategorisedOffset> = fc
  .integer({
    min: DEADLINE_DISPLAY_WINDOW_DAYS * MS_PER_DAY + 1,
    max: 365 * MS_PER_DAY,
  })
  .map((offsetMs) => ({ category: 'future-far' as const, offsetMs }));

/** Null deadline: rolling / "Open / No Deadline" schemes per Req 10.7. */
const arbNullOffset: fc.Arbitrary<CategorisedOffset> = fc.constant({
  category: 'null' as const,
  offsetMs: null,
});

const arbDeadlineOffset: fc.Arbitrary<CategorisedOffset> = fc.oneof(
  arbInWindowOffset,
  arbPastOffset,
  arbFutureFarOffset,
  arbNullOffset,
);

// ─── Entry shape ────────────────────────────────────────────────────────────

/**
 * Minimal saved-scheme shape required by `getDeadlinesWithinWindow`. The
 * filter is generic over `T extends { scheme: { deadline: Date | null } }`
 * so we keep the test fixture slim. An `id` field is carried only to make
 * counter-examples readable in shrunken output.
 */
interface Entry {
  id: string;
  category: Category;
  scheme: { deadline: Date | null };
}

function entryFromOffset(id: string, offset: CategorisedOffset): Entry {
  const deadline = offset.offsetMs === null ? null : new Date(NOW.getTime() + offset.offsetMs);
  return { id, category: offset.category, scheme: { deadline } };
}

const arbEntry: fc.Arbitrary<Entry> = fc
  .tuple(fc.string({ minLength: 1, maxLength: 8 }), arbDeadlineOffset)
  .map(([id, offset]) => entryFromOffset(id, offset));

const arbList: fc.Arbitrary<Entry[]> = fc.array(arbEntry, { minLength: 0, maxLength: 25 });

// ─── Properties ─────────────────────────────────────────────────────────────

describe('Property 30: Deadline Display Filtering — getDeadlinesWithinWindow', () => {
  /**
   * 1. Inclusion — every entry whose deadline lies in `[now, now+90d]`
   * MUST appear in the filtered output. Combined with property 5
   * (boundary), this fully covers the "if" direction of the iff.
   */
  it('includes every entry whose deadline is within the 90-day window', () => {
    fc.assert(
      fc.property(arbList, (entries) => {
        const result = getDeadlinesWithinWindow(entries, DEADLINE_DISPLAY_WINDOW_DAYS, NOW);
        const resultSet = new Set(result);
        for (const e of entries) {
          if (e.category === 'in-window') {
            expect(resultSet.has(e)).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * 2. Exclusion (future-far) — any entry whose deadline is strictly
   * greater than `now+90d` MUST NOT appear in the output.
   */
  it('excludes entries whose deadline is more than 90 days in the future', () => {
    fc.assert(
      fc.property(arbList, (entries) => {
        const result = getDeadlinesWithinWindow(entries, DEADLINE_DISPLAY_WINDOW_DAYS, NOW);
        const resultSet = new Set(result);
        for (const e of entries) {
          if (e.category === 'future-far') {
            expect(resultSet.has(e)).toBe(false);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * 3. Exclusion (past) — any entry whose deadline is strictly less than
   * `now` MUST NOT appear in the output. The calendar view is forward
   * looking; expired deadlines belong to the Expired bucket (Req 11.4),
   * not the upcoming-deadlines view.
   */
  it('excludes entries whose deadline has already passed', () => {
    fc.assert(
      fc.property(arbList, (entries) => {
        const result = getDeadlinesWithinWindow(entries, DEADLINE_DISPLAY_WINDOW_DAYS, NOW);
        const resultSet = new Set(result);
        for (const e of entries) {
          if (e.category === 'past') {
            expect(resultSet.has(e)).toBe(false);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * 4. Exclusion (null) — entries with `deadline === null` (rolling /
   * "Open / No Deadline" per Req 10.7) MUST never appear in the
   * calendar view, irrespective of the surrounding entry mix.
   */
  it('excludes entries with a null deadline (Req 10.7 rolling schemes)', () => {
    fc.assert(
      fc.property(arbList, (entries) => {
        const result = getDeadlinesWithinWindow(entries, DEADLINE_DISPLAY_WINDOW_DAYS, NOW);
        for (const r of result) {
          expect(r.scheme.deadline).not.toBeNull();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * 5. Boundary — the upper edge of the window is closed: a deadline
   * exactly at `now + 90 days` is included, and a deadline at
   * `now + 90 days + 1 ms` is excluded. This pins down the
   * inclusive/exclusive distinction that no other arbitrary can reliably
   * hit at millisecond resolution.
   */
  it('treats now+90d as inclusive and now+90d+1ms as exclusive (boundary)', () => {
    fc.assert(
      fc.property(arbList, (otherEntries) => {
        const exactBoundary: Entry = {
          id: '__boundary_in__',
          category: 'in-window',
          scheme: {
            deadline: new Date(NOW.getTime() + DEADLINE_DISPLAY_WINDOW_DAYS * MS_PER_DAY),
          },
        };
        const justPastBoundary: Entry = {
          id: '__boundary_out__',
          category: 'future-far',
          scheme: {
            deadline: new Date(NOW.getTime() + DEADLINE_DISPLAY_WINDOW_DAYS * MS_PER_DAY + 1),
          },
        };
        const list = [...otherEntries, exactBoundary, justPastBoundary];

        const result = getDeadlinesWithinWindow(list, DEADLINE_DISPLAY_WINDOW_DAYS, NOW);
        const resultSet = new Set(result);

        expect(resultSet.has(exactBoundary)).toBe(true);
        expect(resultSet.has(justPastBoundary)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
