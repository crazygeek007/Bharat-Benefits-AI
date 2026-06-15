/**
 * Deadline Tracker — scans a citizen's saved schemes for upcoming
 * deadlines and emits notifications via the NotificationService.
 *
 * Validates: Requirements 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8.
 *
 * Responsibilities:
 *   - `checkDeadlines(now)` — for every saved scheme with a fixed
 *     deadline, decide whether a notification is due and, if so, dispatch
 *     it through `NotificationService.deliverWithRetry` (Req 10.2, 10.3,
 *     10.6, 10.8).
 *   - `getDeadlinesWithinWindow` — the pure helper backing the calendar
 *     view; surfaces only saved schemes whose deadline lies in
 *     `[now, now + DEADLINE_DISPLAY_WINDOW_DAYS]` (Req 10.4). Schemes with
 *     no deadline / rolling window are excluded (Req 10.7).
 *   - `notifyDeadlineChange` — dispatches a single notification when a
 *     scheme's deadline is moved (Req 10.5). The previous & new values are
 *     embedded in the notification body so the citizen sees the diff.
 *   - Pure helpers `daysUntilDeadline` and `shouldSendNotification`
 *     exported for the property-based tests (12.5, 12.6).
 *
 * Why pure helpers exist alongside the class: Property 15 / Property 30
 * exercise the notification & display predicates directly, so they live as
 * standalone functions to keep the property tests free of Prisma / clock
 * mocking. The class is thin glue: build the message, pick the right
 * priority, dispatch.
 */

import {
  DEADLINE_DISPLAY_WINDOW_DAYS,
  DEADLINE_NOTIFICATION_DAYS,
  HIGH_PRIORITY_NOTIFICATION_HOURS,
  MAX_SAVED_SCHEMES,
  type SavedScheme,
  type Scheme,
} from '@bharat-benefits/shared';
import type {
  DeliveryWithRetryResult,
  NotificationService,
  OutboundNotification,
} from '../notifications/notification-service';

// ─── Constants ───────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Tolerance around each high-priority notification trigger (24h, 6h).
 *
 * Why we need a window: `checkDeadlines` runs on a schedule (e.g. every
 * 30 min). We can never expect `now` to land exactly on the 24h or 6h
 * mark, so we accept anything inside ±`HIGH_PRIORITY_TRIGGER_WINDOW_MS`
 * of the trigger to fire the notification. The default is conservative
 * (1 hour) — production scheduling should be more frequent than that.
 */
export const HIGH_PRIORITY_TRIGGER_WINDOW_MS = 60 * 60 * 1000;

// ─── Public types ────────────────────────────────────────────────────────────

/** Saved scheme + its hydrated `Scheme` row, the input to checkDeadlines. */
export interface SavedSchemeWithScheme {
  saved: SavedScheme;
  scheme: Scheme;
}

/** Result returned from `checkDeadlines` for observability. */
export interface DeadlineCheckResult {
  schemeId: string;
  userId: string;
  /** True when a notification was dispatched on this run. */
  notified: boolean;
  /** The trigger that fired, when applicable. */
  trigger: DeadlineTrigger | null;
  delivery: DeliveryWithRetryResult | null;
}

/**
 * Discrete trigger that caused a deadline notification to fire.
 *   - `'7d'`     — the 7-days-out heads-up (Req 10.2).
 *   - `'24h'`    — high-priority 24-hour reminder (Req 10.3).
 *   - `'6h'`     — high-priority 6-hour final reminder (Req 10.3).
 */
export type DeadlineTrigger = '7d' | '24h' | '6h';

/** Arguments to the optional `recordNotification` hook used for idempotency. */
export interface RecordNotificationArgs {
  userId: string;
  schemeId: string;
  trigger: DeadlineTrigger;
  at: Date;
}

/**
 * Dependencies & overrides accepted by the DeadlineTracker constructor.
 *
 * `hasNotified` / `recordNotification` are optional. When supplied, the
 * tracker uses them to skip a trigger that already fired for the same
 * (user, scheme, trigger) tuple — production wiring should back this with
 * the Notification table so we don't spam the citizen across cron ticks.
 * Omit them in pure unit tests.
 */
export interface DeadlineTrackerOptions {
  notificationService: NotificationService;
  hasNotified?: (args: RecordNotificationArgs) => Promise<boolean> | boolean;
  recordNotification?: (args: RecordNotificationArgs) => Promise<void> | void;
  /**
   * Half-width of the high-priority trigger window. Defaults to
   * `HIGH_PRIORITY_TRIGGER_WINDOW_MS`.
   */
  highPriorityWindowMs?: number;
}

