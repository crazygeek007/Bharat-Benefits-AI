/**
 * Notification Service — multi-channel delivery layer with email retry +
 * in-app fallback.
 *
 * Validates: Requirements 10.6, 10.8 (and indirectly 10.2, 10.3 via the
 * Deadline Tracker that consumes this service).
 *
 * Responsibilities:
 *   - `sendEmail`  — single-shot send via the injected `EmailClient`
 *     (intended to wrap AWS SES). No retry built in; callers wanting a
 *     retry policy should use `deliverWithRetry`.
 *   - `sendInApp`  — single-shot broadcast via the injected
 *     `WebSocketBroadcaster` (intended to wrap the live in-app channel).
 *   - `deliverWithRetry` — orchestrates the Req 10.8 contract: retry email
 *     up to `maxEmailAttempts` times spread across a 24-hour window, then
 *     fall back to a single in-app broadcast if every email attempt failed.
 *
 * Why the transports are injected: the production wiring uses AWS SES and
 * the platform's WebSocket gateway. Both are out-of-process and we do not
 * want unit / property tests to require either, so the service depends on
 * narrow `EmailClient` / `WebSocketBroadcaster` interfaces. Tests inject
 * stubs; production code wires the SES + WebSocket implementations.
 *
 * Why a `wait` is injected: the default retry schedule spreads attempts
 * across 24 hours (`[0, 8h, 16h]`). Tests must not actually sleep, so the
 * waiter is overridable. The default uses `setTimeout` for production use.
 */

import {
  DEADLINE_NOTIFICATION_DAYS,
  MAX_SAVED_SCHEMES,
} from '@bharat-benefits/shared';
import type { DeliveryResult, NotificationChannel, NotificationType } from '@bharat-benefits/shared';

// ─── Constants ───────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Default email attempt count enforced by Req 10.8. */
export const DEFAULT_MAX_EMAIL_ATTEMPTS = 3;

/**
 * Default delays *before* each email attempt, summing to ≤ 24h to satisfy
 * Req 10.8 ("retry up to 3 times over 24 hours"). The first attempt fires
 * immediately (`0`); subsequent retries fire 8h and 16h after the first
 * attempt, so the last retry lands ~16h in (well within the 24h budget).
 */
export const DEFAULT_EMAIL_ATTEMPT_DELAYS_MS: ReadonlyArray<number> = [
  0,
  8 * HOUR_MS,
  16 * HOUR_MS,
];

// ─── Public message types ────────────────────────────────────────────────────

/**
 * Service-level notification message — what callers hand the
 * NotificationService to deliver. Distinct from the persisted
 * `Notification` entity in shared types: that one tracks status / retry
 * count after delivery, this one is the in-flight payload.
 */
export interface OutboundNotification {
  userId: string;
  schemeId: string;
  type: NotificationType;
  /** Recipient email. May be empty when a citizen has not configured one. */
  recipientEmail: string;
  subject: string;
  body: string;
  /** Mark high-priority for the in-app channel (Req 10.3). Defaults to false. */
  highPriority?: boolean;
  /** Free-form payload echoed to the in-app channel for client-side rendering. */
  payload?: Record<string, unknown>;
}

// ─── Transport interfaces ────────────────────────────────────────────────────

/** Email transport contract — SES wraps this in production. */
export interface EmailClient {
  send(req: EmailSendRequest): Promise<EmailSendOutcome>;
}

export interface EmailSendRequest {
  to: string;
  subject: string;
  body: string;
}

export interface EmailSendOutcome {
  messageId: string | null;
  success: boolean;
  /** Optional reason for failure — surfaced to callers in DeliveryResult. */
  error?: string | null;
}

/** WebSocket transport contract — the in-app gateway wraps this. */
export interface WebSocketBroadcaster {
  /**
   * Push `message` to the recipient. Implementations SHOULD return `true`
   * when at least one live socket received the broadcast and `false`
   * otherwise (e.g. user offline). Throwing is also acceptable; the
   * NotificationService treats both as a failed delivery.
   */
  broadcast(message: InAppMessage): Promise<boolean>;
}

export interface InAppMessage {
  userId: string;
  schemeId: string;
  type: NotificationType;
  subject: string;
  body: string;
  highPriority: boolean;
  payload: Record<string, unknown>;
}

// ─── Result types ────────────────────────────────────────────────────────────

