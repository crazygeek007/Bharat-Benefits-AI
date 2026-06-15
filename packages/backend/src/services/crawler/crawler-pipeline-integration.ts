/**
 * Crawler Pipeline Integration — wires the CrawlerOrchestrator to all
 * downstream systems: PostgreSQL, Vector DB, Elasticsearch, Change
 * Detector (with citizen notifications), and source failure tracking.
 *
 * This module bridges the gap between the I/O-free CrawlerOrchestrator
 * (which depends on abstract interfaces) and the concrete services
 * (ChangeDetectorService, NotificationService, SchemeIndexer, Prisma).
 *
 * Responsibilities:
 *   - Provide a `ChangeDetector` adapter that calls ChangeDetectorService
 *     and triggers citizen notifications on scheme changes (Req 14.3).
 *   - Track consecutive source failures per URL and flag sources as
 *     unreachable after 3 consecutive failures (Req 1.8).
 *   - Log all pipeline steps for admin visibility.
 *   - Coordinate the full pipeline execution via `runCrawlerPipeline`.
 *
 * Validates: Requirements 1.4, 1.5, 1.8, 14.3
 */

import type { SchemeObject, CrawlResult } from '@bharat-benefits/shared';

import type { ChangeDetector as OrchestratorChangeDetector } from './orchestrator';
import type {
  ChangeDetectorService,
  DetectChangesResult,
} from '../change-detector/change-detector';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Number of consecutive failures before a source is flagged unreachable. */
export const CONSECUTIVE_FAILURE_THRESHOLD = 3;

// ─── Logger interface ────────────────────────────────────────────────────────

export interface PipelineLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: PipelineLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Source failure tracker ──────────────────────────────────────────────────

/**
 * Tracks consecutive crawl failures per source URL and flags sources
 * as unreachable after {@link CONSECUTIVE_FAILURE_THRESHOLD} consecutive
 * failures (Requirement 1.8).
 */
export interface SourceFailureRecord {
  url: string;
  consecutiveFailures: number;
  lastFailureAt: Date;
  flaggedUnreachable: boolean;
  flaggedAt: Date | null;
}

export interface SourceFailureStore {
  /**
   * Returns the current failure record for a source URL, or null if
   * no failures have been recorded.
   */
  getFailureRecord(url: string): Promise<SourceFailureRecord | null>;

  /**
   * Increments the consecutive failure count for a source URL.
   * Returns the updated record.
   */
  incrementFailure(url: string, failedAt: Date): Promise<SourceFailureRecord>;

  /**
   * Resets the consecutive failure count for a source URL (on success).
   */
  resetFailures(url: string): Promise<void>;

  /**
   * Marks a source as unreachable (flagged for admin review).
   */
  flagAsUnreachable(url: string, flaggedAt: Date): Promise<void>;

  /**
   * Returns all sources currently flagged as unreachable.
   */
  getUnreachableSources(): Promise<SourceFailureRecord[]>;
}

/**
 * In-memory implementation of {@link SourceFailureStore} for testing
 * and lightweight deployments. Production systems should use a
 * Prisma-backed implementation.
 */
export class InMemorySourceFailureStore implements SourceFailureStore {
  private readonly records = new Map<string, SourceFailureRecord>();

  async getFailureRecord(url: string): Promise<SourceFailureRecord | null> {
    return this.records.get(url) ?? null;
  }

  async incrementFailure(url: string, failedAt: Date): Promise<SourceFailureRecord> {
    const existing = this.records.get(url);
    const updated: SourceFailureRecord = {
      url,
      consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
      lastFailureAt: failedAt,
      flaggedUnreachable: existing?.flaggedUnreachable ?? false,
      flaggedAt: existing?.flaggedAt ?? null,
    };
    this.records.set(url, updated);
    return updated;
  }

  async resetFailures(url: string): Promise<void> {
    const existing = this.records.get(url);
    if (existing) {
      existing.consecutiveFailures = 0;
      // Keep the flaggedUnreachable status — admins must manually clear it
    }
  }

  async flagAsUnreachable(url: string, flaggedAt: Date): Promise<void> {
    const existing = this.records.get(url);
    if (existing) {
      existing.flaggedUnreachable = true;
      existing.flaggedAt = flaggedAt;
    } else {
      this.records.set(url, {
        url,
        consecutiveFailures: CONSECUTIVE_FAILURE_THRESHOLD,
        lastFailureAt: flaggedAt,
        flaggedUnreachable: true,
        flaggedAt,
      });
    }
  }