// ─── Pure helpers (exported for property-based tests 12.5 / 12.6) ────────────

/**
 * Whole-days difference between `deadline` and `now`. Negative when the
 * deadline has already passed, zero when same calendar day. The math is
 * done in raw milliseconds and then floored; floor (rather than round) is
 * intentional so a deadline 7d-and-1ms away counts as "7" not "8".
 *
 * Pure: no clock reads, no I/O.
 */
export function daysUntilDeadline(deadline: Date | null, now: Date): number | null {
  if (deadline === null || !(deadline instanceof Date) || Number.isNaN(deadline.getTime())) {
    return null;
  }
  const diffMs = deadline.getTime() - now.getTime();
  return Math.floor(diffMs / MS_PER_DAY);
}

/**
 * Whole-hours difference between `deadline` and `now`. Same semantics as
 * `daysUntilDeadline` but at hourly resolution; used for the 24h / 6h
 * high-priority triggers (Req 10.3).
 */
export function hoursUntilDeadline(deadline: Date | null, now: Date): number | null {
  if (deadline === null || !(deadline instanceof Date) || Number.isNaN(deadline.getTime())) {
    return null;
  }
  const diffMs = deadline.getTime() - now.getTime();
  return Math.floor(diffMs / MS_PER_HOUR);
}

/**
 * Decide whether a saved scheme should trigger a deadline notification at
 * the moment `now`.
 *
 * Returns the matching `DeadlineTrigger`, or `null` when no notification
 * is due (deadline absent, deadline already passed, or outside every
 * trigger window).
 *
 * Validates: Property 15 — schemes more than 7 days out yield `null`,
 * schemes within 7 days yield a trigger, schemes with `deadline === null`
 * (rolling window per Req 10.7) yield `null`.
 *
 * Trigger precedence is fine-to-coarse: if the deadline is inside the 6h
 * window we report `'6h'`; otherwise inside the 24h window we report
 * `'24h'`; otherwise inside the 7-day band we report `'7d'`. This mirrors
 * how the citizen perceives urgency — once we are 6h out, the 7d heads-up
 * is no longer the appropriate label.
 */
export function shouldSendNotification(
  deadline: Date | null,
  now: Date,
  options: { highPriorityWindowMs?: number } = {},
): DeadlineTrigger | null {
  const window = options.highPriorityWindowMs ?? HIGH_PRIORITY_TRIGGER_WINDOW_MS;

  if (deadline === null || !(deadline instanceof Date) || Number.isNaN(deadline.getTime())) {
    return null;
  }
  const diffMs = deadline.getTime() - now.getTime();
  if (diffMs < 0) return null; // already past — no notification (Req 10.2 / 10.3 only fire before).

  const sixHourMs = 6 * MS_PER_HOUR;
  const twentyFourHourMs = 24 * MS_PER_HOUR;

  // High-priority triggers come first — they take precedence over the 7d
  // heads-up when a single tick lands inside both bands.
  if (Math.abs(diffMs - sixHourMs) <= window) return '6h';
  if (Math.abs(diffMs - twentyFourHourMs) <= window) return '24h';

  // 7d trigger is "any time within the next 7 days, more than 24h out".
  // Constants come from shared types so a config tweak propagates.
  const sevenDaysMs = DEADLINE_NOTIFICATION_DAYS * MS_PER_DAY;
  if (diffMs <= sevenDaysMs && diffMs > twentyFourHourMs + window) return '7d';

  return null;
}

/**
 * Boolean view of "is a deadline notification due?" — the simple
 * predicate exercised by **Property 15** (Reqs 10.2, 10.7).
 *
 * Distinct from `shouldSendNotification` (which classifies the *kind* of
 * trigger and is used by the running scheduler — Req 10.3): this helper
 * answers only the citizen-facing question Property 15 cares about, "is
 * the deadline close enough to warrant a deadline-based notification?".
 *
 * Contract:
 *   - `null` deadline (rolling / "Open / No Deadline" per Req 10.7) → false
 *   - deadline already at or before `now` (no longer in the future)   → false
 *   - deadline strictly in the future and at most
 *     `DEADLINE_NOTIFICATION_DAYS` (= 7) days away                    → true
 *   - deadline more than 7 days in the future                         → false
 *
 * Pure: depends only on its arguments.
 */
