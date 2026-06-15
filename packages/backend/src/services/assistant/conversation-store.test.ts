/**
 * Unit tests for the conversation memory used by the Scheme Assistant.
 *
 * Covers both the in-memory and Redis-backed implementations:
 *   - History is returned in oldest → newest order.
 *   - Append evicts the oldest entry once the cap is reached so the
 *     store retains at most {@link MAX_EXCHANGES_PER_SESSION} exchanges
 *     (Req 6.6).
 *   - Sessions are isolated from each other.
 *   - Invalid input (empty session id, non-positive max) is rejected.
 *   - Redis variant trims the list, sets a TTL, and survives malformed
 *     JSON entries gracefully.
 *
 * Validates: Requirements 6.6
 */

import { describe, it, expect, vi } from 'vitest';

import {
  DEFAULT_CONVERSATION_TTL_SECONDS,
  InMemoryConversationStore,
  MAX_EXCHANGES_PER_SESSION,
  RedisConversationStore,
  type ConversationExchange,
  type RedisLike,
} from './conversation-store';

// ─── Test helpers ────────────────────────────────────────────────────────────

function exchange(
  userQuery: string,
  assistantAnswer: string,
  timestamp?: Date,
): Omit<ConversationExchange, 'timestamp'> & { timestamp?: Date } {
  return {
    userQuery,
    assistantAnswer,
    language: 'en',
    timestamp,
  };
}

/** Minimal in-memory Redis fake implementing the {@link RedisLike} surface. */
class FakeRedis implements RedisLike {
  public readonly storage = new Map<string, string[]>();
  public readonly ttls = new Map<string, number>();

  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.storage.get(key) ?? [];
    list.push(...values);
    this.storage.set(key, list);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.storage.get(key) ?? [];
    const len = list.length;
    const s = start < 0 ? Math.max(0, len + start) : Math.min(start, len);
    const e =
      stop < 0
        ? len + stop // inclusive end
        : Math.min(stop, len - 1);
    if (s > e) return [];
    return list.slice(s, e + 1);
  }

  async ltrim(key: string, start: number, stop: number): Promise<unknown> {
    const list = this.storage.get(key) ?? [];
    const len = list.length;
    const s = start < 0 ? Math.max(0, len + start) : Math.min(start, len);
    const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
    if (s > e) {
      this.storage.set(key, []);
      return 'OK';
    }
    this.storage.set(key, list.slice(s, e + 1));
    return 'OK';
  }

  async expire(key: string, seconds: number): Promise<unknown> {
    this.ttls.set(key, seconds);
    return 1;
  }

  async del(key: string): Promise<unknown> {
    this.storage.delete(key);
    this.ttls.delete(key);
    return 1;
  }
}

// ─── In-memory variant ───────────────────────────────────────────────────────

describe('InMemoryConversationStore', () => {
  it('returns an empty history for an unknown session', async () => {
    const store = new InMemoryConversationStore();
    expect(await store.getHistory('s1')).toEqual([]);
  });

  it('preserves insertion order (oldest → newest)', async () => {
    const store = new InMemoryConversationStore();
    await store.appendExchange('s1', exchange('q1', 'a1'));
    await store.appendExchange('s1', exchange('q2', 'a2'));
    await store.appendExchange('s1', exchange('q3', 'a3'));

    const history = await store.getHistory('s1');
    expect(history.map((e) => e.userQuery)).toEqual(['q1', 'q2', 'q3']);
  });

  it('caps history at MAX_EXCHANGES_PER_SESSION with FIFO eviction', async () => {
    const store = new InMemoryConversationStore();
    for (let i = 0; i < MAX_EXCHANGES_PER_SESSION + 3; i++) {
      await store.appendExchange('s1', exchange(`q${i}`, `a${i}`));
    }
    const history = await store.getHistory('s1');
    expect(history).toHaveLength(MAX_EXCHANGES_PER_SESSION);
    // The oldest 3 entries (q0..q2) should have been evicted.
    expect(history[0]!.userQuery).toBe('q3');
    expect(history.at(-1)!.userQuery).toBe(
      `q${MAX_EXCHANGES_PER_SESSION + 2}`,
    );
  });

  it('honours a custom maxExchanges value', async () => {
    const store = new InMemoryConversationStore(2);
    await store.appendExchange('s', exchange('q1', 'a1'));
    await store.appendExchange('s', exchange('q2', 'a2'));
    await store.appendExchange('s', exchange('q3', 'a3'));
    const history = await store.getHistory('s');
    expect(history.map((e) => e.userQuery)).toEqual(['q2', 'q3']);
  });

  it('isolates separate sessions', async () => {
    const store = new InMemoryConversationStore();
    await store.appendExchange('alice', exchange('hello', 'hi'));
    await store.appendExchange('bob', exchange('hola', 'buenas'));

    const a = await store.getHistory('alice');
    const b = await store.getHistory('bob');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.userQuery).toBe('hello');
    expect(b[0]!.userQuery).toBe('hola');
  });

  it('returns shallow copies so callers cannot mutate internal state', async () => {
    const store = new InMemoryConversationStore();
    await store.appendExchange('s', exchange('q', 'a'));
    const first = await store.getHistory('s');
    first[0]!.userQuery = 'tampered';

    const second = await store.getHistory('s');
    expect(second[0]!.userQuery).toBe('q');
  });

  it('clears history on demand', async () => {
    const store = new InMemoryConversationStore();
    await store.appendExchange('s', exchange('q', 'a'));
    await store.clearHistory('s');
    expect(await store.getHistory('s')).toEqual([]);
  });

  it('rejects empty session ids', async () => {
    const store = new InMemoryConversationStore();
    await expect(store.getHistory('')).rejects.toThrow();
    await expect(store.getHistory('   ')).rejects.toThrow();
    await expect(
      store.appendExchange('', exchange('q', 'a')),
    ).rejects.toThrow();
  });

  it('rejects non-positive maxExchanges values', () => {
    expect(() => new InMemoryConversationStore(0)).toThrow();
    expect(() => new InMemoryConversationStore(-1)).toThrow();
    expect(() => new InMemoryConversationStore(Number.NaN)).toThrow();
  });

  it('uses provided timestamp when supplied, otherwise generates one', async () => {
    const store = new InMemoryConversationStore();
    const fixed = new Date('2025-01-01T00:00:00.000Z');
    await store.appendExchange('s', exchange('q1', 'a1', fixed));
    await store.appendExchange('s', exchange('q2', 'a2'));

    const history = await store.getHistory('s');
    expect(history[0]!.timestamp).toEqual(fixed);
    expect(history[1]!.timestamp).toBeInstanceOf(Date);
  });
});

