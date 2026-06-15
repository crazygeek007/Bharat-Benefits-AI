/**
 * Crawler Orchestrator — Daily Crawl Workflow
 *
 * Coordinates the full daily-crawl pipeline:
 *
 *   discovery → fetch → parse → validate source → enforce mandatory fields
 *     → trust score → categorise → DB upsert → embed → search index
 *     → change detection → compatibility extraction
 *
 * The orchestrator is intentionally I/O-free: every external dependency
 * (fetcher, persistence, vector index, search index, change detector,
 * notifier, parsers, source validator) is injected through the
 * {@link CrawlerOrchestratorDeps} interface so the unit tests can drive
 * the workflow with fakes and the production wiring can attach real
 * Prisma / Pinecone / Elasticsearch clients without changing this file.
 *
 * Service-level objectives expressed in code:
 *   - Per-scheme timeout enforces "process within 10 minutes of discovery"
 *     (Requirement 1.5) — defaults to 10 minutes, configurable.
 *   - Concurrency limit (default 10) keeps fan-out bounded so the overall
 *     6-hour soft deadline (Requirement 1.4) holds for realistic source
 *     counts.
 *   - Soft overall deadline aborts further dispatch and logs a timeout
 *     entry once exceeded.
 *   - Failures are batched and surfaced to the {@link AdminNotifier}
 *     within the same crawl run (Requirements 1.8, 1.9). Production
 *     notifier implementations are expected to deliver inside 15 minutes.
 *
 * Validates: Requirements 1.4, 1.5, 1.8, 1.9, 7.5, 7.6
 */

import type {
  CompatibilityRelation,
  CrawlResult,
  FailedSource,
  ProcessedScheme,
  RawSchemeData,
  SchemeCategory,
  SchemeObject,
  SchemeRelationshipType,
} from '@bharat-benefits/shared';

import {
  buildIngestedRecord,
  type IngestedRecord,
} from './ingestion-helpers';
import {
  enforceMandatoryFields,
  isRejected,
} from './parsers/mandatory-field-enforcer';
import { parseHTML } from './parsers/html.parser';
import { parseJSON } from './parsers/json.parser';
import { parseXML } from './parsers/xml.parser';
import { parsePDF } from './parsers/pdf.parser';
import { validateSource } from './source-validator';
import type { AdminNotifier, AdminFailureNotification } from './notifier';

// ─── Dependency interfaces ───────────────────────────────────────────────────

/** Fetches the raw bytes/text of a source URL. */
export interface SchemeFetcher {
  fetch(url: string): Promise<RawSchemeData>;
}

/** Result of upserting a scheme into the primary store. */
export interface UpsertResult {
  schemeId: string;
  /** True when the scheme record did not exist before this call. */
  created: boolean;
}

/** Primary persistence layer (Postgres/Prisma in production). */
export interface SchemePersistence {
  upsertScheme(record: IngestedRecord): Promise<UpsertResult>;
}

/** Vector index for semantic search (Pinecone/pgvector in production). */
export interface VectorIndexer {
  indexScheme(schemeId: string, scheme: SchemeObject): Promise<void>;
}

/** Full-text search index (Elasticsearch in production). */
export interface SearchIndexer {
  indexScheme(schemeId: string, scheme: SchemeObject): Promise<void>;
}

/** Detects diffs against the previously stored version of a scheme. */
export interface ChangeDetector {
  detectChanges(
    schemeId: string,
    scheme: SchemeObject,
    isNew: boolean,
  ): Promise<void>;
}

/** Persists compatibility relations extracted from a scheme. */
export interface CompatibilityStore {
  recordRelations(
    schemeId: string,
    relations: CompatibilityRelation[],
  ): Promise<void>;
}

/** Categoriser — assigns a {@link SchemeCategory} to a scheme. */
export interface SchemeCategorizer {
  categorize(scheme: SchemeObject): SchemeCategory | null;
}

/** Optional structured logger. */
export interface OrchestratorLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: OrchestratorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Source-of-time abstraction for deterministic testing. */
export type Clock = () => Date;

export interface CrawlerOrchestratorDeps {
  fetcher: SchemeFetcher;
  persistence: SchemePersistence;
  vectorIndexer: VectorIndexer;
  searchIndexer: SearchIndexer;
  changeDetector: ChangeDetector;
  compatibilityStore: CompatibilityStore;
  notifier: AdminNotifier;
  /** Categoriser — defaults to {@link defaultCategorizer}. */
  categorizer?: SchemeCategorizer;
  logger?: OrchestratorLogger;
  clock?: Clock;
}

