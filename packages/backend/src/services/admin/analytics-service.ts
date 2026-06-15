/**
 * Admin Analytics Service (Requirements 17.1, 17.4).
 *
 * Aggregates the four numeric KPIs surfaced on the Admin_Dashboard:
 *   - Total Schemes (lifetime count of rows in `schemes`)
 *   - Active Citizens (citizens with `last_login` within the rolling
 *     30-day window — Req 17.4 definition)
 *   - Queries / day (assistant queries averaged over the rolling 30-day
 *     window)
 *   - Eligibility calculations / day (eligibility evaluations averaged
 *     over the same window)
 *
 * The service is dependency-injected so the same code paths run under
 * unit tests (no Postgres required) and against the live database.
 *
 * Queries and eligibility calculations are recorded as audit-log rows so
 * they are auditable and survive process restarts. Counters look for the
 * action strings {@link ASSISTANT_QUERY_ACTION} and
 * {@link ELIGIBILITY_CALC_ACTION} respectively. Sites that have not yet
 * wired the call-site instrumentation will simply report zero — safe by
 * default.
 */

import {
  DEFAULT_METRICS_WINDOW_MS,
  apiMetricsTracker as defaultApiTracker,
  type ApiMetricsTracker,
} from './api-metrics-tracker';
import {
  crawlerStatusTracker as defaultCrawlerTracker,
  type CrawlerStatusSnapshot,
  type CrawlerStatusTracker,
} from './crawler-status-tracker';

/** Length of the rolling analytics window (Req 17.4 — 30 days). */
export const ANALYTICS_WINDOW_DAYS = 30;
/** Rolling window in milliseconds. */
export const ANALYTICS_WINDOW_MS = ANALYTICS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Audit log action recorded each time the assistant answers a query. */
export const ASSISTANT_QUERY_ACTION = 'assistant.query';
/** Audit log action recorded for each eligibility evaluation. */
export const ELIGIBILITY_CALC_ACTION = 'eligibility.calculate';

// ─── Counter abstractions ────────────────────────────────────────────────────

/** Returns the total number of schemes currently in the system. */
export type SchemeCounter = () => Promise<number>;

/** Returns the number of citizens who logged in since `since`. */
export type ActiveCitizenCounter = (since: Date) => Promise<number>;

/**
 * Returns the number of audit-log entries whose `action` matches the
 * supplied value and whose `timestamp` is greater than or equal to
 * `since`. Used to count queries / eligibility calcs.
 */
export type AuditEventCounter = (action: string, since: Date) => Promise<number>;

/** Returns the database size in megabytes (Req 17.1). */
export type DatabaseSizeProbe = () => Promise<number>;

// ─── Public response shapes ──────────────────────────────────────────────────

/** System health snapshot returned by `GET /admin/health` (Req 17.1). */
export interface SystemHealthSnapshot {
  crawler: CrawlerStatusSnapshot;
  database: {
    sizeMb: number;
  };
  api: {
    averageResponseTimeMs: number;
    sampleCount: number;
    windowMs: number;
  };
  generatedAt: string;
}

/** Analytics rollup returned by `GET /admin/analytics` (Req 17.4). */
export interface AnalyticsSnapshot {
  totalSchemes: number;
  activeCitizens: number;
  /** Average queries per day over {@link ANALYTICS_WINDOW_DAYS}. */
  queriesPerDay: number;
  /** Average eligibility calculations per day over the same window. */
  eligibilityCalculationsPerDay: number;
  windowDays: number;
  generatedAt: string;
}

// ─── Default Prisma-backed implementations ──────────────────────────────────

async function defaultCountSchemes(): Promise<number> {
  const { default: prisma } = await import('../../lib/prisma');
  return prisma.scheme.count();
}

async function defaultCountActiveCitizens(since: Date): Promise<number> {
  const { default: prisma } = await import('../../lib/prisma');
  return prisma.user.count({
    where: { lastLogin: { gte: since } },
  });
}

async function defaultCountAuditEvents(
  action: string,
  since: Date,
): Promise<number> {
  const { default: prisma } = await import('../../lib/prisma');
  return prisma.auditLog.count({
    where: { action, timestamp: { gte: since } },
  });
}

/**
 * Default DB size probe — issues `pg_database_size(current_database())`.
 * Returns the size in megabytes rounded to two decimals. Falls back to
 * `0` if the query fails so the dashboard never crashes on a partial
 * outage; the failure is logged by the caller.
 */
