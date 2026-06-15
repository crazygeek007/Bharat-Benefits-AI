/**
 * Unit tests for DeadlineTracker.
 *
 * Validates: Requirements 10.2, 10.3, 10.4, 10.5, 10.7.
 *
 * Covers:
 *   - daysUntilDeadline / hoursUntilDeadline arithmetic + null deadline.
 *   - shouldSendNotification: 7-day, 24h, 6h triggers + rolling-window
 *     exclusion (Req 10.7) + past-deadline exclusion.
 *   - getDeadlinesWithinWindow: 90-day window honoured, rolling schemes
 *     excluded, past deadlines excluded.
 *   - checkDeadlines dispatches the correct trigger via the injected
 *     NotificationService and respects `hasNotified` idempotency.
 *   - notifyDeadlineChange embeds the previous & new deadline in the
 *     payload (Req 10.5).
 */

import { describe, it, expect, vi } from 'vitest';
import type { SavedScheme, Scheme } from '@bharat-benefits/shared';
import {
  DeadlineTracker,
  daysUntilDeadline,
  hoursUntilDeadline,
  getDeadlinesWithinWindow,
  shouldSendNotification,
  type SavedSchemeWithScheme,
} from './deadline-tracker';
import type {
  EmailClient,
  NotificationService,
  WebSocketBroadcaster,
} from '../notifications/notification-service';
import { NotificationService as RealNotificationService } from '../notifications/notification-service';

// ─── Test helpers ────────────────────────────────────────────────────────────

const NOW = new Date('2025-01-15T12:00:00.000Z');