export interface CrawlerOrchestratorConfig {
  /**
   * Maximum concurrent in-flight scheme processings. Defaults to 10.
   * Bounds fan-out across downstream services (parsers, vector DB,
   * search index) so the daily crawl stays inside its 6-hour budget.
   */
  concurrency?: number;
  /**
   * Per-scheme timeout, in milliseconds. Defaults to 10 minutes
   * (Requirement 1.5). The orchestrator aborts a scheme whose pipeline
   * exceeds this budget and counts it as a failed source.
   */
  perSchemeTimeoutMs?: number;
  /**
   * Soft overall deadline for the entire crawl, in milliseconds.
   * Defaults to 6 hours (Requirement 1.4). When exceeded, no further
   * sources are dispatched; in-flight work is allowed to finish.
   */
  overallDeadlineMs?: number;
  /**
   * Failure threshold (0–1) above which a critical alert is raised
   * regardless of total failure count. Defaults to 0.5 (more than half
   * of attempted sources failed).
   */
  criticalFailureRateThreshold?: number;
}

export const DEFAULT_CONCURRENCY = 10;
export const DEFAULT_PER_SCHEME_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_OVERALL_DEADLINE_MS = 6 * 60 * 60 * 1000; // 6 hours
export const DEFAULT_CRITICAL_FAILURE_RATE = 0.5;

/** Discriminated rejection result returned by {@link CrawlerOrchestrator.processScheme}. */
export interface SchemeRejection {
  rejected: true;
  reason: string;
}

export type ProcessSchemeResult = ProcessedScheme | SchemeRejection;

