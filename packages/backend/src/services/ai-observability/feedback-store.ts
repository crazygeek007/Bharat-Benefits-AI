/**
 * Storage abstraction for citizen helpful / unhelpful ratings on
 * Scheme_Assistant responses (Req 21.3).
 *
 * Mirrors the shape of {@link AIQueryLogStore}: an in-memory test
 * implementation alongside a Prisma-backed production implementation
 * targeting the `assistant_response_feedback` table introduced in 0003.
 *
 * The store deliberately enforces "one rating per (traceId, userId)
 * pair" (Req 21.3 — "feedback mechanism on responses"): if the same
 * citizen submits a second rating for the same response, the existing
 * row is updated. Anonymous sessions (`userId === null`) are treated
 * as a single bucket per trace.
 */

import { randomUUID } from 'node:crypto';

import type { AIQueryFeedback, FeedbackRating } from './types';

/** Argument for {@link FeedbackStore.record}. */
export interface RecordFeedbackInput {
  traceId: string;
  userId: string | null;
  rating: FeedbackRating;
  comment?: string | null;
  /** Override clock for tests. */
  now?: Date;
}

export interface ListFeedbackFilter {
  /** Only feedback for this trace. */
  traceId?: string;
  /** Only feedback for this user. */
  userId?: string;
  /** Inclusive lower bound on `createdAt`. */
  since?: Date;
  /** Exclusive upper bound on `createdAt`. */
  before?: Date;
  /** Cap on returned rows. */
  limit?: number;
}

export interface FeedbackStore {
  record(input: RecordFeedbackInput): Promise<AIQueryFeedback>;
  /**
   * Return the most-recent N rated feedback rows ordered newest-first.
   *
   * Used by {@link HelpfulnessMonitor} to evaluate the rolling window
   * (Req 21.4). When fewer than `n` rows exist the implementation
   * returns whatever is available rather than padding.
   */
  listMostRecent(n: number): Promise<AIQueryFeedback[]>;
  /** General listing for admin dashboards / metrics. */
  list(filter?: ListFeedbackFilter): Promise<AIQueryFeedback[]>;
}

// ─── In-memory implementation ────────────────────────────────────────────────

export class InMemoryFeedbackStore implements FeedbackStore {
  private readonly rows = new Map<string, AIQueryFeedback>();

  async record(input: RecordFeedbackInput): Promise<AIQueryFeedback> {
    const now = input.now ?? new Date();
    const key = compositeKey(input.traceId, input.userId);
    const existing = this.rows.get(key);
    if (existing) {
      const updated: AIQueryFeedback = {
        ...existing,
        rating: input.rating,
        comment: input.comment ?? null,
        createdAt: now,
      };
      this.rows.set(key, updated);
      return updated;
    }
    const row: AIQueryFeedback = {
      id: randomUUID(),
      traceId: input.traceId,
      userId: input.userId,
      rating: input.rating,
      comment: input.comment ?? null,
      createdAt: now,
    };
    this.rows.set(key, row);
    return row;
  }

  async listMostRecent(n: number): Promise<AIQueryFeedback[]> {
    if (!Number.isFinite(n) || n <= 0) return [];
    const all = Array.from(this.rows.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    return all.slice(0, n);
  }

  async list(filter: ListFeedbackFilter = {}): Promise<AIQueryFeedback[]> {
    const out: AIQueryFeedback[] = [];
    for (const row of this.rows.values()) {
      if (filter.traceId !== undefined && row.traceId !== filter.traceId) continue;
      if (filter.userId !== undefined && row.userId !== filter.userId) continue;
      if (filter.since !== undefined && row.createdAt < filter.since) continue;
      if (filter.before !== undefined && row.createdAt >= filter.before) continue;
      out.push(row);
    }
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    if (typeof filter.limit === 'number' && filter.limit >= 0) {
      return out.slice(0, filter.limit);
    }
    return out;
  }

  /** Test helper: total rows currently stored. */
  get size(): number {
    return this.rows.size;
  }
}

function compositeKey(traceId: string, userId: string | null): string {
  return `${traceId}::${userId ?? '__anon__'}`;
}

// ─── Prisma-backed implementation ────────────────────────────────────────────

export interface FeedbackPrismaClient {
  assistantResponseFeedback: {
    upsert(args: {
      where: { traceId_userId: { traceId: string; userId: string | null } };
      create: AIQueryFeedback;
      update: Partial<AIQueryFeedback>;
    }): Promise<AIQueryFeedback>;
    findMany(args: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
      take?: number;
    }): Promise<AIQueryFeedback[]>;
  };
}

export class PrismaFeedbackStore implements FeedbackStore {
  constructor(private readonly prisma: FeedbackPrismaClient) {}

  async record(input: RecordFeedbackInput): Promise<AIQueryFeedback> {
    const now = input.now ?? new Date();
    const row: AIQueryFeedback = {
      id: randomUUID(),
      traceId: input.traceId,
      userId: input.userId,
      rating: input.rating,
      comment: input.comment ?? null,
      createdAt: now,
    };
    return this.prisma.assistantResponseFeedback.upsert({
      where: { traceId_userId: { traceId: input.traceId, userId: input.userId } },
      create: row,
      update: {
        rating: input.rating,
        comment: input.comment ?? null,
        createdAt: now,
      },
    });
  }

  async listMostRecent(n: number): Promise<AIQueryFeedback[]> {
    if (!Number.isFinite(n) || n <= 0) return [];
    return this.prisma.assistantResponseFeedback.findMany({
      orderBy: { createdAt: 'desc' },
      take: n,
    });
  }

  async list(filter: ListFeedbackFilter = {}): Promise<AIQueryFeedback[]> {
    const where: Record<string, unknown> = {};
    if (filter.traceId !== undefined) where.traceId = filter.traceId;
    if (filter.userId !== undefined) where.userId = filter.userId;
    if (filter.since !== undefined || filter.before !== undefined) {
      const range: Record<string, Date> = {};
      if (filter.since !== undefined) range.gte = filter.since;
      if (filter.before !== undefined) range.lt = filter.before;
      where.createdAt = range;
    }
    return this.prisma.assistantResponseFeedback.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: filter.limit,
    });
  }
}