function makeScheme(overrides: Partial<Scheme> = {}): Scheme {
  return {
    id: 'scheme-1',
    name: 'PM Kisan',
    description: 'Income support scheme',
    ministry: 'Ministry of Agriculture',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://example.gov.in/pm-kisan',
    benefitType: 'monetary',
    benefitAmount: 6000,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: 'https://example.gov.in/apply',
    eligibilityCriteria: [],
    benefits: [],
    applicationSteps: null,
    requiredDocuments: null,
    trustScore: 90,
    verified: true,
    discoveredAt: NOW,
    lastVerifiedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSaved(overrides: Partial<SavedScheme> = {}): SavedScheme {
  return {
    id: 'saved-1',
    userId: 'user-1',
    schemeId: 'scheme-1',
    status: 'Saved',
    savedAt: NOW,
    appliedAt: null,
    ...overrides,
  };
}

function fakeEmail(success = true): EmailClient & { calls: number } {
  const c: EmailClient & { calls: number } = {
    calls: 0,
    async send() {
      c.calls++;
      return { messageId: success ? 'm' : null, success, error: success ? null : 'fail' };
    },
  };
  return c;
}

function fakeWs(success = true): WebSocketBroadcaster & {
  calls: number;
  lastMessage: unknown;
} {
  const c: WebSocketBroadcaster & { calls: number; lastMessage: unknown } = {
    calls: 0,
    lastMessage: null,
    async broadcast(msg) {
      c.calls++;
      c.lastMessage = msg;
      return success;
    },
  };
  return c;
}

function buildService(emailOk = true, wsOk = true): {
  service: NotificationService;
  email: { calls: number };
  ws: { calls: number; lastMessage: unknown };
} {
  const email = fakeEmail(emailOk);
  const ws = fakeWs(wsOk);
  const service = new RealNotificationService({
    emailClient: email,
    wsClient: ws,
    wait: async () => undefined,
  });
  return { service, email, ws };
}

// ─── daysUntilDeadline / hoursUntilDeadline ─────────────────────────────────

describe('daysUntilDeadline', () => {
  it('returns whole-day diff for a future deadline', () => {
    const d = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(daysUntilDeadline(d, NOW)).toBe(7);
  });

  it('returns negative for past deadlines', () => {
    const d = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    expect(daysUntilDeadline(d, NOW)).toBe(-1);
  });

  it('returns null for null deadline (rolling schemes per Req 10.7)', () => {
    expect(daysUntilDeadline(null, NOW)).toBeNull();
  });

  it('floors fractional days down', () => {
    // 7 days minus 1 ms — still "6" not "7" because the threshold has not
    // fully elapsed.
    const d = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
    expect(daysUntilDeadline(d, NOW)).toBe(6);
  });
});

describe('hoursUntilDeadline', () => {
  it('returns whole-hour diff', () => {
    const d = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(hoursUntilDeadline(d, NOW)).toBe(24);
  });

  it('returns null for null deadline', () => {
    expect(hoursUntilDeadline(null, NOW)).toBeNull();
  });
});

// ─── shouldSendNotification ─────────────────────────────────────────────────

describe('shouldSendNotification', () => {
  const window = 60 * 60 * 1000; // default high-priority window

  it('returns null for rolling schemes (Req 10.7)', () => {
    expect(shouldSendNotification(null, NOW)).toBeNull();
  });

  it('returns null for past deadlines (no notification after expiry)', () => {
    const past = new Date(NOW.getTime() - 1);
    expect(shouldSendNotification(past, NOW)).toBeNull();
  });

  it('returns null for deadlines more than 7 days away', () => {
    const far = new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(shouldSendNotification(far, NOW)).toBeNull();
  });

  it('returns "7d" for deadlines well inside the 7-day band but more than 24h out', () => {
    const five = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000);
    expect(shouldSendNotification(five, NOW)).toBe('7d');
  });

  it('returns "24h" near the 24h mark (Req 10.3)', () => {
    const twentyFour = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(shouldSendNotification(twentyFour, NOW)).toBe('24h');
    // Inside the ±window tolerance — still 24h.
    const twentyFourMinus30m = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 - 30 * 60 * 1000);
    expect(shouldSendNotification(twentyFourMinus30m, NOW)).toBe('24h');
  });

  it('returns "6h" near the 6h mark (Req 10.3)', () => {
    const sixHours = new Date(NOW.getTime() + 6 * 60 * 60 * 1000);
    expect(shouldSendNotification(sixHours, NOW)).toBe('6h');
  });

  it('honours the highPriorityWindowMs override', () => {
    // A deadline 23h30m out is well inside the default ±1h window and
    // therefore reports as '24h'. Tighten the window to ±1s and the same
    // input falls between the 24h and 6h bands — no trigger this tick.
    const offset = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 - 30 * 60 * 1000);
    expect(shouldSendNotification(offset, NOW)).toBe('24h');
    expect(shouldSendNotification(offset, NOW, { highPriorityWindowMs: 1000 })).toBeNull();
  });
});

// ─── getDeadlinesWithinWindow ───────────────────────────────────────────────

describe('getDeadlinesWithinWindow (Req 10.4)', () => {
  function entry(deadline: Date | null, id: string): SavedSchemeWithScheme {
    return {
      saved: makeSaved({ id, schemeId: id }),
      scheme: makeScheme({ id, deadline }),
    };
  }

  it('includes deadlines within the window', () => {
    const e1 = entry(new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000), 's1');
    const e2 = entry(new Date(NOW.getTime() + 89 * 24 * 60 * 60 * 1000), 's2');
    const result = getDeadlinesWithinWindow([e1, e2], 90, NOW);
    expect(result).toHaveLength(2);
  });

  it('excludes deadlines beyond the window', () => {
    const e = entry(new Date(NOW.getTime() + 91 * 24 * 60 * 60 * 1000), 's1');
    expect(getDeadlinesWithinWindow([e], 90, NOW)).toEqual([]);
  });

  it('excludes rolling schemes (deadline === null) per Req 10.7', () => {
    const e = entry(null, 's1');
    expect(getDeadlinesWithinWindow([e], 90, NOW)).toEqual([]);
  });

  it('excludes past deadlines', () => {
    const e = entry(new Date(NOW.getTime() - 24 * 60 * 60 * 1000), 's1');
    expect(getDeadlinesWithinWindow([e], 90, NOW)).toEqual([]);
  });

  it('includes the boundary at exactly `days` away', () => {
    const e = entry(new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1000), 's1');
    expect(getDeadlinesWithinWindow([e], 90, NOW)).toHaveLength(1);
  });

  it('returns empty array for negative or non-finite days', () => {
    const e = entry(new Date(NOW.getTime() + 24 * 60 * 60 * 1000), 's1');
    expect(getDeadlinesWithinWindow([e], -1, NOW)).toEqual([]);
    expect(getDeadlinesWithinWindow([e], Number.NaN, NOW)).toEqual([]);
  });
});