export function isSchemeRejection(
  result: ProcessSchemeResult,
): result is SchemeRejection {
  return (result as SchemeRejection).rejected === true;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export class CrawlerOrchestrator {
  private readonly deps: Required<
    Pick<
      CrawlerOrchestratorDeps,
      | 'fetcher'
      | 'persistence'
      | 'vectorIndexer'
      | 'searchIndexer'
      | 'changeDetector'
      | 'compatibilityStore'
      | 'notifier'
      | 'categorizer'
      | 'logger'
      | 'clock'
    >
  >;
  private readonly config: Required<CrawlerOrchestratorConfig>;

  constructor(deps: CrawlerOrchestratorDeps, config: CrawlerOrchestratorConfig = {}) {
    this.deps = {
      fetcher: deps.fetcher,
      persistence: deps.persistence,
      vectorIndexer: deps.vectorIndexer,
      searchIndexer: deps.searchIndexer,
      changeDetector: deps.changeDetector,
      compatibilityStore: deps.compatibilityStore,
      notifier: deps.notifier,
      categorizer: deps.categorizer ?? defaultCategorizer,
      logger: deps.logger ?? noopLogger,
      clock: deps.clock ?? (() => new Date()),
    };
    this.config = {
      concurrency: config.concurrency ?? DEFAULT_CONCURRENCY,
      perSchemeTimeoutMs:
        config.perSchemeTimeoutMs ?? DEFAULT_PER_SCHEME_TIMEOUT_MS,
      overallDeadlineMs: config.overallDeadlineMs ?? DEFAULT_OVERALL_DEADLINE_MS,
      criticalFailureRateThreshold:
        config.criticalFailureRateThreshold ?? DEFAULT_CRITICAL_FAILURE_RATE,
    };
  }

  /**
   * Executes the daily crawl over `sourceUrls`. Returns aggregate counts
   * and a list of failed sources. Always resolves; per-source errors are
   * captured into the {@link CrawlResult.failedSources} array and never
   * thrown.
   */
  async executeDailyCrawl(sourceUrls: string[]): Promise<CrawlResult> {
    const startedAt = this.deps.clock().getTime();
    const overallDeadlineAt = startedAt + this.config.overallDeadlineMs;

    let newSchemes = 0;
    let updatedSchemes = 0;
    const failedSources: FailedSource[] = [];

    // Track the index of the next URL to dispatch. Workers pull from
    // this shared cursor to enforce the concurrency limit without
    // depending on a third-party limiter library.
    let cursor = 0;
    const total = sourceUrls.length;

    const runWorker = async (): Promise<void> => {
      // `for (;;)` is preferred over `while (true)` per the ESLint
      // `no-constant-condition` rule. The body breaks out either when
      // the deadline expires or when the cursor passes the URL list.
      for (;;) {
        // Honour the overall soft deadline.
        if (this.deps.clock().getTime() > overallDeadlineAt) {
          this.deps.logger.warn(
            'Daily crawl exceeded overall deadline; halting further dispatch',
            {
              elapsedMs: this.deps.clock().getTime() - startedAt,
              dispatched: cursor,
              total,
            },
          );
          return;
        }
        const idx = cursor++;
        if (idx >= total) return;

        const url = sourceUrls[idx];
        const outcome = await this.crawlSingleSource(url);
        switch (outcome.kind) {
          case 'created':
            newSchemes++;
            break;
          case 'updated':
            updatedSchemes++;
            break;
          case 'failed':
            failedSources.push(outcome.failure);
            break;
        }
      }
    };

    const workerCount = Math.max(1, Math.min(this.config.concurrency, total));
    const workers: Promise<void>[] = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(runWorker());
    }
    await Promise.all(workers);

    const completedAt = this.deps.clock();
    const duration = completedAt.getTime() - startedAt;

    if (failedSources.length > 0) {
      // Best-effort: never let a notifier failure crash the crawl.
      try {
        await this.notifyAdminsOnFailure(failedSources, total);
      } catch (err) {
        this.deps.logger.error('Admin notifier threw while reporting failures', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (duration > this.config.overallDeadlineMs) {
      this.deps.logger.warn('Daily crawl finished past 6-hour soft deadline', {
        durationMs: duration,
        deadlineMs: this.config.overallDeadlineMs,
      });
    }

    const result: CrawlResult = {
      newSchemes,
      updatedSchemes,
      failedSources,
      duration,
      completedAt,
    };

    // Notify admins of the crawl outcome regardless of failures so
    // dashboards / audit trails always see one event per run. Best-effort:
    // never let a notifier failure crash the crawl.
    try {
      await this.deps.notifier.notifyCrawlComplete(result);
    } catch (err) {
      this.deps.logger.error('Admin notifier threw on crawl-complete', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return result;
  }

  /**
   * Processes a single raw scheme payload through the validation,
   * mandatory-field, trust-score and categorisation stages. Does not
   * persist or index — those side-effects are driven by
   * {@link executeDailyCrawl}'s pipeline. Returns either a
   * {@link ProcessedScheme} or a typed rejection.
   */
  async processScheme(rawData: RawSchemeData): Promise<ProcessSchemeResult> {
    if (!validateSource(rawData.url)) {
      return {
        rejected: true,
        reason: `Source URL does not belong to an official domain: ${rawData.url}`,
      };
    }

    let partial: Partial<SchemeObject>;
    try {
      partial = await this.parseRaw(rawData);
    } catch (err) {
      return {
        rejected: true,
        reason: `Parser threw while extracting scheme: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    const enforced = enforceMandatoryFields(partial, rawData.url);
    if (isRejected(enforced)) {
      return {
        rejected: true,
        reason: `Missing mandatory fields: ${enforced.missingFields.join(', ')}`,
      };
    }

    const now = this.deps.clock();
    const ingested = buildIngestedRecord(enforced, {
      discoveredAt: rawData.fetchedAt ?? now,
      lastVerifiedAt: now,
      category: this.deps.categorizer.categorize(enforced),
      now,
    });

    return {
      schemeObject: ingested.schemeObject,
      sourceUrl: ingested.sourceUrl,
      trustScore: ingested.trustScore,
      verified: ingested.verified,
      discoveredAt: ingested.discoveredAt,
      lastVerifiedAt: ingested.lastVerifiedAt,
      category: ingested.category,
      state: ingested.state,
    };
  }

  /**
   * Invokes the {@link AdminNotifier} for a batch of failed sources.
   * Decides severity based on the failure rate (`failures / attempted`).
   * Production notifier implementations are responsible for delivering
   * within 15 minutes per Requirement 1.9.
   */
  async notifyAdminsOnFailure(
    failures: FailedSource[],
    totalAttempted: number = failures.length,
  ): Promise<void> {
    if (failures.length === 0) return;

    const failureRate = totalAttempted === 0 ? 1 : failures.length / totalAttempted;
    const severity =
      failureRate >= this.config.criticalFailureRateThreshold
        ? 'critical'
        : 'warning';

    const notification: AdminFailureNotification = {
      severity,
      totalFailed: failures.length,
      totalAttempted,
      failures: failures.map((f) => ({ ...f })),
      detectedAt: this.deps.clock(),
      summary: `${failures.length}/${totalAttempted} sources failed during daily crawl`,
    };

    this.deps.logger.warn('Notifying admins of crawl failures', {
      severity,
      totalFailed: failures.length,
      totalAttempted,
      failureRate,
    });

    await this.deps.notifier.notifyFailures(notification);
  }

  /**
   * Extracts compatibility relationships from an already-processed
   * scheme. This is a deliberately conservative implementation that
   * recognises a small set of explicit phrases in the description and
   * returns an empty array for schemes whose compatibility status is
   * unknown (Requirement 7.6).
   *
   * Recognised cues (case-insensitive):
   *   - "can be combined with X"     → can_combine_with X
   *   - "compatible with X"          → can_combine_with X
   *   - "cannot be combined with X"  → cannot_combine_with X
   *   - "not eligible if availing X" → cannot_combine_with X
   *   - "prerequisite: X" or "requires X" → prerequisite_schemes X
   *
   * Items inside parentheses on the left of the cue are ignored. The
   * right-hand identifier is captured verbatim until the next sentence
   * boundary.
   */
  extractCompatibilityRelations(scheme: ProcessedScheme): CompatibilityRelation[] {
    const text = `${scheme.schemeObject.name}\n${scheme.schemeObject.description}`;
    const relations: CompatibilityRelation[] = [];

    const patterns: Array<{
      regex: RegExp;
      type: SchemeRelationshipType;
    }> = [
      // negative — must come before positive 'combined' to avoid double-match
      {
        regex: /cannot be combined with ([^.;\n]+)/gi,
        type: 'cannot_combine_with',
      },
      {
        regex: /not eligible if availing ([^.;\n]+)/gi,
        type: 'cannot_combine_with',
      },
      {
        regex: /can be combined with ([^.;\n]+)/gi,
        type: 'can_combine_with',
      },
      {
        regex: /compatible with ([^.;\n]+)/gi,
        type: 'can_combine_with',
      },
      {
        regex: /prerequisites?:\s*([^.;\n]+)/gi,
        type: 'prerequisite_schemes',
      },
      {
        regex: /requires? prior enrolment in ([^.;\n]+)/gi,
        type: 'prerequisite_schemes',
      },
    ];

    const seen = new Set<string>();
    for (const { regex, type } of patterns) {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const identifier = match[1].trim().replace(/[.,]+$/, '');
        if (identifier.length === 0) continue;
        const key = `${type}::${identifier.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        relations.push({
          sourceSchemeUrl: scheme.sourceUrl,
          relatedSchemeIdentifier: identifier,
          type,
          officialRule: match[0],
          sourceUrl: scheme.sourceUrl,
        });
      }
    }

    return relations;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /**
   * Crawls a single source URL through the full pipeline, with a
   * per-scheme timeout enforced via {@link withTimeout}. Returns a
   * tagged outcome rather than throwing.
   */
  private async crawlSingleSource(url: string): Promise<
    | { kind: 'created' | 'updated' }
    | { kind: 'failed'; failure: FailedSource }
  > {
    if (!validateSource(url)) {
      return {
        kind: 'failed',
        failure: {
          url,
          reason: 'Source URL does not belong to an official domain',
          errorCode: 'INVALID_SOURCE',
        },
      };
    }

    try {
      const result = await withTimeout(
        this.runPipeline(url),
        this.config.perSchemeTimeoutMs,
        `Per-scheme timeout exceeded for ${url}`,
      );
      return result;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.logger.error('Scheme pipeline failed', {
        url,
        error: reason,
      });
      return {
        kind: 'failed',
        failure: {
          url,
          reason,
          errorCode: classifyError(err),
        },
      };
    }
  }

  /**
   * Runs the full pipeline for one scheme: fetch → process → upsert →
   * embed → search index → change detect → compatibility extract.
   *
   * Errors propagate to {@link crawlSingleSource} which records the
   * failure.
   */
  private async runPipeline(
    url: string,
  ): Promise<{ kind: 'created' | 'updated' }> {
    const raw = await this.deps.fetcher.fetch(url);

    const processed = await this.processScheme(raw);
    if (isSchemeRejection(processed)) {
      throw new Error(processed.reason);
    }

    const ingestedRecord: IngestedRecord = {
      schemeObject: processed.schemeObject,
      sourceUrl: processed.sourceUrl,
      ministry: processed.schemeObject.ministry,
      trustScore: processed.trustScore,
      discoveredAt: processed.discoveredAt,
      lastVerifiedAt: processed.lastVerifiedAt,
      category: processed.category,
      state: processed.state,
      verified: processed.verified,
    };

    const upsert = await this.deps.persistence.upsertScheme(ingestedRecord);

    // Downstream side-effects run sequentially after persistence so that
    // a failure here surfaces as a "failed source" instead of leaking a
    // half-indexed record. Vector + search indices and change detection
    // are independent of each other and could be parallelised — kept
    // serial here for predictable error reporting.
    await this.deps.vectorIndexer.indexScheme(upsert.schemeId, processed.schemeObject);
    await this.deps.searchIndexer.indexScheme(upsert.schemeId, processed.schemeObject);
    await this.deps.changeDetector.detectChanges(
      upsert.schemeId,
      processed.schemeObject,
      upsert.created,
    );

    const relations = this.extractCompatibilityRelations(processed);
    if (relations.length > 0) {
      await this.deps.compatibilityStore.recordRelations(upsert.schemeId, relations);
    }

    return { kind: upsert.created ? 'created' : 'updated' };
  }

  /** Dispatches to the appropriate parser based on the raw content type. */
  private async parseRaw(raw: RawSchemeData): Promise<Partial<SchemeObject>> {
    switch (raw.contentType) {
      case 'html':
        return parseHTML(raw.content, raw.url);
      case 'json':
        return parseJSON(raw.content, raw.url);
      case 'xml':
        return parseXML(raw.content, raw.url);
      case 'pdf': {
        // The orchestrator accepts a base64-encoded buffer for PDFs by
        // convention; this matches `parseSchemeDataAsync`.
        const buffer = Buffer.from(raw.content, 'base64');
        return await parsePDF(buffer, raw.url);
      }
      default: {
        const exhaustive: never = raw.contentType;
        throw new Error(`Unsupported content type: ${String(exhaustive)}`);
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Default categoriser — keyword-based heuristics over the scheme name +
 * description. Returns null when no category is confidently identifiable.
 */
export const defaultCategorizer: SchemeCategorizer = {
  categorize(scheme: SchemeObject): SchemeCategory | null {
    const text = `${scheme.name} ${scheme.description}`.toLowerCase();
    const rules: Array<{ category: SchemeCategory; cues: RegExp }> = [
      { category: 'Education', cues: /\b(education|school|college|study|tuition)\b/ },
      { category: 'Scholarships', cues: /\bscholarship|fellowship\b/ },
      { category: 'Agriculture', cues: /\b(agricultur|farmer|crop|kisan|irrigation)/ },
      { category: 'Healthcare', cues: /\b(health|medical|hospital|insurance|ayushman)/ },
      { category: 'Women', cues: /\b(women|girl child|maternity|mahila)/ },
      { category: 'Employment', cues: /\b(employment|job|wage|labour|labor)\b/ },
      { category: 'Skill Development', cues: /\b(skill|training|apprentice|kaushal)/ },
      { category: 'Housing', cues: /\b(housing|awas|home loan|residence)/ },
      { category: 'Startups', cues: /\bstart-?ups?\b/ },
      { category: 'MSME', cues: /\b(msme|micro|small (and|&) medium)/ },
      { category: 'Pension', cues: /\bpension|vridhha|old.?age\b/ },
      { category: 'Financial Assistance', cues: /\b(loan|grant|subsidy|financial)/ },
    ];
    for (const rule of rules) {
      if (rule.cues.test(text)) return rule.category;
    }
    return null;
  },
};

/**
 * Wraps `promise` in a timeout. If the promise does not settle within
 * `ms` milliseconds, the returned promise rejects with `Error(message)`.
 * The original promise is left to settle in the background — this is
 * acceptable because the orchestrator's downstream steps are idempotent
 * (upsert, change detect, indexers) so a late completion does not
 * corrupt state, but we no longer wait on it.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return promise;
  }
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(message));
    }, ms);
    // `unref` so timers don't keep the process alive in tests.
    if (typeof timer.unref === 'function') timer.unref();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

function classifyError(err: unknown): string {
  if (err instanceof TimeoutError) return 'TIMEOUT';
  if (err instanceof Error) {
    if (/missing mandatory/i.test(err.message)) return 'MANDATORY_FIELDS_MISSING';
    if (/official domain/i.test(err.message)) return 'INVALID_SOURCE';
    if (/parser threw/i.test(err.message)) return 'PARSE_ERROR';
  }
  return 'UNKNOWN';
}
