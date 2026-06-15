/**
 * In-process crawler status registry (Requirement 17.1).
 *
 * The admin dashboard surfaces the Crawler_System status — running,
 * stopped, or error — alongside the timestamp of its last execution.
 * The orchestrator records lifecycle events here:
 *   - `markRunning()` at the start of a daily crawl,
 *   - `markStopped()` after a clean completion,
 *   - `markError(message)` when the crawl fails.
 *
 * State is held in memory because the dashboard tolerates a process
 * restart (the next crawl re-populates the registry within minutes). For
 * tests, callers should construct a fresh {@link CrawlerStatusTracker}
 * rather than reusing the {@link crawlerStatusTracker} singleton to
 * avoid cross-test leakage.
 */

/** Lifecycle status surfaced to the admin dashboard. */
export type CrawlerLifecycleStatus = 'running' | 'stopped' | 'error' | 'unknown';

/** Snapshot returned to the admin dashboard. */
export interface CrawlerStatusSnapshot {
  status: CrawlerLifecycleStatus;
  /** Most recent execution timestamp, ISO-8601 — `null` when never run. */
  lastExecutionAt: string | null;
  /** Human-readable error message when `status === 'error'`. */
  errorMessage: string | null;
}

/**
 * Mutable in-memory registry. Designed to be embedded in a single
 * Node process; not synchronised across replicas (each replica reports
 * its own lifecycle state).
 */
export class CrawlerStatusTracker {
  private status: CrawlerLifecycleStatus = 'unknown';
  private lastExecutionAt: Date | null = null;
  private errorMessage: string | null = null;

  /** Records that a crawl has begun. */
  markRunning(now: Date = new Date()): void {
    this.status = 'running';
    this.lastExecutionAt = now;
    this.errorMessage = null;
  }

  /** Records that a crawl has completed cleanly. */
  markStopped(now: Date = new Date()): void {
    this.status = 'stopped';
    this.lastExecutionAt = now;
    this.errorMessage = null;
  }

  /** Records that a crawl has failed and notes the failure reason. */
  markError(message: string, now: Date = new Date()): void {
    this.status = 'error';
    this.lastExecutionAt = now;
    this.errorMessage = message.length > 0 ? message : 'Unknown crawler error';
  }

  /** Returns a snapshot suitable for serialisation to the admin dashboard. */
  snapshot(): CrawlerStatusSnapshot {
    return {
      status: this.status,
      lastExecutionAt: this.lastExecutionAt?.toISOString() ?? null,
      errorMessage: this.errorMessage,
    };
  }

  /** Resets the registry — primarily used by tests. */
  reset(): void {
    this.status = 'unknown';
    this.lastExecutionAt = null;
    this.errorMessage = null;
  }
}

/** Process-wide singleton used by the production wiring. */
export const crawlerStatusTracker = new CrawlerStatusTracker();
