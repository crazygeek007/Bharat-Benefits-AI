/**
 * WebSocket client for real-time in-app notifications.
 *
 * Establishes a persistent WebSocket connection to the backend notification
 * service. Implements auto-reconnect with exponential backoff on disconnect.
 *
 * Validates: Requirements 10.6 (in-app notification delivery via WebSocket).
 */

export type NotificationType =
  | 'deadline_reminder'
  | 'deadline_change'
  | 'scheme_change'
  | 'scheme_reopening'
  | 'missed_benefit'
  | 'system';

export interface NotificationPayload {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  schemeId?: string;
  schemeName?: string;
  priority: 'normal' | 'high';
  timestamp: string;
  data?: Record<string, unknown>;
}

export type NotificationHandler = (notification: NotificationPayload) => void;
export type ConnectionHandler = (status: 'connected' | 'disconnected' | 'reconnecting') => void;

export interface WebSocketClientOptions {
  /** Backend WebSocket URL (default: derived from NEXT_PUBLIC_BACKEND_URL). */
  url?: string;
  /** Maximum reconnection attempts before giving up (default: 10). */
  maxReconnectAttempts?: number;
  /** Initial reconnect delay in ms (default: 1000). */
  initialReconnectDelay?: number;
  /** Max reconnect delay in ms (default: 30000). */
  maxReconnectDelay?: number;
  /** Auth token to send on connection. */
  authToken?: string;
}

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_INITIAL_RECONNECT_DELAY = 1000;
const DEFAULT_MAX_RECONNECT_DELAY = 30_000;

function getDefaultWsUrl(): string {
  const backendUrl =
    (typeof window !== 'undefined'
      ? (window as unknown as Record<string, unknown>).__NEXT_PUBLIC_BACKEND_URL__
      : undefined) as string | undefined ??
    process.env.NEXT_PUBLIC_BACKEND_URL ??
    'http://localhost:4000';

  // Convert http(s) to ws(s)
  return backendUrl.replace(/^http/, 'ws') + '/ws/notifications';
}

export class NotificationWebSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private authToken: string | undefined;
  private maxReconnectAttempts: number;
  private initialReconnectDelay: number;
  private maxReconnectDelay: number;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private handlers: NotificationHandler[] = [];
  private connectionHandlers: ConnectionHandler[] = [];

  constructor(options: WebSocketClientOptions = {}) {
    this.url = options.url ?? getDefaultWsUrl();
    this.authToken = options.authToken;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.initialReconnectDelay = options.initialReconnectDelay ?? DEFAULT_INITIAL_RECONNECT_DELAY;
    this.maxReconnectDelay = options.maxReconnectDelay ?? DEFAULT_MAX_RECONNECT_DELAY;
  }

  /** Connect to the WebSocket server. */
  connect(): void {
    if (typeof WebSocket === 'undefined') return; // SSR guard
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.intentionalClose = false;
    // Auth token is NEVER appended to the URL — query strings leak into
    // proxy access logs, browser history, and Referer headers. Instead we
    // send a `{ type: 'auth', token }` frame as the very first message
    // after the socket opens. The server is expected to validate the
    // token and either keep the connection or close with code 4401.
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      // Send the auth handshake before the server expects any other
      // message. If `authToken` is undefined the server is expected to
      // reject the connection — we still emit `connected` because the
      // socket itself is open.
      if (this.authToken && this.ws) {
        try {
          this.ws.send(JSON.stringify({ type: 'auth', token: this.authToken }));
        } catch {
          // If sending fails, the socket is broken — the close handler
          // will fire and trigger reconnect.
        }
      }
      this.emitConnectionStatus('connected');
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data as string) as NotificationPayload;
        this.handlers.forEach((handler) => handler(payload));
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      if (!this.intentionalClose) {
        this.emitConnectionStatus('disconnected');
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // The close event will fire after this — reconnect logic lives there.
    };
  }

  /** Gracefully disconnect. */
  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.emitConnectionStatus('disconnected');
  }

  /** Subscribe to notification messages. */
  onNotification(handler: NotificationHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** Subscribe to connection status changes. */
  onConnectionChange(handler: ConnectionHandler): () => void {
    this.connectionHandlers.push(handler);
    return () => {
      this.connectionHandlers = this.connectionHandlers.filter((h) => h !== handler);
    };
  }

  /** Update the auth token (e.g. after login). Reconnects if currently open. */
  setAuthToken(token: string): void {
    this.authToken = token;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
      // onclose will trigger reconnect with new token
    }
  }

  /** Current connection state. */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Number of reconnect attempts so far. */
  get currentReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    this.reconnectAttempts++;
    this.emitConnectionStatus('reconnecting');

    // Exponential backoff with jitter
    const baseDelay = this.initialReconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    const jitter = Math.random() * 0.3 * baseDelay;
    const delay = Math.min(baseDelay + jitter, this.maxReconnectDelay);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private emitConnectionStatus(status: 'connected' | 'disconnected' | 'reconnecting'): void {
    this.connectionHandlers.forEach((handler) => handler(status));
  }
}

/**
 * Singleton notification client. Components can import and subscribe
 * without managing the lifecycle themselves.
 */
let notificationClient: NotificationWebSocket | null = null;

export function getNotificationClient(options?: WebSocketClientOptions): NotificationWebSocket {
  if (!notificationClient) {
    notificationClient = new NotificationWebSocket(options);
  }
  return notificationClient;
}

export function resetNotificationClient(): void {
  if (notificationClient) {
    notificationClient.disconnect();
    notificationClient = null;
  }
}