/** Per-attempt diagnostic record returned by `deliverWithRetry`. */
export interface DeliveryAttempt {
  channel: NotificationChannel;
  /** 1-indexed attempt number across the whole `deliverWithRetry` call. */
  attempt: number;
  success: boolean;
  error: string | null;
  at: Date;
}

export interface DeliveryWithRetryResult {
  /** Outcome of the *last* attempt (the email success or the in-app fallback). */
  finalResult: DeliveryResult;
  attempts: DeliveryAttempt[];
}

// ─── Construction options ────────────────────────────────────────────────────

/** Awaiter — overridable for tests. */
export type Waiter = (ms: number) => Promise<void>;

export interface NotificationServiceOptions {
  emailClient: EmailClient;
  wsClient: WebSocketBroadcaster;
  /** Defaults to `DEFAULT_MAX_EMAIL_ATTEMPTS` (3). Must be ≥ 1. */
  maxEmailAttempts?: number;
  /**
   * Pre-attempt delays. Length MUST equal `maxEmailAttempts`. Defaults to
   * `DEFAULT_EMAIL_ATTEMPT_DELAYS_MS`.
   */
  emailAttemptDelaysMs?: ReadonlyArray<number>;
  /** Defaults to setTimeout-based wait. Tests inject a no-op. */
  wait?: Waiter;
  /** Date factory — overridable for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * Default real-time waiter used in production. Tests SHOULD inject a
 * synchronous waiter so the 24h retry schedule does not actually sleep.
 */
export const realWait: Waiter = (ms) =>
  new Promise<void>((resolve) => {
    if (ms <= 0) resolve();
    else setTimeout(resolve, ms);
  });

// ─── Service ─────────────────────────────────────────────────────────────────

export class NotificationService {
  private readonly emailClient: EmailClient;
  private readonly wsClient: WebSocketBroadcaster;
  private readonly maxEmailAttempts: number;
  private readonly emailAttemptDelaysMs: ReadonlyArray<number>;
  private readonly wait: Waiter;
  private readonly now: () => Date;

  constructor(opts: NotificationServiceOptions) {
    this.emailClient = opts.emailClient;
    this.wsClient = opts.wsClient;
    this.maxEmailAttempts = opts.maxEmailAttempts ?? DEFAULT_MAX_EMAIL_ATTEMPTS;
    if (!Number.isInteger(this.maxEmailAttempts) || this.maxEmailAttempts < 1) {
      throw new RangeError('maxEmailAttempts must be an integer ≥ 1');
    }
    this.emailAttemptDelaysMs =
      opts.emailAttemptDelaysMs ?? DEFAULT_EMAIL_ATTEMPT_DELAYS_MS;
    if (this.emailAttemptDelaysMs.length !== this.maxEmailAttempts) {
      throw new RangeError(
        `emailAttemptDelaysMs length (${this.emailAttemptDelaysMs.length}) must equal maxEmailAttempts (${this.maxEmailAttempts})`,
      );
    }
    if (this.emailAttemptDelaysMs.some((d) => !Number.isFinite(d) || d < 0)) {
      throw new RangeError('emailAttemptDelaysMs entries must be non-negative finite numbers');
    }
    // Req 10.8 — total retry window must not exceed 24h.
    const total = this.emailAttemptDelaysMs.reduce((a, b) => a + b, 0);
    if (total > 24 * HOUR_MS) {
      throw new RangeError(
        `emailAttemptDelaysMs sum (${total}ms) exceeds the 24h retry budget required by Req 10.8`,
      );
    }
    this.wait = opts.wait ?? realWait;
    this.now = opts.now ?? (() => new Date());
  }

  // ── Single-shot transports ────────────────────────────────────────────────

  /**
   * Single-shot email delivery. Returns a `DeliveryResult` describing the
   * outcome. Does NOT retry — callers wanting Req 10.8 retry semantics
   * should call `deliverWithRetry`.
   *
   * Recipients without an email address are short-circuited to a failed
   * result so the caller can fall back to the in-app channel.
   */
  async sendEmail(notification: OutboundNotification): Promise<DeliveryResult> {
    if (!notification.recipientEmail) {
      return {
        success: false,
        channel: 'email',
        error: 'missing recipientEmail',
      };
    }
    const outcome = await safeSend(() =>
      this.emailClient.send({
        to: notification.recipientEmail,
        subject: notification.subject,
        body: notification.body,
      }),
    );
    return {
      success: outcome.success,
      channel: 'email',
      error: outcome.success ? null : outcome.error ?? 'email delivery failed',
    };
  }

