/**
 * Unit tests for the WebSocket notification client.
 *
 * Uses a mock WebSocket implementation to verify connection management,
 * auto-reconnect with exponential backoff, and message handling.
 *
 * Validates: Requirements 10.6 (in-app notification delivery via WebSocket).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NotificationWebSocket,
  getNotificationClient,
  resetNotificationClient,
  type NotificationPayload,
} from './notifications';

// ─── Mock WebSocket ──────────────────────────────────────────────────────────

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  /** Captured `send()` calls so tests can assert the auth handshake. */
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose(new Event('close') as unknown as CloseEvent);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  // Helpers for tests to simulate server behavior
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) this.onopen(new Event('open'));
  }

  simulateMessage(data: unknown): void {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) } as unknown as MessageEvent);
    }
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose(new Event('close') as unknown as CloseEvent);
  }

  simulateError(): void {
    if (this.onerror) this.onerror(new Event('error'));
  }
}

let instances: MockWebSocket[] = [];

beforeEach(() => {
  instances = [];
  vi.useFakeTimers();
  (globalThis as unknown as Record<string, unknown>).WebSocket = MockWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
  resetNotificationClient();
  delete (globalThis as unknown as Record<string, unknown>).WebSocket;
});

describe('NotificationWebSocket', () => {
  describe('connection', () => {
    it('connects to the WebSocket server', () => {
      const ws = new NotificationWebSocket({ url: 'ws://localhost:4000/ws/notifications' });
      ws.connect();
      expect(instances).toHaveLength(1);
      expect(instances[0].url).toBe('ws://localhost:4000/ws/notifications');
    });

    it('sends the auth token as a post-open message, not in the URL', () => {
      const ws = new NotificationWebSocket({
        url: 'ws://localhost:4000/ws/notifications',
        authToken: 'my-token',
      });
      ws.connect();
      // Token must NOT appear in the URL — that would leak into proxy logs.
      expect(instances[0].url).toBe('ws://localhost:4000/ws/notifications');
      expect(instances[0].sent).toHaveLength(0);
      // Once the socket opens, the client immediately sends an auth frame.
      instances[0].simulateOpen();
      expect(instances[0].sent).toHaveLength(1);
      expect(JSON.parse(instances[0].sent[0])).toEqual({ type: 'auth', token: 'my-token' });
    });

    it('emits connected status on open', () => {
      const ws = new NotificationWebSocket({ url: 'ws://test/ws' });
      const handler = vi.fn();
      ws.onConnectionChange(handler);
      ws.connect();
      instances[0].simulateOpen();
      expect(handler).toHaveBeenCalledWith('connected');
    });

    it('reports isConnected correctly', () => {
      const ws = new NotificationWebSocket({ url: 'ws://test/ws' });
      ws.connect();
      expect(ws.isConnected).toBe(false);
      instances[0].simulateOpen();
      expect(ws.isConnected).toBe(true);
    });
  });

  describe('message handling', () => {
    it('dispatches parsed notification to handlers', () => {
      const ws = new NotificationWebSocket({ url: 'ws://test/ws' });
      const handler = vi.fn();
      ws.onNotification(handler);
      ws.connect();
      instances[0].simulateOpen();

      const notification: NotificationPayload = {
        id: 'n-1',
        type: 'deadline_reminder',
        title: 'Deadline approaching',
        message: 'PM Kisan deadline in 7 days',
        schemeId: 's-1',
        schemeName: 'PM Kisan',
        priority: 'normal',
        timestamp: '2025-01-15T10:00:00Z',
      };

      instances[0].simulateMessage(notification);
      expect(handler).toHaveBeenCalledWith(notification);
    });

    it('ignores malformed messages', () => {
      const ws = new NotificationWebSocket({ url: 'ws://test/ws' });
      const handler = vi.fn();
      ws.onNotification(handler);
      ws.connect();
      instances[0].simulateOpen();

      // Send invalid JSON
      if (instances[0].onmessage) {
        instances[0].onmessage({ data: 'not-json{{{' } as unknown as MessageEvent);
      }
      expect(handler).not.toHaveBeenCalled();
    });

    it('allows unsubscribing from notifications', () => {
      const ws = new NotificationWebSocket({ url: 'ws://test/ws' });
      const handler = vi.fn();
      const unsubscribe = ws.onNotification(handler);
      ws.connect();
      instances[0].simulateOpen();

      unsubscribe();
      instances[0].simulateMessage({ id: 'n-1', type: 'system', title: 'x', message: 'y', priority: 'normal', timestamp: '' });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('auto-reconnect', () => {
    it('attempts reconnection on disconnect with exponential backoff', () => {
      const ws = new NotificationWebSocket({
        url: 'ws://test/ws',
        maxReconnectAttempts: 3,
        initialReconnectDelay: 100,
      });
      const handler = vi.fn();
      ws.onConnectionChange(handler);
      ws.connect();
      instances[0].simulateOpen();

      // Simulate disconnect
      instances[0].simulateClose();
      expect(handler).toHaveBeenCalledWith('disconnected');
      expect(handler).toHaveBeenCalledWith('reconnecting');

      // After first delay (100ms * 2^0 = 100ms + jitter)
      vi.advanceTimersByTime(200);
      expect(instances).toHaveLength(2); // New connection attempt
    });

    it('stops reconnecting after max attempts', () => {
      const ws = new NotificationWebSocket({
        url: 'ws://test/ws',
        maxReconnectAttempts: 2,
        initialReconnectDelay: 50,
      });
      ws.connect();

      // Disconnect three times
      instances[0].simulateClose();
      vi.advanceTimersByTime(100);
      instances[1].simulateClose();
      vi.advanceTimersByTime(200);

      // After 2 attempts, no more reconnections should be scheduled
      const countAfter2 = instances.length;
      vi.advanceTimersByTime(10000);
      expect(instances.length).toBe(countAfter2);
    });

    it('resets reconnect attempts after successful connection', () => {
      const ws = new NotificationWebSocket({
        url: 'ws://test/ws',
        maxReconnectAttempts: 5,
        initialReconnectDelay: 50,
      });
      ws.connect();
      instances[0].simulateClose();
      vi.advanceTimersByTime(100);

      // Second instance connects successfully
      instances[1].simulateOpen();
      expect(ws.currentReconnectAttempts).toBe(0);
    });
  });

  describe('disconnect', () => {
    it('closes the connection and does not reconnect', () => {
      const ws = new NotificationWebSocket({ url: 'ws://test/ws' });
      ws.connect();
      instances[0].simulateOpen();

      ws.disconnect();
      expect(ws.isConnected).toBe(false);

      // No reconnect attempts
      vi.advanceTimersByTime(60000);
      expect(instances).toHaveLength(1);
    });
  });

  describe('setAuthToken', () => {
    it('reconnects with the new token when currently connected', () => {
      const ws = new NotificationWebSocket({ url: 'ws://test/ws', authToken: 'old-token' });
      ws.connect();
      instances[0].simulateOpen();

      ws.setAuthToken('new-token');
      // Old socket should close (triggering reconnect with new token)
      vi.advanceTimersByTime(2000);
      const lastInstance = instances[instances.length - 1];
      // New socket opens with the same URL (no token in URL).
      expect(lastInstance.url).toBe('ws://test/ws');
      lastInstance.simulateOpen();
      // Auth frame on the new socket carries the rotated token.
      expect(JSON.parse(lastInstance.sent[0])).toEqual({ type: 'auth', token: 'new-token' });
    });
  });
});

describe('getNotificationClient', () => {
  it('returns the same singleton instance on repeated calls', () => {
    const a = getNotificationClient({ url: 'ws://test/ws' });
    const b = getNotificationClient({ url: 'ws://test/ws' });
    expect(a).toBe(b);
  });

  it('resets when resetNotificationClient is called', () => {
    const a = getNotificationClient({ url: 'ws://test/ws' });
    resetNotificationClient();
    const b = getNotificationClient({ url: 'ws://test/ws' });
    expect(a).not.toBe(b);
  });
});
