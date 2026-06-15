/**
 * Admin Notifier
 *
 * Defines the {@link AdminNotifier} interface used by the
 * {@link CrawlerOrchestrator} to surface daily-crawl outcomes to platform
 * administrators (Requirements 1.8, 1.9). Two channels are exposed:
 *
 *   - {@link AdminNotifier.notifyFailures} — invoked when one or more
 *     sources fail during a crawl. Production implementations are
 *     expected to deliver inside 15 minutes.
 *   - {@link AdminNotifier.notifyCrawlComplete} — invoked at the end of
 *     every successful crawl with the aggregate {@link CrawlResult}.
 *     Useful for dashboards and audit trails.
 *
 * The real implementation will be wired to the production
 * NotificationService (email + in-app channels); this module ships
 * three reference implementations:
 *   - {@link InMemoryAdminNotifier} — record-only, for tests.
 *   - {@link ConsoleAdminNotifier}  — logs to stdout/stderr, for local
 *     development and the default worker wiring.
 *   - {@link defaultAdminNotifier}  — singleton instance of the console
 *     notifier exposed for convenience.
 *
 * The contract intentionally restricts notifier responsibilities to
 * "tell admins about crawl outcomes, fast" — it does not encode channel
 * selection, retry, or templating, all of which belong to the
 * production NotificationService.
 *
 * Validates: Requirements 1.8, 1.9
 */

import type { CrawlResult, FailedSource } from '@bharat-benefits/shared';

/**
 * Severity of an admin alert. The orchestrator chooses the level based on
 * the failure rate: a single transient failure is `warning`, a hard
 * crawl-wide outage (no successes) is `critical`.
 */
export type AdminAlertSeverity = 'warning' | 'critical';

/** Payload sent to the {@link AdminNotifier} for a daily-crawl failure batch. */
export interface AdminFailureNotification {
  /** Severity of the alert. */
  severity: AdminAlertSeverity;
  /** Number of sources that failed during the crawl. */
  totalFailed: number;
  /** Number of sources that were attempted in this crawl run. */
  totalAttempted: number;
  /** The actual failed sources, with reason and error code. */
  failures: FailedSource[];
  /** Timestamp the orchestrator detected the failures. */
  detectedAt: Date;
  /** Optional free-text summary, used for log readability. */
  summary?: string;
}

/**
 * Notifier surface for the daily-crawl orchestrator. Implementations are
 * expected to deliver `notification` to administrators within 15 minutes
 * of being called (Requirement 1.9).
 */
export interface AdminNotifier {
  notifyFailures(notification: AdminFailureNotification): Promise<void>;
  notifyCrawlComplete(result: CrawlResult): Promise<void>;
}

/**
 * In-memory notifier used by tests and local development. Records every
 * call in {@link InMemoryAdminNotifier.failureCalls} /
 * {@link InMemoryAdminNotifier.completeCalls} so tests can assert on the
 * exact payload that would have been sent in production.
 */
export class InMemoryAdminNotifier implements AdminNotifier {
  /** All failure notifications received, in arrival order. */
  public readonly failureCalls: AdminFailureNotification[] = [];
  /** All crawl-complete notifications received, in arrival order. */
  public readonly completeCalls: CrawlResult[] = [];

  /**
   * @deprecated Use {@link failureCalls}. Kept as an alias to preserve
   * backwards compatibility with earlier callers.
   */
  get calls(): AdminFailureNotification[] {
    return this.failureCalls;
  }

  async notifyFailures(notification: AdminFailureNotification): Promise<void> {
    // Defensive copy so callers can mutate their own arrays without
    // affecting recorded history.
    this.failureCalls.push({
      ...notification,
      failures: notification.failures.map((f) => ({ ...f })),
    });
  }

  async notifyCrawlComplete(result: CrawlResult): Promise<void> {
    this.completeCalls.push({
      ...result,
      failedSources: result.failedSources.map((f) => ({ ...f })),
    });
  }

  /** Convenience: total number of failure notifications observed. */
  get callCount(): number {
    return this.failureCalls.length;
  }

  /** Convenience: most recent failure notification, or null. */
  get lastCall(): AdminFailureNotification | null {
    return this.failureCalls.length === 0
      ? null
      : this.failureCalls[this.failureCalls.length - 1];
  }

  /** Convenience: most recent crawl-complete notification, or null. */
  get lastCompleteCall(): CrawlResult | null {
    return this.completeCalls.length === 0
      ? null
      : this.completeCalls[this.completeCalls.length - 1];
  }

  /** Resets recorded history (useful between tests). */
  reset(): void {
    this.failureCalls.length = 0;
    this.completeCalls.length = 0;
  }
}

/**
 * Console-backed notifier used as the default in production worker
 * wiring until the full {@link NotificationService} is integrated.
 * Emits one structured log line per call so operators can grep for
 * `[crawler:admin]` to locate alerts.
 */
export class ConsoleAdminNotifier implements AdminNotifier {
  async notifyFailures(notification: AdminFailureNotification): Promise<void> {
    const line = {
      severity: notification.severity,
      totalFailed: notification.totalFailed,
      totalAttempted: notification.totalAttempted,
      detectedAt: notification.detectedAt.toISOString(),
      summary: notification.summary,
      failures: notification.failures.map((f) => ({
        url: f.url,
        reason: f.reason,
        errorCode: f.errorCode,
      })),
    };
    if (notification.severity === 'critical') {
      // eslint-disable-next-line no-console
      console.error('[crawler:admin] crawl failures', line);
    } else {
      // eslint-disable-next-line no-console
      console.warn('[crawler:admin] crawl failures', line);
    }
  }

  async notifyCrawlComplete(result: CrawlResult): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[crawler:admin] crawl complete', {
      newSchemes: result.newSchemes,
      updatedSchemes: result.updatedSchemes,
      failedSourcesCount: result.failedSources.length,
      durationMs: result.duration,
      completedAt: result.completedAt.toISOString(),
    });
  }
}

/**
 * Default notifier instance used by the worker when no explicit
 * implementation is supplied. Wraps {@link ConsoleAdminNotifier}.
 */
export const defaultAdminNotifier: AdminNotifier = new ConsoleAdminNotifier();