// ─── DeadlineTracker.checkDeadlines ─────────────────────────────────────────

describe('DeadlineTracker.checkDeadlines', () => {
  it('skips rolling-window schemes (Req 10.7)', async () => {
    const { service, email, ws } = buildService();
    const tracker = new DeadlineTracker({ notificationService: service });
    const entries: SavedSchemeWithScheme[] = [
      { saved: makeSaved(), scheme: makeScheme({ deadline: null }) },
    ];

    const results = await tracker.checkDeadlines(entries, NOW);

    expect(results).toHaveLength(1);
    expect(results[0]?.notified).toBe(false);
    expect(results[0]?.trigger).toBeNull();
    expect(email.calls).toBe(0);
    expect(ws.calls).toBe(0);
  });

  it('dispatches a 7d trigger via deliverWithRetry (Req 10.2, 10.6)', async () => {
    const { service, email } = buildService();
    const tracker = new DeadlineTracker({ notificationService: service });
    const fiveDaysOut = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000);
    const entries: SavedSchemeWithScheme[] = [
      {
        saved: makeSaved(),
        scheme: makeScheme({ deadline: fiveDaysOut }),
      },
    ];

    const results = await tracker.checkDeadlines(entries, NOW, () => 'user@example.com');

    expect(results[0]?.notified).toBe(true);
    expect(results[0]?.trigger).toBe('7d');
    expect(email.calls).toBe(1);
    expect(results[0]?.delivery?.finalResult.success).toBe(true);
  });

  it('marks 24h and 6h triggers high priority (Req 10.3)', async () => {
    const { service, email, ws } = buildService();
    const tracker = new DeadlineTracker({ notificationService: service });
    const twentyFour = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const sixHours = new Date(NOW.getTime() + 6 * 60 * 60 * 1000);
    const entries: SavedSchemeWithScheme[] = [
      {
        saved: makeSaved({ id: 'a', userId: 'user-a' }),
        scheme: makeScheme({ id: 'sch-a', deadline: twentyFour }),
      },
      {
        saved: makeSaved({ id: 'b', userId: 'user-b' }),
        scheme: makeScheme({ id: 'sch-b', deadline: sixHours }),
      },
    ];

    const results = await tracker.checkDeadlines(entries, NOW, () => 'u@example.com');

    expect(results[0]?.trigger).toBe('24h');
    expect(results[1]?.trigger).toBe('6h');
    expect(email.calls).toBe(2);
    expect(ws.calls).toBe(0);
  });

  it('respects hasNotified to avoid duplicate dispatches', async () => {
    const { service, email } = buildService();
    // vitest 1.6's Mock generic is `Mock<TArgs extends any[], TReturn>`,
    // i.e. the first parameter is the args tuple — not the function type.
    const hasNotified = vi
      .fn<[args: { trigger: string }], boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const recordNotification = vi.fn(async () => undefined);
    const tracker = new DeadlineTracker({
      notificationService: service,
      hasNotified: hasNotified as unknown as ConstructorParameters<typeof DeadlineTracker>[0]['hasNotified'],
      recordNotification: recordNotification as unknown as ConstructorParameters<typeof DeadlineTracker>[0]['recordNotification'],
    });
    const fiveDaysOut = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000);
    const entries: SavedSchemeWithScheme[] = [
      {
        saved: makeSaved({ id: 'a', userId: 'user-a' }),
        scheme: makeScheme({ id: 'sch-a', deadline: fiveDaysOut }),
      },
      {
        saved: makeSaved({ id: 'b', userId: 'user-b' }),
        scheme: makeScheme({ id: 'sch-b', deadline: fiveDaysOut }),
      },
    ];

    const results = await tracker.checkDeadlines(entries, NOW, () => 'u@example.com');

    // First entry skipped because hasNotified returned true; second sent.
    expect(results[0]?.notified).toBe(false);
    expect(results[0]?.trigger).toBe('7d');
    expect(results[1]?.notified).toBe(true);
    expect(email.calls).toBe(1);
    expect(recordNotification).toHaveBeenCalledTimes(1);
  });

  it('falls back to in-app when every email retry fails (Req 10.8)', async () => {
    const { service, email, ws } = buildService(false, true);
    const tracker = new DeadlineTracker({ notificationService: service });
    const fiveDaysOut = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000);
    const entries: SavedSchemeWithScheme[] = [
      {
        saved: makeSaved(),
        scheme: makeScheme({ deadline: fiveDaysOut }),
      },
    ];

    const results = await tracker.checkDeadlines(entries, NOW, () => 'u@example.com');

    expect(email.calls).toBe(3);
    expect(ws.calls).toBe(1);
    expect(results[0]?.delivery?.finalResult.channel).toBe('in_app');
    expect(results[0]?.delivery?.finalResult.success).toBe(true);
  });
});