async function defaultProbeDatabaseSize(): Promise<number> {
  const { default: prisma } = await import('../../lib/prisma');
  type Row = { size_bytes: bigint | number | string };
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    'SELECT pg_database_size(current_database()) AS size_bytes',
  );
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const raw = rows[0]?.size_bytes;
  const bytes =
    typeof raw === 'bigint'
      ? Number(raw)
      : typeof raw === 'string'
        ? Number(raw)
        : Number(raw ?? 0);
  if (!Number.isFinite(bytes) || bytes < 0) return 0;
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface AnalyticsServiceDeps {
  apiTracker?: ApiMetricsTracker;
  crawlerTracker?: CrawlerStatusTracker;
  countSchemes?: SchemeCounter;
  countActiveCitizens?: ActiveCitizenCounter;
  countAuditEvents?: AuditEventCounter;
  probeDatabaseSize?: DatabaseSizeProbe;
  /** Override the clock — primarily used by tests. */
  now?: () => Date;
}

/**
 * Service backing the admin dashboard's `/admin/health` and
 * `/admin/analytics` endpoints.
 */
export class AnalyticsService {
  private readonly apiTracker: ApiMetricsTracker;
  private readonly crawlerTracker: CrawlerStatusTracker;
  private readonly countSchemes: SchemeCounter;
  private readonly countActiveCitizens: ActiveCitizenCounter;
  private readonly countAuditEvents: AuditEventCounter;
  private readonly probeDatabaseSize: DatabaseSizeProbe;
  private readonly now: () => Date;

  constructor(deps: AnalyticsServiceDeps = {}) {
    this.apiTracker = deps.apiTracker ?? defaultApiTracker;
    this.crawlerTracker = deps.crawlerTracker ?? defaultCrawlerTracker;
    this.countSchemes = deps.countSchemes ?? defaultCountSchemes;
    this.countActiveCitizens =
      deps.countActiveCitizens ?? defaultCountActiveCitizens;
    this.countAuditEvents = deps.countAuditEvents ?? defaultCountAuditEvents;
    this.probeDatabaseSize = deps.probeDatabaseSize ?? defaultProbeDatabaseSize;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Returns the system health snapshot (Req 17.1). Every probe runs
   * concurrently — a slow database query never blocks the API response
   * time / crawler status sections of the response.
   */
  async getSystemHealth(): Promise<SystemHealthSnapshot> {
    const [sizeMb] = await Promise.all([this.safeDbProbe()]);
    const apiSummary = this.apiTracker.getAverageResponseTime(
      DEFAULT_METRICS_WINDOW_MS,
      this.now().getTime(),
    );
    return {
      crawler: this.crawlerTracker.snapshot(),
      database: { sizeMb },
      api: {
        averageResponseTimeMs:
          Math.round(apiSummary.averageMs * 100) / 100,
        sampleCount: apiSummary.sampleCount,
        windowMs: apiSummary.windowMs,
      },
      generatedAt: this.now().toISOString(),
    };
  }

  /**
   * Returns the analytics rollup (Req 17.4) computed over the rolling
   * 30-day window. The "per day" values are integer events divided by
   * the window length so they reflect the average daily rate; rounding
   * to two decimals keeps the dashboard tidy.
   */
  async getAnalytics(): Promise<AnalyticsSnapshot> {
    const now = this.now();
    const since = new Date(now.getTime() - ANALYTICS_WINDOW_MS);
    const [totalSchemes, activeCitizens, queryEvents, eligibilityEvents] =
      await Promise.all([
        this.countSchemes(),
        this.countActiveCitizens(since),
        this.countAuditEvents(ASSISTANT_QUERY_ACTION, since),
        this.countAuditEvents(ELIGIBILITY_CALC_ACTION, since),
      ]);
    const days = ANALYTICS_WINDOW_DAYS;
    return {
      totalSchemes,
      activeCitizens,
      queriesPerDay: roundTwo(queryEvents / days),
      eligibilityCalculationsPerDay: roundTwo(eligibilityEvents / days),
      windowDays: ANALYTICS_WINDOW_DAYS,
      generatedAt: now.toISOString(),
    };
  }

  private async safeDbProbe(): Promise<number> {
    try {
      return await this.probeDatabaseSize();
    } catch {
      return 0;
    }
  }
}

function roundTwo(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

/** Process-wide singleton used by the production wiring. */
export const analyticsService = new AnalyticsService();