// ─── Redis variant ───────────────────────────────────────────────────────────

describe('RedisConversationStore', () => {
  it('writes JSON-encoded entries into a list and sets a TTL on append', async () => {
    const redis = new FakeRedis();
    const rpush = vi.spyOn(redis, 'rpush');
    const ltrim = vi.spyOn(redis, 'ltrim');
    const expire = vi.spyOn(redis, 'expire');

    const store = new RedisConversationStore(redis);
    await store.appendExchange('s', exchange('hello', 'world'));

    expect(rpush).toHaveBeenCalledTimes(1);
    expect(ltrim).toHaveBeenCalledWith(
      'assistant:conv:s',
      -MAX_EXCHANGES_PER_SESSION,
      -1,
    );
    expect(expire).toHaveBeenCalledWith(
      'assistant:conv:s',
      DEFAULT_CONVERSATION_TTL_SECONDS,
    );
  });

  it('returns history in oldest → newest order', async () => {
    const redis = new FakeRedis();
    const store = new RedisConversationStore(redis);
    await store.appendExchange('s', exchange('q1', 'a1'));
    await store.appendExchange('s', exchange('q2', 'a2'));

    const history = await store.getHistory('s');
    expect(history.map((e) => e.userQuery)).toEqual(['q1', 'q2']);
    expect(history[0]!.timestamp).toBeInstanceOf(Date);
  });

  it('trims list to MAX_EXCHANGES_PER_SESSION after each append', async () => {
    const redis = new FakeRedis();
    const store = new RedisConversationStore(redis);
    const total = MAX_EXCHANGES_PER_SESSION + 4;
    for (let i = 0; i < total; i++) {
      await store.appendExchange('s', exchange(`q${i}`, `a${i}`));
    }
    const history = await store.getHistory('s');
    expect(history).toHaveLength(MAX_EXCHANGES_PER_SESSION);
    expect(history[0]!.userQuery).toBe(
      `q${total - MAX_EXCHANGES_PER_SESSION}`,
    );
    expect(history.at(-1)!.userQuery).toBe(`q${total - 1}`);
  });

  it('honours custom keyPrefix, maxExchanges, and ttlSeconds', async () => {
    const redis = new FakeRedis();
    const expire = vi.spyOn(redis, 'expire');
    const ltrim = vi.spyOn(redis, 'ltrim');

    const store = new RedisConversationStore(redis, {
      keyPrefix: 'conv:',
      maxExchanges: 2,
      ttlSeconds: 30,
    });
    await store.appendExchange('s', exchange('q1', 'a1'));
    await store.appendExchange('s', exchange('q2', 'a2'));
    await store.appendExchange('s', exchange('q3', 'a3'));

    expect(ltrim).toHaveBeenLastCalledWith('conv:s', -2, -1);
    expect(expire).toHaveBeenLastCalledWith('conv:s', 30);

    const history = await store.getHistory('s');
    expect(history.map((e) => e.userQuery)).toEqual(['q2', 'q3']);
  });

  it('skips malformed JSON entries gracefully', async () => {
    const redis = new FakeRedis();
    redis.storage.set('assistant:conv:s', [
      'not-json',
      JSON.stringify({
        userQuery: 'q',
        assistantAnswer: 'a',
        language: 'en',
        timestamp: new Date('2025-01-01').toISOString(),
      }),
    ]);

    const store = new RedisConversationStore(redis);
    const history = await store.getHistory('s');
    expect(history).toHaveLength(1);
    expect(history[0]!.userQuery).toBe('q');
  });

  it('clears history via DEL', async () => {
    const redis = new FakeRedis();
    const del = vi.spyOn(redis, 'del');

    const store = new RedisConversationStore(redis);
    await store.appendExchange('s', exchange('q', 'a'));
    await store.clearHistory('s');

    expect(del).toHaveBeenCalledWith('assistant:conv:s');
    expect(await store.getHistory('s')).toEqual([]);
  });

  it('rejects non-positive maxExchanges', () => {
    const redis = new FakeRedis();
    expect(
      () => new RedisConversationStore(redis, { maxExchanges: 0 }),
    ).toThrow();
    expect(
      () => new RedisConversationStore(redis, { maxExchanges: -1 }),
    ).toThrow();
  });
});