export function shouldSendDeadlineNotification(
  deadline: Date | null,
  now: Date,
): boolean {
  if (deadline === null || !(deadline instanceof Date) || Number.isNaN(deadline.getTime())) {
    return false;
  }
  const diffMs = deadline.getTime() - now.getTime();
  if (diffMs <= 0) return false; // already at-or-past — Property 15 is forward-looking.
  const sevenDaysMs = DEADLINE_NOTIFICATION_DAYS * MS_PER_DAY;
  return diffMs <= sevenDaysMs;
}

/**
 * Boolean view of "can the citizen save another scheme?" — backs the
 * `MAX_SAVED_SCHEMES = 100` cap mandated by Req 10.1 / Property 15.
 *
 * Returns true iff `currentSavedCount` is a finite, non-negative integer
 * strictly less than `MAX_SAVED_SCHEMES`. Non-finite or negative inputs
 * are treated as "cannot save" rather than throwing — a defensive
 * default that keeps callers (HTTP layer, dashboard) from accidentally
 * letting a corrupt count bypass the cap.
 *
 * Pure: depends only on its argument.
 */
export function canSaveScheme(currentSavedCount: number): boolean {
  if (!Number.isFinite(currentSavedCount) || currentSavedCount < 0) return false;
  return currentSavedCount < MAX_SAVED_SCHEMES;
}

/**
 * Pure helper backing the calendar/timeline view (Property 30 / Req 10.4).
 *
 * Includes a saved scheme iff its deadline is within `[now, now + days]`
 * (inclusive on both ends). Schemes with `deadline === null` — rolling /
 * "Open / No Deadline" per Req 10.7 — are excluded, as are schemes whose
 * deadline already passed.
 */
export function getDeadlinesWithinWindow<T extends { scheme: { deadline: Date | null } }>(
  savedSchemes: ReadonlyArray<T>,
  days: number,
  now: Date,
): T[] {
  if (!Number.isFinite(days) || days < 0) return [];
  const windowEndMs = now.getTime() + days * MS_PER_DAY;
  return savedSchemes.filter((entry) => {
    const d = entry.scheme.deadline;
    if (d === null || !(d instanceof Date) || Number.isNaN(d.getTime())) return false;
    const t = d.getTime();
    return t >= now.getTime() && t <= windowEndMs;
  });
}

// ─── The tracker class ───────────────────────────────────────────────────────

export class DeadlineTracker {
  private readonly notifications: NotificationService;
  private readonly hasNotified: (args: RecordNotificationArgs) => Promise<boolean>;
  private readonly recordNotification: (args: RecordNotificationArgs) => Promise<void>;
  private readonly highPriorityWindowMs: number;

  constructor(opts: DeadlineTrackerOptions) {
    this.notifications = opts.notificationService;
    this.highPriorityWindowMs = opts.highPriorityWindowMs ?? HIGH_PRIORITY_TRIGGER_WINDOW_MS;
    // Default no-op idempotency hooks — callers that care about "fire once
    // per trigger" wire these to the Notification table.
    const noopHas = async () => false;
    const noopRecord = async () => undefined;
    this.hasNotified = async (a) =>
      Boolean(await (opts.hasNotified ?? noopHas)(a));
    this.recordNotification = async (a) =>
      void (await (opts.recordNotification ?? noopRecord)(a));
    // Sanity-check the static config matches Req 10.3.
    if (
      HIGH_PRIORITY_NOTIFICATION_HOURS[0] !== 24 ||
      HIGH_PRIORITY_NOTIFICATION_HOURS[1] !== 6
    ) {
      throw new Error(
        'HIGH_PRIORITY_NOTIFICATION_HOURS must be [24, 6] per Req 10.3 — shared constant changed unexpectedly',
      );
    }
  }