  /**
   * Single-shot in-app broadcast. The WebSocket gateway is expected to
   * dispatch to every live socket bound to `userId`.
   */
  async sendInApp(notification: OutboundNotification): Promise<DeliveryResult> {
    const result = await safeBroadcast(() =>
      this.wsClient.broadcast({
        userId: notification.userId,
        schemeId: notification.schemeId,
        type: notification.type,
        subject: notification.subject,
        body: notification.body,
        highPriority: notification.highPriority ?? false,
        payload: notification.payload ?? {},
      }),
    );
    return {
      success: result.success,
      channel: 'in_app',
      error: result.success ? null : result.error ?? 'in-app broadcast failed',
    };
  }

  // ── Retry orchestration ───────────────────────────────────────────────────

  /**
   * Deliver `notification` per the Req 10.8 retry contract:
   *   1. Attempt email up to `maxEmailAttempts` times, spaced according to
   *      `emailAttemptDelaysMs`. Stop early on the first success.
   *   2. If every email attempt failed, broadcast once via in-app as the
   *      fallback channel.
   *
   * The returned `attempts` array carries one entry per dispatched attempt
   * so callers (and audit logs) can trace exactly what happened.
   */
  async deliverWithRetry(notification: OutboundNotification): Promise<DeliveryWithRetryResult> {
    const attempts: DeliveryAttempt[] = [];

    for (let i = 0; i < this.maxEmailAttempts; i++) {
      const delay = this.emailAttemptDelaysMs[i];
      if (delay > 0) await this.wait(delay);
      const result = await this.sendEmail(notification);
      attempts.push({
        channel: 'email',
        attempt: i + 1,
        success: result.success,
        error: result.error,
        at: this.now(),
      });
      if (result.success) {
        return { finalResult: result, attempts };
      }
    }

    const fallback = await this.sendInApp(notification);
    attempts.push({
      channel: 'in_app',
      attempt: this.maxEmailAttempts + 1,
      success: fallback.success,
      error: fallback.error,
      at: this.now(),
    });
    return { finalResult: fallback, attempts };
  }
}

// ─── Internal safety wrappers ────────────────────────────────────────────────

async function safeSend(call: () => Promise<EmailSendOutcome>): Promise<EmailSendOutcome> {
  try {
    return await call();
  } catch (err) {
    return { messageId: null, success: false, error: errorMessage(err) };
  }
}

async function safeBroadcast(
  call: () => Promise<boolean>,
): Promise<{ success: boolean; error: string | null }> {
  try {
    const ok = await call();
    return { success: !!ok, error: ok ? null : 'broadcast returned false' };
  } catch (err) {
    return { success: false, error: errorMessage(err) };
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// ─── Default fallback transports ─────────────────────────────────────────────

/**
 * No-op email client used when the factory was not given one. Logs a
 * warning so production deployments cannot silently lose mail. Tests should
 * always inject explicit mocks; this exists so local dev doesn't crash.
 */
export function createLoggingEmailClient(): EmailClient {
  return {
    async send(req) {
      // eslint-disable-next-line no-console
      console.warn(
        '[NotificationService] no EmailClient configured; dropping email',
        req.subject,
      );
      return { messageId: null, success: false, error: 'no email client configured' };
    },
  };
}

/** No-op WebSocket broadcaster — pairs with `createLoggingEmailClient`. */
export function createLoggingWsClient(): WebSocketBroadcaster {
  return {
    async broadcast(msg) {
      // eslint-disable-next-line no-console
      console.warn(
        '[NotificationService] no WebSocketBroadcaster configured; dropping in-app',
        msg.subject,
      );
      return false;
    },
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export interface CreateNotificationServiceOptions extends Partial<NotificationServiceOptions> {}

/**
 * Factory exposed to the rest of the app. Allows partial DI: pass any
 * subset of `emailClient`, `wsClient`, `wait`, `now`, etc. Anything left
 * unset falls back to a sensible default (no-op transports for missing
 * clients, real-time waiter, real Date).
 */
export function createNotificationService(
  opts: CreateNotificationServiceOptions = {},
): NotificationService {
  return new NotificationService({
    emailClient: opts.emailClient ?? createLoggingEmailClient(),
    wsClient: opts.wsClient ?? createLoggingWsClient(),
    maxEmailAttempts: opts.maxEmailAttempts,
    emailAttemptDelaysMs: opts.emailAttemptDelaysMs,
    wait: opts.wait,
    now: opts.now,
  });
}