// ─── DeadlineTracker.getDeadlinesWithinWindow ───────────────────────────────

describe('DeadlineTracker.getDeadlinesWithinWindow', () => {
  it('defaults to a 90-day window (Req 10.4)', () => {
    const { service } = buildService();
    const tracker = new DeadlineTracker({ notificationService: service });
    const within = new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000);
    const beyond = new Date(NOW.getTime() + 100 * 24 * 60 * 60 * 1000);
    const entries: SavedSchemeWithScheme[] = [
      { saved: makeSaved({ id: 'a' }), scheme: makeScheme({ id: 'sch-a', deadline: within }) },
      { saved: makeSaved({ id: 'b' }), scheme: makeScheme({ id: 'sch-b', deadline: beyond }) },
    ];

    const filtered = tracker.getDeadlinesWithinWindow(entries, undefined, NOW);

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.scheme.id).toBe('sch-a');
  });
});

// ─── DeadlineTracker.notifyDeadlineChange ───────────────────────────────────

describe('DeadlineTracker.notifyDeadlineChange (Req 10.5)', () => {
  it('embeds previous and new deadlines in the dispatched payload', async () => {
    const { service, email } = buildService();
    const tracker = new DeadlineTracker({ notificationService: service });
    // Capture the payload by spying on the underlying email client.
    const sendSpy = vi.spyOn(service, 'sendEmail');

    const prev = new Date('2025-02-01T00:00:00.000Z');
    const next = new Date('2025-03-01T00:00:00.000Z');
    const result = await tracker.notifyDeadlineChange(
      'user-1',
      makeScheme(),
      prev,
      next,
      'u@example.com',
    );

    expect(result.finalResult.success).toBe(true);
    expect(email.calls).toBe(1);
    expect(sendSpy).toHaveBeenCalled();
    const call = sendSpy.mock.calls[0]?.[0];
    expect(call?.body).toContain(prev.toISOString());
    expect(call?.body).toContain(next.toISOString());
    expect(call?.payload).toMatchObject({
      previousDeadline: prev.toISOString(),
      newDeadline: next.toISOString(),
    });
  });

  it('reports "Open / No Deadline" for null sides of the change', async () => {
    const { service } = buildService();
    const tracker = new DeadlineTracker({ notificationService: service });
    const sendSpy = vi.spyOn(service, 'sendEmail');

    await tracker.notifyDeadlineChange(
      'user-1',
      makeScheme(),
      null,
      new Date('2025-03-01T00:00:00.000Z'),
      'u@example.com',
    );

    const call = sendSpy.mock.calls[0]?.[0];
    expect(call?.body).toContain('Open / No Deadline');
  });
});
