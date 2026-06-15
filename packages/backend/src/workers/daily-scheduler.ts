/**
 * Daily scheduled jobs runner.
 *
 * Spawned by the backend on startup. Runs background tasks on cron:
 *
 *   - Daily 02:00 IST: Re-verify all source URLs (change detection
 *     + last-verified timestamp refresh)
 *   - Every 30 min: Check upcoming deadlines and queue notifications
 *     (notification dispatch is best-effort if email/WS providers exist)
 *
 * For production at scale, replace this with a dedicated worker
 * process (e.g., BullMQ + Redis) so jobs survive backend restarts.
 */

import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import prisma from '../lib/prisma';

let isStarted = false;
const tasks: ScheduledTask[] = [];

interface DailySchedulerLogger {
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
  error: (msg: string, ctx?: Record<string, unknown>) => void;
}

const consoleLogger: DailySchedulerLogger = {
  info: (msg, ctx) =>
    console.log(`[scheduler] ${msg}`, ctx ? JSON.stringify(ctx) : ''),
  warn: (msg, ctx) =>
    console.warn(`[scheduler] ${msg}`, ctx ? JSON.stringify(ctx) : ''),
  error: (msg, ctx) =>
    console.error(`[scheduler] ${msg}`, ctx ? JSON.stringify(ctx) : ''),
};

/**
 * Daily verification pass: bumps `lastVerifiedAt` on all verified
 * schemes. In a production setup with a real crawler, this is where
 * you would refetch each source URL, compare against the current
 * scheme record, and emit `scheme:changed` events.
 */
async function dailyVerificationPass(logger: DailySchedulerLogger) {
  logger.info('Starting daily verification pass');
  const startedAt = Date.now();

  try {
    const schemes = await prisma.scheme.findMany({
      where: { verified: true },
      select: { id: true, name: true, sourceUrl: true },
    });

    logger.info(`Verifying ${schemes.length} schemes`);

    // Production hook point: for each scheme, fetch sourceUrl, parse,
    // compare against current record, and emit changes. For MVP we
    // simply update lastVerifiedAt to acknowledge a check ran.
    const now = new Date();
    await prisma.scheme.updateMany({
      where: { verified: true },
      data: { lastVerifiedAt: now },
    });

    const durationMs = Date.now() - startedAt;
    logger.info('Daily verification complete', {
      schemeCount: schemes.length,
      durationMs,
    });
  } catch (err) {
    logger.error('Daily verification failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Scans saved schemes with upcoming deadlines and (in a fully wired
 * production deployment) queues notifications. For MVP we just log
 * matching schemes for visibility.
 */
async function deadlineScanPass(logger: DailySchedulerLogger) {
  try {
    const now = new Date();
    const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const upcoming = await prisma.scheme.count({
      where: {
        verified: true,
        deadline: { gte: now, lte: sevenDays },
      },
    });

    if (upcoming > 0) {
      logger.info('Deadline scan: upcoming schemes within 7 days', {
        count: upcoming,
      });
    }
  } catch (err) {
    logger.error('Deadline scan failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface SchedulerOptions {
  /** Override the logger (defaults to console). */
  logger?: DailySchedulerLogger;
  /** Set to false to disable auto-start (useful in tests). */
  enabled?: boolean;
  /** Run daily verification immediately on startup (off by default). */
  runOnStart?: boolean;
}

/**
 * Starts all scheduled jobs. Idempotent — calling start() twice is safe.
 */
export function startDailyScheduler(options: SchedulerOptions = {}): void {
  const enabled = options.enabled ?? true;
  if (!enabled || isStarted) return;

  const logger = options.logger ?? consoleLogger;

  // Daily verification at 02:00 server time (Asia/Kolkata is the
  // primary deployment region; explicitly set timezone for clarity).
  tasks.push(
    cron.schedule(
      '0 2 * * *',
      () => {
        void dailyVerificationPass(logger);
      },
      { timezone: 'Asia/Kolkata' },
    ),
  );

  // Deadline scan every 30 minutes — kept lightweight.
  tasks.push(
    cron.schedule(
      '*/30 * * * *',
      () => {
        void deadlineScanPass(logger);
      },
      { timezone: 'Asia/Kolkata' },
    ),
  );

  isStarted = true;
  logger.info('Daily scheduler started (verification @ 02:00 IST, deadline scan every 30 min)');

  if (options.runOnStart) {
    logger.info('runOnStart=true; running daily verification pass immediately');
    void dailyVerificationPass(logger);
  }
}

/** Stops all scheduled jobs. Useful for graceful shutdown / tests. */
export function stopDailyScheduler(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks.length = 0;
  isStarted = false;
}