  /**
   * Scan a citizen's (or a batch's) saved schemes and dispatch any
   * deadline notifications whose trigger matches `now`. Saved schemes
   * with no fixed deadline (Req 10.7 — rolling window) are skipped.
   */
  async checkDeadlines(
    savedSchemes: ReadonlyArray<SavedSchemeWithScheme>,
    now: Date,
    recipientEmailFor?: (userId: string) => string,
  ): Promise<DeadlineCheckResult[]> {
    const results: DeadlineCheckResult[] = [];

    for (const entry of savedSchemes) {
      const { saved, scheme } = entry;
      const trigger = shouldSendNotification(scheme.deadline, now, {
        highPriorityWindowMs: this.highPriorityWindowMs,
      });
      if (trigger === null) {
        results.push({
          schemeId: scheme.id,
          userId: saved.userId,
          notified: false,
          trigger: null,
          delivery: null,
        });
        continue;
      }

      // Idempotency — only fire each (user, scheme, trigger) tuple once.
      const recordArgs: RecordNotificationArgs = {
        userId: saved.userId,
        schemeId: scheme.id,
        trigger,
        at: now,
      };
      if (await this.hasNotified(recordArgs)) {
        results.push({
          schemeId: scheme.id,
          userId: saved.userId,
          notified: false,
          trigger,
          delivery: null,
        });
        continue;
      }

      const message = buildDeadlineNotification(saved, scheme, trigger, recipientEmailFor);
      const delivery = await this.notifications.deliverWithRetry(message);
      await this.recordNotification(recordArgs);
      results.push({
        schemeId: scheme.id,
        userId: saved.userId,
        notified: true,
        trigger,
        delivery,
      });
    }

    return results;
  }

  /**
   * Calendar/timeline view backing query — exposed on the class for
   * convenience; delegates to the pure helper. Defaults to the 90-day
   * window mandated by Req 10.4 / Property 30.
   */
  getDeadlinesWithinWindow(
    savedSchemes: ReadonlyArray<SavedSchemeWithScheme>,
    days: number = DEADLINE_DISPLAY_WINDOW_DAYS,
    now: Date = new Date(),
  ): SavedSchemeWithScheme[] {
    return getDeadlinesWithinWindow(savedSchemes, days, now);
  }

  /**
   * Notify a citizen that a saved scheme's deadline moved (Req 10.5). The
   * citizen sees the previous deadline, the new deadline, and the source
   * url so they can independently verify the change.
   */
  async notifyDeadlineChange(
    userId: string,
    scheme: Scheme,
    prevDeadline: Date | null,
    newDeadline: Date | null,
    recipientEmail: string,
  ): Promise<DeliveryWithRetryResult> {
    const message: OutboundNotification = {
      userId,
      schemeId: scheme.id,
      type: 'change',
      recipientEmail,
      subject: `Deadline updated: ${scheme.name}`,
      body: formatDeadlineChangeBody(scheme, prevDeadline, newDeadline),
      highPriority: false,
      payload: {
        schemeId: scheme.id,
        schemeName: scheme.name,
        previousDeadline: prevDeadline ? prevDeadline.toISOString() : null,
        newDeadline: newDeadline ? newDeadline.toISOString() : null,
        sourceUrl: scheme.sourceUrl,
      },
    };
    return this.notifications.deliverWithRetry(message);
  }
}

// ─── Message builders ────────────────────────────────────────────────────────

function buildDeadlineNotification(
  saved: SavedScheme,
  scheme: Scheme,
  trigger: DeadlineTrigger,
  recipientEmailFor?: (userId: string) => string,
): OutboundNotification {
  const deadline = scheme.deadline;
  const deadlineStr = deadline ? deadline.toISOString() : 'unknown';
  const subject =
    trigger === '7d'
      ? `Reminder: ${scheme.name} deadline in 7 days`
      : trigger === '24h'
        ? `URGENT: ${scheme.name} deadline in 24 hours`
        : `URGENT: ${scheme.name} deadline in 6 hours`;
  const body =
    `Your saved scheme "${scheme.name}" has an upcoming deadline.\n` +
    `Deadline: ${deadlineStr}\n` +
    `View details: ${scheme.sourceUrl}`;
  return {
    userId: saved.userId,
    schemeId: scheme.id,
    type: 'deadline',
    recipientEmail: recipientEmailFor ? recipientEmailFor(saved.userId) : '',
    subject,
    body,
    highPriority: trigger !== '7d',
    payload: {
      schemeId: scheme.id,
      schemeName: scheme.name,
      deadline: deadlineStr,
      trigger,
      sourceUrl: scheme.sourceUrl,
    },
  };
}

function formatDeadlineChangeBody(
  scheme: Scheme,
  prev: Date | null,
  next: Date | null,
): string {
  return (
    `The deadline for "${scheme.name}" has been updated.\n` +
    `Previous deadline: ${prev ? prev.toISOString() : 'Open / No Deadline'}\n` +
    `New deadline: ${next ? next.toISOString() : 'Open / No Deadline'}\n` +
    `Source: ${scheme.sourceUrl}`
  );
}
