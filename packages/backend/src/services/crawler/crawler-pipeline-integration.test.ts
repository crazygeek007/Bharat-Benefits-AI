/**
 * Unit tests for the Crawler Pipeline Integration module.
 *
 * Verifies:
 *   - Change detector adapter triggers notifications on scheme changes (Req 14.3)
 *   - Change detector adapter triggers benefit recalculation when benefits change (Req 14.5)
 *   - Source failure tracker increments failure counts correctly
 *   - Sources are flagged unreachable after 3 consecutive failures (Req 1.8)
 *   - Successful crawls reset the failure count
 *   - Full pipeline runner coordinates orchestrator + failure tracking
 *   - Pipeline logging provides admin visibility into each step
 *
 * Validates: Requirements 1.4, 1.5, 1.8, 14.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CrawlResult, SchemeObject } from '@bharat-benefits/shared';

import {
  CONSECUTIVE_FAILURE_THRESHOLD,
  CrawlerPipelineIntegration,
  InMemorySourceFailureStore,
  createChangeDetectorAdapter,
  runCrawlerPipeline,
  type PipelineLogger,
  type SourceFailureStore,
} from './crawler-pipeline-integration';

import type { DetectChangesResult } from '../change-detector/change-detector';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSchemeObject(overrides: Partial<SchemeObject> = {}): SchemeObject {
  return {
    name: 'Test Scheme',
    description: 'A test scheme for unit testing.',
    ministry: 'Ministry of Testing',
    eligibilityCriteria: [
      { field: 'age', operator: 'gte', value: 18, description: '18+' },
    ],
    benefits: [
      { type: 'monetary', amount: 5000, description: 'Annual benefit' },
    ],
    sourceUrl: 'https://schemes.gov.in/test-scheme',
    applicationProcess: null,
    requiredDocuments: null,
    deadline: null,
    ...overrides,
  };
}

function makeCrawlResult(overrides: Partial<CrawlResult> = {}): CrawlResult {
  return {
    newSchemes: 1,
    updatedSchemes: 0,
    failedSources: [],
    duration: 1000,
    completedAt: new Date(),
    ...overrides,
  };
}

function createMockLogger(): PipelineLogger & {
  infoCalls: Array<[string, Record<string, unknown>?]>;
  warnCalls: Array<[string, Record<string, unknown>?]>;
  errorCalls: Array<[string, Record<string, unknown>?]>;
} {
  const infoCalls: Array<[string, Record<string, unknown>?]> = [];
  const warnCalls: Array<[string, Record<string, unknown>?]> = [];
  const errorCalls: Array<[string, Record<string, unknown>?]> = [];
  return {
    infoCalls,
    warnCalls,
    errorCalls,
    info: (msg, ctx) => infoCalls.push([msg, ctx]),
    warn: (msg, ctx) => warnCalls.push([msg, ctx]),
    error: (msg, ctx) => errorCalls.push([msg, ctx]),
  };
}

// ─── ChangeDetectorAdapter Tests ─────────────────────────────────────────────

describe('createChangeDetectorAdapter', () => {
  it('calls detectChanges on the ChangeDetectorService', async () => {
    const detectChanges = vi.fn().mockResolvedValue({
      changedFields: [],
      versionId: null,
    } satisfies DetectChangesResult);

    const notifyAffectedCitizens = vi.fn().mockResolvedValue(undefined);
    const recalculateBenefitValuesForSubscribers = vi.fn().mockResolvedValue(undefined);

    const service = {
      detectChanges,
      notifyAffectedCitizens,
      recalculateBenefitValuesForSubscribers,
    } as any;

    const adapter = createChangeDetectorAdapter({
      changeDetectorService: service,
    });

    const scheme = makeSchemeObject();
    await adapter.detectChanges('scheme-1', scheme, true);

    expect(detectChanges).toHaveBeenCalledWith(
      'scheme-1',
      scheme,
      scheme.sourceUrl,
    );
    // No changes → no notification
    expect(notifyAffectedCitizens).not.toHaveBeenCalled();
    expect(recalculateBenefitValuesForSubscribers).not.toHaveBeenCalled();
  });

  it('triggers citizen notifications when changes are detected (Req 14.3)', async () => {
    const detectChanges = vi.fn().mockResolvedValue({
      changedFields: ['name', 'description'],
      versionId: 'v-123',
    } satisfies DetectChangesResult);

    const notifyAffectedCitizens = vi.fn().mockResolvedValue(undefined);
    const recalculateBenefitValuesForSubscribers = vi.fn().mockResolvedValue(undefined);

    const service = {
      detectChanges,
      notifyAffectedCitizens,
      recalculateBenefitValuesForSubscribers,
    } as any;

    const adapter = createChangeDetectorAdapter({
      changeDetectorService: service,
    });

    const scheme = makeSchemeObject();
    await adapter.detectChanges('scheme-1', scheme, false);

    expect(notifyAffectedCitizens).toHaveBeenCalledWith(
      'scheme-1',
      ['name', 'description'],
      expect.objectContaining({
        versionId: 'v-123',
        sourceUrl: scheme.sourceUrl,
      }),
    );
  });

  it('triggers benefit recalculation when benefits field changes (Req 14.5)', async () => {
    const detectChanges = vi.fn().mockResolvedValue({
      changedFields: ['benefits', 'description'],
      versionId: 'v-456',
    } satisfies DetectChangesResult);

    const notifyAffectedCitizens = vi.fn().mockResolvedValue(undefined);
    const recalculateBenefitValuesForSubscribers = vi.fn().mockResolvedValue(undefined);

    const service = {
      detectChanges,
      notifyAffectedCitizens,
      recalculateBenefitValuesForSubscribers,
    } as any;

    const adapter = createChangeDetectorAdapter({
      changeDetectorService: service,
    });

    await adapter.detectChanges('scheme-2', makeSchemeObject(), false);

    expect(recalculateBenefitValuesForSubscribers).toHaveBeenCalledWith('scheme-2');
  });

  it('does not trigger benefit recalculation when benefits did not change', async () => {
    const detectChanges = vi.fn().mockResolvedValue({
      changedFields: ['name'],
      versionId: 'v-789',
    } satisfies DetectChangesResult);

    const recalculateBenefitValuesForSubscribers = vi.fn().mockResolvedValue(undefined);

    const service = {
      detectChanges,
      notifyAffectedCitizens: vi.fn().mockResolvedValue(undefined),
      recalculateBenefitValuesForSubscribers,
    } as any;

    const adapter = createChangeDetectorAdapter({
      changeDetectorService: service,
    });

    await adapter.detectChanges('scheme-3', makeSchemeObject(), false);

    expect(recalculateBenefitValuesForSubscribers).not.toHaveBeenCalled();
  });

  it('logs errors and does not throw when notification dispatch fails', async () => {
    const detectChanges = vi.fn().mockResolvedValue({
      changedFields: ['name'],
      versionId: 'v-err',
    } satisfies DetectChangesResult);

    const notifyAffectedCitizens = vi
      .fn()
      .mockRejectedValue(new Error('notification service down'));

    const service = {
      detectChanges,
      notifyAffectedCitizens,
      recalculateBenefitValuesForSubscribers: vi.fn(),
    } as any;

    const logger = createMockLogger();
    const adapter = createChangeDetectorAdapter({
      changeDetectorService: service,
      logger,
    });

    // Should not throw
    await adapter.detectChanges('scheme-4', makeSchemeObject(), false);

    expect(logger.errorCalls.length).toBeGreaterThan(0);
    expect(logger.errorCalls[0][0]).toMatch(/failed to notify/i);
  });
});

// ─── InMemorySourceFailureStore Tests ────────────────────────────────────────

describe('InMemorySourceFailureStore', () => {
  let store: InMemorySourceFailureStore;

  beforeEach(() => {
    store = new InMemorySourceFailureStore();
  });

  it('returns null for an unknown URL', async () => {
    const record = await store.getFailureRecord('https://gov.in/unknown');
    expect(record).toBeNull();
  });

  it('increments failure count correctly', async () => {
    const url = 'https://schemes.gov.in/failing';
    const now = new Date();

    const r1 = await store.incrementFailure(url, now);
    expect(r1.consecutiveFailures).toBe(1);
    expect(r1.flaggedUnreachable).toBe(false);

    const r2 = await store.incrementFailure(url, now);
    expect(r2.consecutiveFailures).toBe(2);

    const r3 = await store.incrementFailure(url, now);
    expect(r3.consecutiveFailures).toBe(3);
  });

  it('resets failure count on success', async () => {
    const url = 'https://schemes.gov.in/intermittent';
    const now = new Date();

    await store.incrementFailure(url, now);
    await store.incrementFailure(url, now);
    await store.resetFailures(url);

    const record = await store.getFailureRecord(url);
    expect(record!.consecutiveFailures).toBe(0);
  });

  it('flags source as unreachable', async () => {
    const url = 'https://schemes.gov.in/down';
    const now = new Date();

    await store.incrementFailure(url, now);
    await store.flagAsUnreachable(url, now);

    const record = await store.getFailureRecord(url);
    expect(record!.flaggedUnreachable).toBe(true);
    expect(record!.flaggedAt).toEqual(now);
  });

  it('getUnreachableSources returns only flagged sources', async () => {
    const now = new Date();

    await store.incrementFailure('https://gov.in/a', now);
    await store.incrementFailure('https://gov.in/b', now);
    await store.flagAsUnreachable('https://gov.in/b', now);

    const unreachable = await store.getUnreachableSources();
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0].url).toBe('https://gov.in/b');
  });
});

// ─── CrawlerPipelineIntegration Tests ────────────────────────────────────────

describe('CrawlerPipelineIntegration', () => {
  let store: InMemorySourceFailureStore;
  let logger: ReturnType<typeof createMockLogger>;
  let integration: CrawlerPipelineIntegration;
  const fixedNow = new Date('2024-06-01T12:00:00Z');

  beforeEach(() => {
    store = new InMemorySourceFailureStore();
    logger = createMockLogger();
    integration = new CrawlerPipelineIntegration({
      sourceFailureStore: store,
      logger,
      now: () => fixedNow,
    });
  });

  it('increments failure count for failed sources', async () => {
    const urls = ['https://schemes.gov.in/a', 'https://schemes.gov.in/b'];
    const crawlResult = makeCrawlResult({
      failedSources: [
        { url: urls[0], reason: 'timeout', errorCode: 'TIMEOUT' },
      ],
    });

    await integration.processSourceFailures(crawlResult, urls);

    const record = await store.getFailureRecord(urls[0]);
    expect(record!.consecutiveFailures).toBe(1);
    expect(record!.flaggedUnreachable).toBe(false);
  });

  it('flags source as unreachable after 3 consecutive failures (Req 1.8)', async () => {
    const url = 'https://schemes.gov.in/unreliable';
    const urls = [url];

    // Simulate 3 consecutive failures
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD; i++) {
      const crawlResult = makeCrawlResult({
        failedSources: [{ url, reason: 'connection refused', errorCode: 'UNKNOWN' }],
      });
      await integration.processSourceFailures(crawlResult, urls);
    }

    const record = await store.getFailureRecord(url);
    expect(record!.consecutiveFailures).toBe(CONSECUTIVE_FAILURE_THRESHOLD);
    expect(record!.flaggedUnreachable).toBe(true);
    expect(record!.flaggedAt).toEqual(fixedNow);
  });

  it('resets failure count for successfully crawled sources', async () => {
    const url = 'https://schemes.gov.in/recovering';
    const urls = [url];

    // Record 2 failures
    await store.incrementFailure(url, fixedNow);
    await store.incrementFailure(url, fixedNow);

    // Successful crawl
    const crawlResult = makeCrawlResult({ failedSources: [] });
    const result = await integration.processSourceFailures(crawlResult, urls);

    expect(result.resetSources).toContain(url);
    const record = await store.getFailureRecord(url);
    expect(record!.consecutiveFailures).toBe(0);
  });

  it('returns newly flagged sources in the result', async () => {
    const url = 'https://schemes.gov.in/doomed';

    // Pre-load 2 failures
    await store.incrementFailure(url, fixedNow);
    await store.incrementFailure(url, fixedNow);

    // Third failure triggers flagging
    const crawlResult = makeCrawlResult({
      failedSources: [{ url, reason: 'dns failure', errorCode: 'UNKNOWN' }],
    });
    const result = await integration.processSourceFailures(crawlResult, [url]);

    expect(result.newlyFlaggedSources).toContain(url);
  });

  it('does not double-flag already unreachable sources', async () => {
    const url = 'https://schemes.gov.in/already-flagged';

    // Manually flag
    await store.incrementFailure(url, fixedNow);
    await store.incrementFailure(url, fixedNow);
    await store.incrementFailure(url, fixedNow);
    await store.flagAsUnreachable(url, fixedNow);

    // Fourth failure — should not appear in newly flagged
    const crawlResult = makeCrawlResult({
      failedSources: [{ url, reason: 'still down', errorCode: 'UNKNOWN' }],
    });
    const result = await integration.processSourceFailures(crawlResult, [url]);

    expect(result.newlyFlaggedSources).not.toContain(url);
  });

  it('logs pipeline steps for admin visibility', async () => {
    const url = 'https://schemes.gov.in/logged';
    const crawlResult = makeCrawlResult({
      failedSources: [{ url, reason: 'error', errorCode: 'UNKNOWN' }],
    });

    await integration.processSourceFailures(crawlResult, [url]);

    // Should have logged about processing and about the failure
    expect(logger.infoCalls.length).toBeGreaterThan(0);
    expect(logger.warnCalls.length).toBeGreaterThan(0);
  });
});

// ─── runCrawlerPipeline Tests ────────────────────────────────────────────────

describe('runCrawlerPipeline', () => {
  it('coordinates the orchestrator and failure tracking', async () => {
    const urls = ['https://schemes.gov.in/a', 'https://schemes.gov.in/b'];
    const crawlResult = makeCrawlResult({
      newSchemes: 1,
      updatedSchemes: 1,
      failedSources: [],
    });

    const orchestrator = {
      executeDailyCrawl: vi.fn().mockResolvedValue(crawlResult),
    };

    const store = new InMemorySourceFailureStore();
    const pipelineIntegration = new CrawlerPipelineIntegration({
      sourceFailureStore: store,
    });

    const result = await runCrawlerPipeline({
      sourceUrls: urls,
      orchestrator,
      pipelineIntegration,
    });

    expect(orchestrator.executeDailyCrawl).toHaveBeenCalledWith(urls);
    expect(result.crawlResult).toBe(crawlResult);
    expect(result.failureTracking.newlyFlaggedSources).toHaveLength(0);
    expect(result.failureTracking.resetSources).toEqual(urls);
  });

  it('flags unreachable sources after pipeline execution', async () => {
    const url = 'https://schemes.gov.in/failing-source';
    const urls = [url];

    const store = new InMemorySourceFailureStore();
    // Pre-load 2 failures
    await store.incrementFailure(url, new Date());
    await store.incrementFailure(url, new Date());

    const crawlResult = makeCrawlResult({
      newSchemes: 0,
      failedSources: [{ url, reason: 'network error', errorCode: 'UNKNOWN' }],
    });

    const orchestrator = {
      executeDailyCrawl: vi.fn().mockResolvedValue(crawlResult),
    };

    const pipelineIntegration = new CrawlerPipelineIntegration({
      sourceFailureStore: store,
    });

    const result = await runCrawlerPipeline({
      sourceUrls: urls,
      orchestrator,
      pipelineIntegration,
    });

    expect(result.failureTracking.newlyFlaggedSources).toContain(url);
  });

  it('logs pipeline start, completion, and warnings', async () => {
    const urls = ['https://schemes.gov.in/x'];
    const crawlResult = makeCrawlResult({
      failedSources: [
        { url: urls[0], reason: 'fail', errorCode: 'UNKNOWN' },
      ],
    });

    const orchestrator = {
      executeDailyCrawl: vi.fn().mockResolvedValue(crawlResult),
    };

    const store = new InMemorySourceFailureStore();
    // Pre-load to hit threshold
    await store.incrementFailure(urls[0], new Date());
    await store.incrementFailure(urls[0], new Date());

    const logger = createMockLogger();
    const pipelineIntegration = new CrawlerPipelineIntegration({
      sourceFailureStore: store,
      logger,
    });

    await runCrawlerPipeline({
      sourceUrls: urls,
      orchestrator,
      pipelineIntegration,
      logger,
    });

    // The pipeline runner should log start and completion
    const pipelineInfoMessages = logger.infoCalls.map(([msg]) => msg);
    expect(pipelineInfoMessages).toContain('Starting crawler pipeline');
    expect(pipelineInfoMessages).toContain('Crawler orchestrator completed');
    expect(pipelineInfoMessages).toContain('Crawler pipeline completed');
  });
});
