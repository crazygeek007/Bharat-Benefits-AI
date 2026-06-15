/**
 * Unit tests for NotificationService.
 *
 * Validates: Requirements 10.6, 10.8.
 *
 * Covers:
 *   - sendEmail returns success when transport reports success.
 *   - sendEmail surfaces transport-thrown errors as a failed DeliveryResult.
 *   - sendEmail short-circuits when recipientEmail is empty.
 *   - sendInApp delegates to the broadcaster and reports success/failure.
 *   - deliverWithRetry tries email up to 3 times, then falls back to in-app.
 *   - deliverWithRetry stops retrying as soon as email succeeds.
 *   - Configuration guards: bad maxEmailAttempts, mismatched delays length,
 *     total delay budget exceeding 24h all throw on construction.
 *   - createNotificationService factory wires defaults when called without args.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_EMAIL_ATTEMPT_DELAYS_MS,
  DEFAULT_MAX_EMAIL_ATTEMPTS,
  NotificationService,
  createNotificationService,
  type EmailClient,
  type OutboundNotification,
  type WebSocketBroadcaster,
} from './notification-service';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeNotification(
  overrides: Partial<OutboundNotification> = {},
): OutboundNotification {
  return {
    userId: 'user-1',
    schemeId: 'scheme-1',
    type: 'deadline',
    recipientEmail: 'user@example.com',
    subject: 'Deadline reminder',
    body: 'Body',
    highPriority: false,
    payload: {},
    ...overrides,
  };
}

function fakeEmailClient(
  outcomes: Array<{ success: boolean; error?: string | null } | Error>,
): EmailClient & { calls: number } {
  let i = 0;
  const client: EmailClient & { calls: number } = {
    calls: 0,
    async send() {
      client.calls++;
      const next = outcomes[Math.min(i, outcomes.length - 1)];
      i++;
      if (next instanceof Error) throw next;
      return {
        messageId: next.success ? 'msg-' + i : null,
        success: next.success,
        error: next.error ?? null,
      };
    },
  };
  return client;
}

function fakeWsClient(
  outcomes: Array<boolean | Error>,
): WebSocketBroadcaster & { calls: number } {
  let i = 0;
  const client: WebSocketBroadcaster & { calls: number } = {
    calls: 0,
    async broadcast() {
      client.calls++;
      const next = outcomes[Math.min(i, outcomes.length - 1)];
      i++;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return client;
}

const noWait = async () => undefined;

// ─── sendEmail ───────────────────────────────────────────────────────────────

describe('NotificationService.sendEmail', () => {
  it('returns a successful DeliveryResult when the transport succeeds', async () => {
    const email = fakeEmailClient([{ success: true }]);
    const ws = fakeWsClient([true]);
    const svc = new NotificationService({ emailClient: email, wsClient: ws, wait: noWait });

    const res = await svc.sendEmail(makeNotification());

    expect(res).toEqual({ success: true, channel: 'email', error: null });
    expect(email.calls).toBe(1);
  });

  it('returns a failed DeliveryResult when the transport reports failure', async () => {
    const email = fakeEmailClient([{ success: false, error: 'ses-throttled' }]);
    const ws = fakeWsClient([true]);
    const svc = new NotificationService({ emailClient: email, wsClient: ws, wait: noWait });

    const res = await svc.sendEmail(makeNotification());

    expect(res).toEqual({ success: false, channel: 'email', error: 'ses-throttled' });
  });

  it('surfaces thrown transport errors as a failed DeliveryResult', async () => {
    const email = fakeEmailClient([new Error('boom')]);
    const ws = fakeWsClient([true]);
    const svc = new NotificationService({ emailClient: email, wsClient: ws, wait: noWait });

    const res = await svc.sendEmail(makeNotification());

    expect(res.success).toBe(false);
    expect(res.channel).toBe('email');
    expect(res.error).toContain('boom');
  });

  it('short-circuits with an error when recipientEmail is empty', async () => {
    const email = fakeEmailClient([{ success: true }]);
    const ws = fakeWsClient([true]);
    const svc = new NotificationService({ emailClient: email, wsClient: ws, wait: noWait });

    const res = await svc.sendEmail(makeNotification({ recipientEmail: '' }));

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/missing recipientEmail/);
    expect(email.calls).toBe(0);
  });
});

// ─── sendInApp ───────────────────────────────────────────────────────────────

describe('NotificationService.sendInApp', () => {
  it('reports success when the broadcaster returns true', async () => {
    const email = fakeEmailClient([{ success: false }]);
    const ws = fakeWsClient([true]);
    const svc = new NotificationService({ emailClient: email, wsClient: ws, wait: noWait });

    const res = await svc.sendInApp(makeNotification({ highPriority: true }));

    expect(res).toEqual({ success: true, channel: 'in_app', error: null });
    expect(ws.calls).toBe(1);
  });

  it('reports failure when the broadcaster returns false', async () => {
    const email = fakeEmailClient([{ success: false }]);
    const ws = fakeWsClient([false]);
    const svc = new NotificationService({ emailClient: email, wsClient: ws, wait: noWait });

    const res = await svc.sendInApp(makeNotification());

    expect(res.success).toBe(false);
    expect(res.channel).toBe('in_app');
  });

  it('surfaces thrown broadcaster errors as a failed DeliveryResult', async () => {
    const email = fakeEmailClient([{ success: false }]);
    const ws = fakeWsClient([new Error('socket closed')]);
    const svc = new NotificationService({ emailClient: email, wsClient: ws, wait: noWait });

    const res = await svc.sendInApp(makeNotification());

    expect(res.success).toBe(false);
    expect(res.error).toContain('socket closed');
  });
});

// ─── deliverWithRetry ────────────────────────────────────────────────────────

describe('NotificationService.deliverWithRetry', () => {
  it('returns immediately on first email success without invoking in-app', async () => {
    const email = fakeEmailClient([{ success: true }]);
    const ws = fakeWsClient([true]);
    const svc = new NotificationService({ emailClient: email, wsClient: ws, wait: noWait });

    const result = await svc.deliverWithRetry(makeNotification());

    expect(result.finalResult.success).toBe(true);
    expect(result.finalResult.channel).toBe('email');
    expect(result.attempts).toHaveLength(1);
    expect(email.calls).toBe(1);
    expect(ws.calls).toBe(0);
  });

  it('retries email up to 3 times then falls back to in-app (Req 10.8)', async () => {
    const email = fakeEmailClient([
      { success: false, error: 'fail-1' },
      { success: false, error: 'fail-2' },
      { success: false, error: 'fail-3' },
    ]);
    const ws = fakeWsClient([true]);
    const svc = new NotificationService({ emailClient: email, wsClient: ws, wait: noWait });

    const result = await svc.deliverWithRetry(makeNotification());

    expect(email.calls).toBe(3);
    expect(ws.calls).toBe(1);
    expect(result.attempts.map((a) => a.channel)).toEqual([
      'email',
      'email',
      'email',
      'in_app',
    ]);
    expect(result.finalResult.success).toBe(true);
    expect(result.finalResult.channel).toBe('in_app');
  });

  it('reports the in-app fallback failure when both channels fail', async () => {
    const email = fakeEmailClient([
      { success: false, error: 'fail-1' },
      { success: false, error: 'fail-2' },
      { success: false, error: 'fail-3' },
    ]);
    const ws = fakeWsClient([false]);
    const svc = new NotificationService({ emailClient: email, wsClient: ws, wait: noWait });

    const result = await svc.deliverWithRetry(makeNotification());

    expect(result.finalResult.success).toBe(false);
    expect(result.finalResult.channel).toBe('in_app');
    expect(result.attempts).toHaveLength(4);
  });

  it('observes the configured wait between email attempts', async () => {
    const wait = vi.fn(async (_ms: number) => undefined);
    const email = fakeEmailClient([
      { success: false, error: 'fail-1' },
      { success: true },
    ]);
    const ws = fakeWsClient([true]);
    const svc = new NotificationService({
      emailClient: email,
      wsClient: ws,
      wait,
      maxEmailAttempts: 2,
      emailAttemptDelaysMs: [0, 1000],
    });

    const result = await svc.deliverWithRetry(makeNotification());

    expect(result.finalResult.success).toBe(true);
    // First call has delay 0 — skipped; second attempt waits 1000ms.
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(1000);
  });
});

// ─── Construction guards ─────────────────────────────────────────────────────

describe('NotificationService construction', () => {
  const email = fakeEmailClient([{ success: true }]);
  const ws = fakeWsClient([true]);

  it('rejects maxEmailAttempts < 1', () => {
    expect(
      () =>
        new NotificationService({
          emailClient: email,
          wsClient: ws,
          maxEmailAttempts: 0,
          emailAttemptDelaysMs: [],
          wait: noWait,
        }),
    ).toThrow(RangeError);
  });

  it('rejects when emailAttemptDelaysMs length mismatches maxEmailAttempts', () => {
    expect(
      () =>
        new NotificationService({
          emailClient: email,
          wsClient: ws,
          maxEmailAttempts: 3,
          emailAttemptDelaysMs: [0, 1000],
          wait: noWait,
        }),
    ).toThrow(/length/);
  });

  it('rejects when total delay budget exceeds 24h (Req 10.8)', () => {
    expect(
      () =>
        new NotificationService({
          emailClient: email,
          wsClient: ws,
          maxEmailAttempts: 2,
          emailAttemptDelaysMs: [0, 25 * 60 * 60 * 1000],
          wait: noWait,
        }),
    ).toThrow(/24h/);
  });

  it('default config matches the documented constants', () => {
    expect(DEFAULT_MAX_EMAIL_ATTEMPTS).toBe(3);
    expect(DEFAULT_EMAIL_ATTEMPT_DELAYS_MS).toHaveLength(3);
    const total = DEFAULT_EMAIL_ATTEMPT_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

// ─── Factory ─────────────────────────────────────────────────────────────────

describe('createNotificationService', () => {
  it('returns a service that does not throw when called without transports', async () => {
    // Inject `wait: noWait` so the default 24h retry schedule does not
    // actually sleep. Default no-op transports both fail; the service should
    // still resolve to a result and log warnings to console.
    const svc = createNotificationService({ wait: noWait });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await svc.deliverWithRetry(makeNotification());

    warnSpy.mockRestore();
    expect(result.attempts.length).toBeGreaterThan(0);
    expect(result.finalResult.success).toBe(false);
  });

  it('respects injected dependencies', async () => {
    const email = fakeEmailClient([{ success: true }]);
    const ws = fakeWsClient([true]);
    const svc = createNotificationService({
      emailClient: email,
      wsClient: ws,
      wait: noWait,
    });

    const res = await svc.sendEmail(makeNotification());
    expect(res.success).toBe(true);
    expect(email.calls).toBe(1);
  });
});