  async getUnreachableSources(): Promise<SourceFailureRecord[]> {
    return [...this.records.values()].filter((r) => r.flaggedUnreachable);
  }

  /** Test helper — clear all records. */
  clear(): void {
    this.records.clear();
  }
}

// ─── Change Detector Adapter ─────────────────────────────────────────────────

/**
 * Adapts the full {@link ChangeDetectorService} to the minimal
 * {@link OrchestratorChangeDetector} interface expected by the
 * CrawlerOrchestrator, while additionally triggering notifications
 * for affected citizens when changes are detected (Req 14.3) and
 * triggering benefit recalculation when benefit fields change (Req 14.5).
 */
export interface ChangeDetectorAdapterDeps {
  changeDetectorService: ChangeDetectorService;
  logger?: PipelineLogger;
}

export function createChangeDetectorAdapter(
  deps: ChangeDetectorAdapterDeps,
): OrchestratorChangeDetector {
  const logger = deps.logger ?? noopLogger;

  return {
    async detectChanges(
      schemeId: string,
      scheme: SchemeObject,
      isNew: boolean,
    ): Promise<void> {
      logger.info('Running change detection', { schemeId, isNew });

      const result: DetectChangesResult =
        await deps.changeDetectorService.detectChanges(
          schemeId,
          scheme,
          scheme.sourceUrl,
        );

      if (result.changedFields.length === 0) {
        logger.info('No changes detected for scheme', { schemeId });
        return;
      }

      logger.info('Changes detected', {
        schemeId,
        changedFields: result.changedFields,
        versionId: result.versionId,
      });

      // Trigger notifications for affected citizens (Req 14.3)
      // The ChangeDetectorService handles finding saved-scheme users
      // and dispatching notifications.
      try {
        await deps.changeDetectorService.notifyAffectedCitizens(
          schemeId,
          result.changedFields,
          {
            versionId: result.versionId ?? undefined,
            sourceUrl: scheme.sourceUrl,
            changeDetectedAt: new Date(),
          },
        );
        logger.info('Citizen notifications dispatched for scheme changes', {
          schemeId,
          changedFields: result.changedFields,
        });
      } catch (err) {
        logger.error('Failed to notify citizens of scheme changes', {
          schemeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // If benefits changed, trigger recalculation (Req 14.5)
      if (result.changedFields.includes('benefits')) {
        try {
          await deps.changeDetectorService.recalculateBenefitValuesForSubscribers(
            schemeId,
          );
          logger.info('Benefit recalculation triggered', { schemeId });
        } catch (err) {
          logger.error('Failed to trigger benefit recalculation', {
            schemeId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}

// ─── Pipeline Integration ────────────────────────────────────────────────────

export interface CrawlerPipelineIntegrationDeps {
  sourceFailureStore: SourceFailureStore;
  logger?: PipelineLogger;
  /** Clock override for testing. */
  now?: () => Date;
}

export interface PipelinePostProcessResult {
  /** Sources newly flagged as unreachable in this run. */
  newlyFlaggedSources: string[];
  /** Sources whose failure count was reset (successful crawl). */
  resetSources: string[];
}

/**
 * Post-processes a {@link CrawlResult} to update source failure tracking.
 *
 * For each failed source:
 *   - Increments consecutive failure count
 *   - If count reaches threshold, flags the source as unreachable
 *
 * For each successfully crawled source (not in failedSources):
 *   - Resets the consecutive failure count
 *
 * Returns information about newly flagged and reset sources.
 */
export class CrawlerPipelineIntegration {
  private readonly store: SourceFailureStore;
  private readonly logger: PipelineLogger;
  private readonly now: () => Date;

  constructor(deps: CrawlerPipelineIntegrationDeps) {
    this.store = deps.sourceFailureStore;
    this.logger = deps.logger ?? noopLogger;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Processes crawl results to track source failures and flag
   * unreachable sources after 3 consecutive failures.
   *
   * @param crawlResult — the result from CrawlerOrchestrator.executeDailyCrawl
   * @param allSourceUrls — the complete list of source URLs attempted
   */
  async processSourceFailures(
    crawlResult: CrawlResult,
    allSourceUrls: string[],
  ): Promise<PipelinePostProcessResult> {
    const failedUrls = new Set(crawlResult.failedSources.map((f) => f.url));
    const newlyFlaggedSources: string[] = [];
    const resetSources: string[] = [];

    this.logger.info('Processing source failures', {
      totalSources: allSourceUrls.length,
      failedCount: crawlResult.failedSources.length,
    });

    // Process failed sources
    for (const failedSource of crawlResult.failedSources) {
      const record = await this.store.incrementFailure(
        failedSource.url,
        this.now(),
      );

      this.logger.warn('Source crawl failed', {
        url: failedSource.url,
        reason: failedSource.reason,
        consecutiveFailures: record.consecutiveFailures,
      });

      if (
        record.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD &&
        !record.flaggedUnreachable
      ) {
        await this.store.flagAsUnreachable(failedSource.url, this.now());
        newlyFlaggedSources.push(failedSource.url);

        this.logger.error('Source flagged as unreachable after consecutive failures', {
          url: failedSource.url,
          consecutiveFailures: record.consecutiveFailures,
          threshold: CONSECUTIVE_FAILURE_THRESHOLD,
        });
      }
    }

    // Reset failure counts for successfully processed sources
    for (const url of allSourceUrls) {
      if (!failedUrls.has(url)) {
        await this.store.resetFailures(url);
        resetSources.push(url);
      }
    }

    if (resetSources.length > 0) {
      this.logger.info('Reset failure counts for successful sources', {
        count: resetSources.length,
      });
    }

    return { newlyFlaggedSources, resetSources };
  }

  /**
   * Returns all sources currently flagged as unreachable.
   */
  async getUnreachableSources(): Promise<SourceFailureRecord[]> {
    return this.store.getUnreachableSources();
  }

  /**
   * Returns the failure record for a specific source URL.
   */
  async getSourceFailureRecord(url: string): Promise<SourceFailureRecord | null> {
    return this.store.getFailureRecord(url);
  }
}

// ─── Full Pipeline Runner ────────────────────────────────────────────────────

export interface RunCrawlerPipelineOptions {
  /** Source URLs to crawl. */
  sourceUrls: string[];
  /** The orchestrator instance to use for crawling. */
  orchestrator: {
    executeDailyCrawl(sourceUrls: string[]): Promise<CrawlResult>;
  };
  /** Pipeline integration for source failure tracking. */
  pipelineIntegration: CrawlerPipelineIntegration;
  /** Logger for pipeline-level visibility. */
  logger?: PipelineLogger;
}

export interface CrawlerPipelineResult {
  /** The raw crawl result from the orchestrator. */
  crawlResult: CrawlResult;
  /** Post-processing result from failure tracking. */
  failureTracking: PipelinePostProcessResult;
}

/**
 * Executes the full crawler pipeline:
 *   1. Run daily crawl via the orchestrator (handles: fetch → parse →
 *      store in PostgreSQL → generate embeddings → index in vector DB →
 *      index in Elasticsearch → run change detection → extract compatibility)
 *   2. Post-process: track source failures and flag unreachable sources
 *
 * The orchestrator's ChangeDetector adapter (created via
 * {@link createChangeDetectorAdapter}) handles triggering citizen
 * notifications after change detection.
 */
export async function runCrawlerPipeline(
  options: RunCrawlerPipelineOptions,
): Promise<CrawlerPipelineResult> {
  const logger = options.logger ?? noopLogger;

  logger.info('Starting crawler pipeline', {
    sourceCount: options.sourceUrls.length,
    startedAt: new Date().toISOString(),
  });

  // Step 1: Execute the daily crawl
  const crawlResult = await options.orchestrator.executeDailyCrawl(
    options.sourceUrls,
  );

  logger.info('Crawler orchestrator completed', {
    newSchemes: crawlResult.newSchemes,
    updatedSchemes: crawlResult.updatedSchemes,
    failedSources: crawlResult.failedSources.length,
    durationMs: crawlResult.duration,
  });

  // Step 2: Process source failures (flag unreachable after 3 failures)
  const failureTracking =
    await options.pipelineIntegration.processSourceFailures(
      crawlResult,
      options.sourceUrls,
    );

  if (failureTracking.newlyFlaggedSources.length > 0) {
    logger.warn('Sources newly flagged as unreachable', {
      sources: failureTracking.newlyFlaggedSources,
    });
  }

  logger.info('Crawler pipeline completed', {
    newSchemes: crawlResult.newSchemes,
    updatedSchemes: crawlResult.updatedSchemes,
    failedSources: crawlResult.failedSources.length,
    newlyFlaggedUnreachable: failureTracking.newlyFlaggedSources.length,
    completedAt: crawlResult.completedAt.toISOString(),
  });

  return { crawlResult, failureTracking };
}
