/**
 * Storage abstraction for weekly automated evaluation results
 * (Req 21.6).
 *
 * The {@link EvaluationRunner} produces an {@link EvaluationRunSummary}
 * once per cadence; the store persists the summary so the admin
 * dashboard can render the historical curve and a per-run breakdown
 * without re-running the suite.
 *
 * Two implementations:
 *   - {@link InMemoryEvaluationRunStore} — used by tests and any
 *     hermetic local-dev workflow.
 *   - {@link PrismaEvaluationRunStore} — production wiring backed by
 *     the `evaluation_runs` table introduced in 0003.
 */

import type { EvaluationRunSummary } from './types';

/** Filter applied when listing past evaluation runs. */
export interface ListEvaluationRunsFilter {
  /** Inclusive lower bound on `startedAt`. */
  since?: Date;
  /** Exclusive upper bound on `startedAt`. */
  before?: Date;
  /** Cap on returned rows. */
  limit?: number;
}

export interface EvaluationRunStore {
  save(summary: EvaluationRunSummary): Promise<EvaluationRunSummary>;
  findById(runId: string): Promise<EvaluationRunSummary | null>;
  list(filter?: ListEvaluationRunsFilter): Promise<EvaluationRunSummary[]>;
  /** Returns the most-recent run (or `null` when none exist). */
  latest(): Promise<EvaluationRunSummary | null>;
}

// ─── In-memory implementation ────────────────────────────────────────────────

export class InMemoryEvaluationRunStore implements EvaluationRunStore {
  private readonly rows = new Map<string, EvaluationRunSummary>();

  async save(summary: EvaluationRunSummary): Promise<EvaluationRunSummary> {
    // Defensive copy so callers cannot mutate stored history.
    const row: EvaluationRunSummary = {
      ...summary,
      results: summary.results.map((r) => ({
        ...r,
        expectedSchemeIds: [...r.expectedSchemeIds],
        retrievedSchemeIds: [...r.retrievedSchemeIds],
      })),
    };
    this.rows.set(row.runId, row);
    return row;
  }

  async findById(runId: string): Promise<EvaluationRunSummary | null> {
    return this.rows.get(runId) ?? null;
  }

  async list(
    filter: ListEvaluationRunsFilter = {},
  ): Promise<EvaluationRunSummary[]> {
    const out: EvaluationRunSummary[] = [];
    for (const row of this.rows.values()) {
      if (filter.since !== undefined && row.startedAt < filter.since) continue;
      if (filter.before !== undefined && row.startedAt >= filter.before) continue;
      out.push(row);
    }
    out.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    if (typeof filter.limit === 'number' && filter.limit >= 0) {
      return out.slice(0, filter.limit);
    }
    return out;
  }

  async latest(): Promise<EvaluationRunSummary | null> {
    const runs = await this.list({ limit: 1 });
    return runs[0] ?? null;
  }

  /** Test helper: total rows currently stored. */
  get size(): number {
    return this.rows.size;
  }
}

// ─── Prisma-backed implementation ────────────────────────────────────────────

/**
 * Narrow Prisma surface — decouples from generated types so the file
 * type-checks before `prisma generate` runs against the new model.
 */
export interface EvaluationRunPrismaClient {
  evaluationRun: {
    create(args: {
      data: {
        id: string;
        startedAt: Date;
        finishedAt: Date;
        totalCases: number;
        precision: number | string;
        recall: number | string;
        answerCorrectCount: number;
        results: unknown;
      };
    }): Promise<unknown>;
    findUnique(args: { where: { id: string } }): Promise<unknown | null>;
    findFirst(args: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }): Promise<unknown | null>;
    findMany(args: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
      take?: number;
    }): Promise<unknown[]>;
  };
}

export class PrismaEvaluationRunStore implements EvaluationRunStore {
  constructor(private readonly prisma: EvaluationRunPrismaClient) {}

  async save(summary: EvaluationRunSummary): Promise<EvaluationRunSummary> {
    await this.prisma.evaluationRun.create({
      data: {
        id: summary.runId,
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        totalCases: summary.totalCases,
        // Prisma's Decimal accepts a string representation; we hand it
        // a fixed-precision value so 0.123456789 doesn't get rejected.
        precision: summary.precision.toFixed(4),
        recall: summary.recall.toFixed(4),
        answerCorrectCount: summary.answerCorrectCount,
        results: summary.results,
      },
    });
    return summary;
  }

  async findById(runId: string): Promise<EvaluationRunSummary | null> {
    const raw = await this.prisma.evaluationRun.findUnique({
      where: { id: runId },
    });
    return raw ? hydrate(raw) : null;
  }

  async list(
    filter: ListEvaluationRunsFilter = {},
  ): Promise<EvaluationRunSummary[]> {
    const where: Record<string, unknown> = {};
    if (filter.since !== undefined || filter.before !== undefined) {
      const range: Record<string, Date> = {};
      if (filter.since !== undefined) range.gte = filter.since;
      if (filter.before !== undefined) range.lt = filter.before;
      where.startedAt = range;
    }
    const rows = await this.prisma.evaluationRun.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: filter.limit,
    });
    return rows.map(hydrate);
  }

  async latest(): Promise<EvaluationRunSummary | null> {
    const raw = await this.prisma.evaluationRun.findFirst({
      orderBy: { startedAt: 'desc' },
    });
    return raw ? hydrate(raw) : null;
  }
}

function hydrate(raw: unknown): EvaluationRunSummary {
  const r = raw as {
    id: string;
    startedAt: Date | string;
    finishedAt: Date | string;
    totalCases: number;
    precision: number | string;
    recall: number | string;
    answerCorrectCount: number;
    results: EvaluationRunSummary['results'];
  };
  return {
    runId: r.id,
    startedAt: r.startedAt instanceof Date ? r.startedAt : new Date(r.startedAt),
    finishedAt:
      r.finishedAt instanceof Date ? r.finishedAt : new Date(r.finishedAt),
    totalCases: r.totalCases,
    precision: Number(r.precision),
    recall: Number(r.recall),
    answerCorrectCount: r.answerCorrectCount,
    results: r.results,
  };
}
