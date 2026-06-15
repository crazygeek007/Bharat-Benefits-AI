/**
 * Conversation memory for the Scheme Assistant.
 *
 * Maintains the most recent N exchanges per session so follow-up questions
 * can be answered with conversational context (Req 6.6 — "retain at least
 * the previous 5 exchanges within a session").
 *
 * Two implementations are provided:
 *   - {@link InMemoryConversationStore} — process-local, intended for tests
 *     and single-instance deployments.
 *   - {@link RedisConversationStore} — backed by ioredis, suitable for
 *     multi-instance deployments where sessions can land on any node.
 *
 * Both honour the `MAX_EXCHANGES_PER_SESSION` cap with FIFO eviction so
 * an unbounded conversation cannot grow without bound.
 */

import type { SupportedLanguage } from '@bharat-benefits/shared';

/**
 * Maximum number of (user → assistant) exchanges retained per session.
 *
 * Req 6.6 mandates retaining "at least the previous 5 exchanges". We cap at
 * exactly 5 so the assistant prompt has bounded size while still meeting
 * the requirement.
 */
export const MAX_EXCHANGES_PER_SESSION = 5;

/**
 * Default Redis TTL for a conversation entry. Sessions are typically short-
 * lived (Req 16.5 — 30 minute inactivity timeout) but we keep history a
 * little longer in case the citizen reconnects.
 */
export const DEFAULT_CONVERSATION_TTL_SECONDS = 60 * 60; // 1 hour

/** A single user → assistant exchange. */
export interface ConversationExchange {
  userQuery: string;
  assistantAnswer: string;
  language: SupportedLanguage;
  timestamp: Date;
}

/** Store interface implemented by both in-memory and Redis variants. */
export interface ConversationStore {
  /** Returns the recorded exchanges in oldest → newest order. */
  getHistory(sessionId: string): Promise<ConversationExchange[]>;
  /** Appends a new exchange, evicting the oldest entries beyond the cap. */
  appendExchange(
    sessionId: string,
    exchange: Omit<ConversationExchange, 'timestamp'> & { timestamp?: Date },
  ): Promise<void>;
  /** Clears all stored exchanges for the session. */
  clearHistory(sessionId: string): Promise<void>;
}

// ─── In-memory implementation ────────────────────────────────────────────────

/**
 * Process-local conversation store using a `Map`. Suitable for unit tests
 * and single-process deployments. Not safe across multiple workers — use
 * {@link RedisConversationStore} in clustered environments.
 */
export class InMemoryConversationStore implements ConversationStore {
  private readonly sessions = new Map<string, ConversationExchange[]>();

  constructor(private readonly maxExchanges: number = MAX_EXCHANGES_PER_SESSION) {
    if (!Number.isFinite(maxExchanges) || maxExchanges <= 0) {
      throw new Error('maxExchanges must be a positive integer');
    }
  }

  async getHistory(sessionId: string): Promise<ConversationExchange[]> {
    assertSessionId(sessionId);
    const history = this.sessions.get(sessionId);
    if (!history) return [];
    // Return a shallow copy so callers can't mutate internal state.
    return history.map((e) => ({ ...e }));
  }

  async appendExchange(
    sessionId: string,
    exchange: Omit<ConversationExchange, 'timestamp'> & { timestamp?: Date },
  ): Promise<void> {
    assertSessionId(sessionId);
    const history = this.sessions.get(sessionId) ?? [];
    history.push({
      userQuery: exchange.userQuery,
      assistantAnswer: exchange.assistantAnswer,
      language: exchange.language,
      timestamp: exchange.timestamp ?? new Date(),
    });
    // FIFO eviction: drop oldest entries until we are at or below the cap.
    while (history.length > this.maxExchanges) {
      history.shift();
    }
    this.sessions.set(sessionId, history);
  }

  async clearHistory(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    this.sessions.delete(sessionId);
  }
}

// ─── Redis implementation ────────────────────────────────────────────────────

/**
 * Minimal Redis interface required by the store. Compatible with the
 * subset of `ioredis` we use; tests can supply a fake without depending
 * on the full client surface.
 */
export interface RedisLike {
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * Redis-backed conversation store. Each session is a Redis list keyed by
 * `${keyPrefix}${sessionId}` containing JSON-encoded {@link ConversationExchange}
 * entries (oldest → newest). After every append the list is trimmed to
 * the most recent {@link MAX_EXCHANGES_PER_SESSION} entries and a TTL is set.
 */
export class RedisConversationStore implements ConversationStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly options: {
      keyPrefix?: string;
      maxExchanges?: number;
      ttlSeconds?: number;
    } = {},
  ) {
    const max = options.maxExchanges ?? MAX_EXCHANGES_PER_SESSION;
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error('maxExchanges must be a positive integer');
    }
  }

  private get keyPrefix(): string {
    return this.options.keyPrefix ?? 'assistant:conv:';
  }

  private get maxExchanges(): number {
    return this.options.maxExchanges ?? MAX_EXCHANGES_PER_SESSION;
  }

  private get ttlSeconds(): number {
    return this.options.ttlSeconds ?? DEFAULT_CONVERSATION_TTL_SECONDS;
  }

  private key(sessionId: string): string {
    return `${this.keyPrefix}${sessionId}`;
  }

  async getHistory(sessionId: string): Promise<ConversationExchange[]> {
    assertSessionId(sessionId);
    const raw = await this.redis.lrange(this.key(sessionId), 0, -1);
    const out: ConversationExchange[] = [];
    for (const entry of raw) {
      try {
        const parsed = JSON.parse(entry) as ConversationExchange & { timestamp: string | Date };
        out.push({
          userQuery: String(parsed.userQuery ?? ''),
          assistantAnswer: String(parsed.assistantAnswer ?? ''),
          language: parsed.language,
          timestamp:
            parsed.timestamp instanceof Date
              ? parsed.timestamp
              : new Date(parsed.timestamp),
        });
      } catch {
        // Skip malformed entries rather than failing the whole call.
      }
    }
    return out;
  }

  async appendExchange(
    sessionId: string,
    exchange: Omit<ConversationExchange, 'timestamp'> & { timestamp?: Date },
  ): Promise<void> {
    assertSessionId(sessionId);
    const ts = exchange.timestamp ?? new Date();
    const payload = JSON.stringify({
      userQuery: exchange.userQuery,
      assistantAnswer: exchange.assistantAnswer,
      language: exchange.language,
      timestamp: ts.toISOString(),
    });
    const key = this.key(sessionId);
    await this.redis.rpush(key, payload);
    // Trim from the right so only the most recent N entries remain.
    await this.redis.ltrim(key, -this.maxExchanges, -1);
    await this.redis.expire(key, this.ttlSeconds);
  }

  async clearHistory(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    await this.redis.del(this.key(sessionId));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new Error('sessionId must be a non-empty string');
  }
}
