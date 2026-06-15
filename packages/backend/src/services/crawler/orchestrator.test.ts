/**
 * Unit tests for the daily-crawl {@link CrawlerOrchestrator}.
 *
 * These tests use in-memory fakes for every dependency (fetcher,
 * persistence, vector / search indexers, change detector, compatibility
 * store, notifier) to keep the suite hermetic. No real Prisma /
 * Pinecone / Elasticsearch / HTTP clients are touched.
 *
 * Scenarios covered:
 *   - Single valid URL → newSchemes = 1, no failures, indexers called.
 *   - Single invalid source URL → counted as failure, notifier called.
 *   - Mandatory fields missing → counted as failure.
 *   - Concurrency limit respected.
 *   - Per-scheme timeout marks the slow source failed; siblings finish.
 *   - extractCompatibilityRelations returns [] when no patterns match.
 *   - executeDailyCrawl returns a CrawlResult with correct counts and
 *     non-negative duration.
 *
 * Validates: Requirements 1.4, 1.5, 1.8, 1.9, 7.5, 7.6
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  CrawlResult,
  RawSchemeData,
  SchemeObject,
} from '@bharat-benefits/shared';

import {
  CrawlerOrchestrator,
  type ChangeDetector,
  type CompatibilityStore,
  type SchemeFetcher,
  type SchemePersistence,
  type SearchIndexer,
  type UpsertResult,
  type VectorIndexer,
  type CrawlerOrchestratorDeps,
} from './orchestrator';
import {
  InMemoryAdminNotifier,
  type AdminNotifier,
} from './notifier';
import type { IngestedRecord } from './ingestion-helpers';

// ─── Test fixtures ───────────────────────────────────────────────────────────

const VALID_HOST = 'https://schemes.gov.in';
const INVALID_HOST = 'https://malicious.com/scheme';

interface FakeSchemePayload {
  name: string;
  description: string;
  ministry: string;
  eligibilityCriteria: Array<{ field: string; operator: string; description: string }>;
  benefits: Array<{ type: 'monetary' | 'non-monetary'; amount: number | null; description: string }>;
}

function validJsonPayload(overrides: Partial<FakeSchemePayload> = {}): string {
  const payload: FakeSchemePayload = {
    name: 'PM Sample Yojana',
    description:
      'Sample scheme for unit testing the crawler orchestrator end-to-end pipeline.',
    ministry: 'Ministry of Sample Affairs',
    eligibilityCriteria: [
      { field: 'age', operator: 'gte', description: 'Applicant must be 18+' },
    ],
    benefits: [
      { type: 'monetary', amount: 5000, description: 'Annual support of INR 5,000' },
    ],
    ...overrides,
  };
  return JSON.stringify(payload);
}

function makeRawSchemeData(
  url: string,
  body: string,
  contentType: RawSchemeData['contentType'] = 'json',
): RawSchemeData {
  return { url, content: body, contentType, fetchedAt: new Date() };
}

// ─── Fakes ───────────────────────────────────────────────────────────────────

interface FakeFetcherOptions {
  payloads?: Record<string, RawSchemeData>;
  delayMsByUrl?: Record<string, number>;
  errorByUrl?: Record<string, Error>;
}

class FakeFetcher implements SchemeFetcher {
  public concurrent = 0;
  public peakConcurrent = 0;
  public calls: string[] = [];
  constructor(private readonly opts: FakeFetcherOptions = {}) {}

  async fetch(url: string): Promise<RawSchemeData> {
    this.calls.push(url);
    this.concurrent++;
    if (this.concurrent > this.peakConcurrent) {
      this.peakConcurrent = this.concurrent;
    }
    try {
      const delay = this.opts.delayMsByUrl?.[url];
      if (delay && delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      const err = this.opts.errorByUrl?.[url];
      if (err) throw err;
      const payload = this.opts.payloads?.[url];
      if (payload) return payload;
      // Default: a fresh valid JSON payload tied to the URL.
      return makeRawSchemeData(url, validJsonPayload());
    } finally {
      this.concurrent--;
    }
  }
}

class FakeSchemePersistence implements SchemePersistence {
  public readonly storage = new Map<string, IngestedRecord>();
  public readonly upsertCalls: IngestedRecord[] = [];
  private idCounter = 0;

  async upsertScheme(record: IngestedRecord): Promise<UpsertResult> {
    this.upsertCalls.push(record);
    const existing = this.storage.get(record.sourceUrl);
    if (existing) {
      this.storage.set(record.sourceUrl, record);
      return {
        schemeId: this.deriveId(record.sourceUrl, false),
        created: false,
      };
    }
    const id = this.deriveId(record.sourceUrl, true);
    this.storage.set(record.sourceUrl, record);
    return { schemeId: id, created: true };
  }

  private deriveId(sourceUrl: string, _create: boolean): string {
    if (this.storage.has(sourceUrl)) {
      return `id-${[...this.storage.keys()].indexOf(sourceUrl) + 1}`;
    }
    return `id-${++this.idCounter}`;
  }
}

class FakeVectorIndexer implements VectorIndexer {
  public readonly calls: Array<{ schemeId: string; scheme: SchemeObject }> = [];
  async indexScheme(schemeId: string, scheme: SchemeObject): Promise<void> {
    this.calls.push({ schemeId, scheme });
  }
}

class FakeSearchIndexer implements SearchIndexer {
  public readonly calls: Array<{ schemeId: string; scheme: SchemeObject }> = [];
  async indexScheme(schemeId: string, scheme: SchemeObject): Promise<void> {
    this.calls.push({ schemeId, scheme });
  }
}

class FakeChangeDetector implements ChangeDetector {
  public readonly calls: Array<{
    schemeId: string;
    scheme: SchemeObject;
    isNew: boolean;
  }> = [];
  async detectChanges(
    schemeId: string,
    scheme: SchemeObject,
    isNew: boolean,
  ): Promise<void> {
    this.calls.push({ schemeId, scheme, isNew });
  }
}

class FakeCompatibilityStore implements CompatibilityStore {
  public readonly calls: Array<{
    schemeId: string;
    relations: ReturnType<typeof structuredCloneSafe>;
  }> = [];
  async recordRelations(schemeId: string, relations: any[]): Promise<void> {
    this.calls.push({ schemeId, relations: structuredCloneSafe(relations) });
  }
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

interface OrchestratorTestKit {
  orchestrator: CrawlerOrchestrator;
  fetcher: FakeFetcher;
  persistence: FakeSchemePersistence;
  vectorIndexer: FakeVectorIndexer;
  searchIndexer: FakeSearchIndexer;
  changeDetector: FakeChangeDetector;
  compatibilityStore: FakeCompatibilityStore;
  notifier: InMemoryAdminNotifier;
}

function buildOrchestrator(
  overrides: Partial<CrawlerOrchestratorDeps> = {},
  config: ConstructorParameters<typeof CrawlerOrchestrator>[1] = {},
): OrchestratorTestKit {
  const fetcher = (overrides.fetcher as FakeFetcher) ?? new FakeFetcher();
  const persistence =
    (overrides.persistence as FakeSchemePersistence) ?? new FakeSchemePersistence();
  const vectorIndexer =
    (overrides.vectorIndexer as FakeVectorIndexer) ?? new FakeVectorIndexer();
  const searchIndexer =
    (overrides.searchIndexer as FakeSearchIndexer) ?? new FakeSearchIndexer();
  const changeDetector =
    (overrides.changeDetector as FakeChangeDetector) ?? new FakeChangeDetector();
  const compatibilityStore =
    (overrides.compatibilityStore as FakeCompatibilityStore) ??
    new FakeCompatibilityStore();
  const notifier =
    (overrides.notifier as InMemoryAdminNotifier) ?? new InMemoryAdminNotifier();

  const orchestrator = new CrawlerOrchestrator(
    {
      fetcher,
      persistence,
      vectorIndexer,
      searchIndexer,
      changeDetector,
      compatibilityStore,
      notifier,
      ...overrides,
    },
    config,
  );

  return {
    orchestrator,
    fetcher,
    persistence,
    vectorIndexer,
    searchIndexer,
    changeDetector,
    compatibilityStore,
    notifier,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CrawlerOrchestrator.executeDailyCrawl', () => {
  it('returns newSchemes=1 and indexes the scheme for a single valid URL', async () => {
    const url = `${VALID_HOST}/scheme-a`;
    const kit = buildOrchestrator();

    const result = await kit.orchestrator.executeDailyCrawl([url]);

    expect(result.newSchemes).toBe(1);
    expect(result.updatedSchemes).toBe(0);
    expect(result.failedSources).toHaveLength(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.completedAt).toBeInstanceOf(Date);

    expect(kit.persistence.upsertCalls).toHaveLength(1);
    expect(kit.vectorIndexer.calls).toHaveLength(1);
    expect(kit.searchIndexer.calls).toHaveLength(1);
    expect(kit.changeDetector.calls).toHaveLength(1);
    expect(kit.changeDetector.calls[0]!.isNew).toBe(true);

    // No failures → notifier.notifyFailures NOT called.
    expect(kit.notifier.failureCalls).toHaveLength(0);
    // Crawl-complete notification still fires once.
    expect(kit.notifier.completeCalls).toHaveLength(1);
    expect(kit.notifier.completeCalls[0]!.newSchemes).toBe(1);
  });

  it('counts an invalid (non-official) source as a failure and notifies admins', async () => {
    const fetcher = new FakeFetcher();
    const kit = buildOrchestrator({ fetcher });

    const result = await kit.orchestrator.executeDailyCrawl([INVALID_HOST]);

    expect(result.newSchemes).toBe(0);
    expect(result.updatedSchemes).toBe(0);
    expect(result.failedSources).toHaveLength(1);
    expect(result.failedSources[0]!.url).toBe(INVALID_HOST);
    expect(result.failedSources[0]!.errorCode).toBe('INVALID_SOURCE');

    // Fetcher should never have been invoked for an invalid URL.
    expect(fetcher.calls).toHaveLength(0);
    expect(kit.persistence.upsertCalls).toHaveLength(0);
    expect(kit.vectorIndexer.calls).toHaveLength(0);
    expect(kit.searchIndexer.calls).toHaveLength(0);

    // Notifier called once with the failure batch.
    expect(kit.notifier.failureCalls).toHaveLength(1);
    expect(kit.notifier.failureCalls[0]!.totalFailed).toBe(1);
    expect(kit.notifier.failureCalls[0]!.totalAttempted).toBe(1);
    // 1/1 failure rate → critical severity.
    expect(kit.notifier.failureCalls[0]!.severity).toBe('critical');
  });

  it('rejects schemes whose mandatory fields cannot be parsed', async () => {
    const url = `${VALID_HOST}/missing-fields`;
    // No name, description, ministry, criteria, or benefits → enforcer rejects.
    const fetcher = new FakeFetcher({
      payloads: { [url]: makeRawSchemeData(url, JSON.stringify({})) },
    });
    const kit = buildOrchestrator({ fetcher });

    const result = await kit.orchestrator.executeDailyCrawl([url]);

    expect(result.newSchemes).toBe(0);
    expect(result.failedSources).toHaveLength(1);
    expect(result.failedSources[0]!.url).toBe(url);
    expect(result.failedSources[0]!.errorCode).toBe('MANDATORY_FIELDS_MISSING');
    expect(result.failedSources[0]!.reason).toMatch(/missing mandatory/i);

    expect(kit.persistence.upsertCalls).toHaveLength(0);
    expect(kit.notifier.failureCalls).toHaveLength(1);
  });

  it('respects the configured concurrency limit', async () => {
    const concurrency = 3;
    const total = 8;
    const urls = Array.from({ length: total }, (_, i) => `${VALID_HOST}/c-${i}`);
    const delays: Record<string, number> = {};
    for (const u of urls) delays[u] = 30; // each fetch takes 30 ms

    const fetcher = new FakeFetcher({ delayMsByUrl: delays });
    const kit = buildOrchestrator({ fetcher }, { concurrency });

    const result = await kit.orchestrator.executeDailyCrawl(urls);

    expect(result.newSchemes).toBe(total);
    expect(result.failedSources).toHaveLength(0);
    expect(fetcher.calls).toHaveLength(total);
    // Peak in-flight should never exceed concurrency.
    expect(fetcher.peakConcurrent).toBeLessThanOrEqual(concurrency);
    expect(fetcher.peakConcurrent).toBeGreaterThan(1);
  });

  it('marks a single source as failed when its pipeline exceeds the per-scheme timeout', async () => {
    const slowUrl = `${VALID_HOST}/slow`;
    const fastUrl = `${VALID_HOST}/fast`;
    const fetcher = new FakeFetcher({
      delayMsByUrl: { [slowUrl]: 200 },
    });
    const kit = buildOrchestrator(
      { fetcher },
      { perSchemeTimeoutMs: 50, concurrency: 4 },
    );

    const result = await kit.orchestrator.executeDailyCrawl([slowUrl, fastUrl]);

    expect(result.newSchemes).toBe(1);
    expect(result.failedSources).toHaveLength(1);
    expect(result.failedSources[0]!.url).toBe(slowUrl);
    expect(result.failedSources[0]!.errorCode).toBe('TIMEOUT');
    expect(result.failedSources[0]!.reason).toMatch(/timeout/i);

    // The fast URL should have been fully indexed.
    expect(kit.persistence.upsertCalls).toHaveLength(1);
    expect(kit.persistence.upsertCalls[0]!.sourceUrl).toBe(fastUrl);

    // Notifier called for the timeout failure.
    expect(kit.notifier.failureCalls).toHaveLength(1);
  });

  it('returns a CrawlResult with the expected aggregate shape', async () => {
    const goodUrl = `${VALID_HOST}/ok`;
    const badUrl = INVALID_HOST;
    const kit = buildOrchestrator();

    const start = Date.now();
    const result: CrawlResult = await kit.orchestrator.executeDailyCrawl([
      goodUrl,
      badUrl,
    ]);
    const wall = Date.now() - start;

    expect(result.newSchemes).toBe(1);
    expect(result.updatedSchemes).toBe(0);
    expect(result.failedSources).toHaveLength(1);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    // Sanity: the recorded duration shouldn't exceed wall clock by more
    // than a small margin.
    expect(result.duration).toBeLessThanOrEqual(wall + 1000);
    expect(result.completedAt).toBeInstanceOf(Date);
  });

  it('treats a re-crawl of the same URL as an update, not a new scheme', async () => {
    const url = `${VALID_HOST}/repeat`;
    const kit = buildOrchestrator();

    const first = await kit.orchestrator.executeDailyCrawl([url]);
    expect(first.newSchemes).toBe(1);
    expect(first.updatedSchemes).toBe(0);

    const second = await kit.orchestrator.executeDailyCrawl([url]);
    expect(second.newSchemes).toBe(0);
    expect(second.updatedSchemes).toBe(1);
    expect(second.failedSources).toHaveLength(0);

    // Change detector should have been invoked twice — once for create,
    // once for update.
    expect(kit.changeDetector.calls).toHaveLength(2);
    expect(kit.changeDetector.calls[0]!.isNew).toBe(true);
    expect(kit.changeDetector.calls[1]!.isNew).toBe(false);
  });

  it('continues processing even when the notifier itself throws', async () => {
    const failingNotifier: AdminNotifier = {
      notifyFailures: vi.fn(async () => {
        throw new Error('notifier offline');
      }),
      notifyCrawlComplete: vi.fn(async () => {
        throw new Error('notifier offline');
      }),
    };

    const kit = buildOrchestrator({ notifier: failingNotifier });
    const result = await kit.orchestrator.executeDailyCrawl([INVALID_HOST]);

    expect(result.failedSources).toHaveLength(1);
    expect(failingNotifier.notifyFailures).toHaveBeenCalledTimes(1);
    expect(failingNotifier.notifyCrawlComplete).toHaveBeenCalledTimes(1);
  });
});

// ─── Compatibility extraction ────────────────────────────────────────────────

describe('CrawlerOrchestrator.extractCompatibilityRelations', () => {
  it('returns [] when the description has no recognised compatibility cues', () => {
    const kit = buildOrchestrator();
    const relations = kit.orchestrator.extractCompatibilityRelations({
      schemeObject: {
        name: 'Plain Scheme',
        description: 'Provides assistance to citizens. No special rules apply.',
        eligibilityCriteria: [
          { field: 'age', operator: 'gte', value: 18, description: '18+' },
        ],
        benefits: [{ type: 'monetary', amount: 1000, description: 'INR 1000' }],
        sourceUrl: `${VALID_HOST}/plain`,
        ministry: 'Ministry of X',
        applicationProcess: null,
        requiredDocuments: null,
        deadline: null,
      },
      sourceUrl: `${VALID_HOST}/plain`,
      trustScore: 60,
      verified: true,
      discoveredAt: new Date(),
      lastVerifiedAt: new Date(),
      category: null,
      state: null,
    });

    expect(relations).toEqual([]);
  });

  it('extracts can_combine_with / cannot_combine_with / prerequisite cues', () => {
    const kit = buildOrchestrator();
    const description =
      'This scheme can be combined with PM Awas Yojana. ' +
      'It cannot be combined with Old Age Pension Scheme. ' +
      'Prerequisite: Aadhaar Enrolment.';
    const relations = kit.orchestrator.extractCompatibilityRelations({
      schemeObject: {
        name: 'Test Compat Scheme',
        description,
        eligibilityCriteria: [
          { field: 'age', operator: 'gte', value: 18, description: '18+' },
        ],
        benefits: [{ type: 'monetary', amount: 1000, description: 'INR 1000' }],
        sourceUrl: `${VALID_HOST}/compat`,
        ministry: 'Ministry of X',
        applicationProcess: null,
        requiredDocuments: null,
        deadline: null,
      },
      sourceUrl: `${VALID_HOST}/compat`,
      trustScore: 80,
      verified: true,
      discoveredAt: new Date(),
      lastVerifiedAt: new Date(),
      category: null,
      state: null,
    });

    const types = relations.map((r) => r.type).sort();
    expect(types).toEqual(
      ['can_combine_with', 'cannot_combine_with', 'prerequisite_schemes'].sort(),
    );
  });
});

// ─── processScheme rejection branches ────────────────────────────────────────

describe('CrawlerOrchestrator.processScheme', () => {
  let kit: OrchestratorTestKit;

  beforeEach(() => {
    kit = buildOrchestrator();
  });

  it('rejects a scheme whose source URL is not on an official domain', async () => {
    const result = await kit.orchestrator.processScheme(
      makeRawSchemeData(INVALID_HOST, validJsonPayload()),
    );
    expect('rejected' in result && result.rejected).toBe(true);
  });

  it('rejects a scheme whose mandatory fields are missing', async () => {
    const url = `${VALID_HOST}/empty`;
    const result = await kit.orchestrator.processScheme(
      makeRawSchemeData(url, JSON.stringify({})),
    );
    expect('rejected' in result && result.rejected).toBe(true);
  });

  it('returns a ProcessedScheme for valid input', async () => {
    const url = `${VALID_HOST}/good`;
    const result = await kit.orchestrator.processScheme(
      makeRawSchemeData(url, validJsonPayload()),
    );
    if ('rejected' in result) throw new Error('Expected scheme to be accepted');
    expect(result.schemeObject.name).toBe('PM Sample Yojana');
    expect(result.sourceUrl).toBe(url);
    expect(result.trustScore).toBeGreaterThanOrEqual(0);
    expect(result.trustScore).toBeLessThanOrEqual(100);
  });
});
