/**
 * Unit tests for the production crawler adapters.
 *
 * These cover the contract each adapter exposes to the orchestrator,
 * using in-memory fakes so the test suite stays Prisma-free. The
 * integration of all four adapters together is exercised by the
 * orchestrator's own tests (which use the same SchemePersistence /
 * VectorIndexer / SearchIndexer / CompatibilityStore interfaces).
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  CompatibilityRelation,
  SchemeObject,
} from '@bharat-benefits/shared';

import type { IngestedRecord } from './ingestion-helpers';
import type { SchemeIndexer, IndexableScheme } from './scheme-indexer';
import {
  PrismaCompatibilityStore,
  PrismaSchemePersistence,
  SchemeIndexerSearchAdapter,
  SchemeIndexerVectorAdapter,
  type CompatibilityStorePrisma,
  type SchemePersistencePrisma,
} from './prisma-adapters';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSchemeObject(overrides: Partial<SchemeObject> = {}): SchemeObject {
  return {
    name: 'Sample Scheme',
    description: 'Helps citizens.',
    eligibilityCriteria: [],
    benefits: [],
    sourceUrl: 'https://gov.in/sample',
    ministry: 'Test Ministry',
    applicationProcess: null,
    requiredDocuments: null,
    deadline: null,
    ...overrides,
  };
}

function makeIngestedRecord(overrides: Partial<IngestedRecord> = {}): IngestedRecord {
  return {
    schemeObject: makeSchemeObject(),
    sourceUrl: 'https://gov.in/sample',
    ministry: 'Test Ministry',
    trustScore: 90,
    discoveredAt: new Date('2026-06-01T00:00:00Z'),
    lastVerifiedAt: new Date('2026-06-20T00:00:00Z'),
    category: 'Employment',
    state: null,
    verified: true,
    ...overrides,
  };
}

// ─── PrismaSchemePersistence ─────────────────────────────────────────────────

describe('PrismaSchemePersistence', () => {
  function makeFakePrisma() {
    const created: Array<Record<string, unknown>> = [];
    const updated: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
    const docsDeleted: Array<{ schemeId: string }> = [];
    const docsCreated: Array<Array<Record<string, unknown>>> = [];
    const findFirstCalls: Array<unknown> = [];
    let existingByUrlId: string | null = null;
    let existingByNameId: string | null = null;

    const fake: SchemePersistencePrisma = {
      scheme: {
        async findFirst(args) {
          findFirstCalls.push(args.where);
          // Branch 1: lookup by sourceUrl (canonical key).
          if ('sourceUrl' in args.where && args.where.sourceUrl !== undefined) {
            return existingByUrlId ? { id: existingByUrlId } : null;
          }
          // Branch 2: fallback lookup by case-insensitive name equality.
          if ('name' in args.where) {
            return existingByNameId ? { id: existingByNameId } : null;
          }
          return null;
        },
        async create({ data }) {
          created.push(data);
          return { id: 'new-id' };
        },
        async update({ where, data }) {
          updated.push({ where, data });
          return { id: where.id };
        },
      },
      schemeDocument: {
        async deleteMany({ where }) {
          docsDeleted.push(where);
          return undefined;
        },
        async createMany({ data }) {
          docsCreated.push(data);
          return undefined;
        },
      },
    };

    return {
      fake,
      created,
      updated,
      docsDeleted,
      docsCreated,
      findFirstCalls,
      setExistingId(id: string | null) {
        existingByUrlId = id;
      },
      setExistingByNameId(id: string | null) {
        existingByNameId = id;
      },
    };
  }

  it('creates a new scheme row when no existing row matches the sourceUrl', async () => {
    const harness = makeFakePrisma();
    harness.setExistingId(null);
    const store = new PrismaSchemePersistence(harness.fake);

    const result = await store.upsertScheme(makeIngestedRecord());

    expect(result).toEqual({ schemeId: 'new-id', created: true });
    expect(harness.created).toHaveLength(1);
    expect(harness.updated).toHaveLength(0);
    expect(harness.created[0].name).toBe('Sample Scheme');
    // discoveredAt only set on create.
    expect(harness.created[0].discoveredAt).toBeInstanceOf(Date);
  });

  it('updates an existing scheme row without touching discoveredAt', async () => {
    const harness = makeFakePrisma();
    harness.setExistingId('existing-id');
    const store = new PrismaSchemePersistence(harness.fake);

    const result = await store.upsertScheme(makeIngestedRecord());

    expect(result).toEqual({ schemeId: 'existing-id', created: false });
    expect(harness.updated).toHaveLength(1);
    expect(harness.updated[0].where).toEqual({ id: 'existing-id' });
    expect(harness.updated[0].data.discoveredAt).toBeUndefined();
  });

  it('falls back to "Other" when the ingested record has no category', async () => {
    const harness = makeFakePrisma();
    harness.setExistingId(null);
    const store = new PrismaSchemePersistence(harness.fake);

    await store.upsertScheme(makeIngestedRecord({ category: null }));

    expect(harness.created[0].category).toBe('Other');
  });

  it('full-replaces the document checklist on every upsert', async () => {
    const harness = makeFakePrisma();
    harness.setExistingId('existing-id');
    const store = new PrismaSchemePersistence(harness.fake);

    await store.upsertScheme(
      makeIngestedRecord({
        schemeObject: makeSchemeObject({
          requiredDocuments: [
            {
              documentName: 'Aadhaar Card',
              description: '12-digit UIDAI id',
              format: 'Original',
              required: true,
            },
          ],
        }),
      }),
    );

    expect(harness.docsDeleted).toEqual([{ schemeId: 'existing-id' }]);
    expect(harness.docsCreated).toHaveLength(1);
    expect(harness.docsCreated[0]).toHaveLength(1);
    expect(harness.docsCreated[0][0]).toMatchObject({
      schemeId: 'existing-id',
      documentName: 'Aadhaar Card',
      required: true,
    });
  });

  it('skips createMany when no documents are present', async () => {
    const harness = makeFakePrisma();
    harness.setExistingId('existing-id');
    const store = new PrismaSchemePersistence(harness.fake);

    await store.upsertScheme(makeIngestedRecord());

    // Always delete to clear stale rows from a prior crawl.
    expect(harness.docsDeleted).toEqual([{ schemeId: 'existing-id' }]);
    expect(harness.docsCreated).toHaveLength(0);
  });

  it('maps SchemeObject.applicationProcess to the schema column applicationSteps', async () => {
    const harness = makeFakePrisma();
    harness.setExistingId(null);
    const store = new PrismaSchemePersistence(harness.fake);

    await store.upsertScheme(
      makeIngestedRecord({
        schemeObject: makeSchemeObject({
          applicationProcess: [
            { stepNumber: 1, action: 'Register', expectedOutcome: 'Account' },
          ],
        }),
      }),
    );

    const row = harness.created[0];
    expect(row.applicationSteps).toEqual([
      { stepNumber: 1, action: 'Register', expectedOutcome: 'Account' },
    ]);
  });

  it('falls back to case-insensitive name match when no sourceUrl matches', async () => {
    const harness = makeFakePrisma();
    harness.setExistingId(null);
    harness.setExistingByNameId('dup-id');
    const store = new PrismaSchemePersistence(harness.fake);

    const result = await store.upsertScheme(
      makeIngestedRecord({
        schemeObject: makeSchemeObject({ name: '  PM Kisan Samman Nidhi  ' }),
        sourceUrl: 'https://gov.in/different-url',
      }),
    );

    // The duplicate-by-name branch should treat the row as an update,
    // not a create, so we don't add a second catalogue entry for the
    // same scheme reachable via two URLs.
    expect(result).toEqual({ schemeId: 'dup-id', created: false });
    expect(harness.created).toHaveLength(0);
    expect(harness.updated).toHaveLength(1);

    // Verify the fallback query used case-insensitive equality on the
    // trimmed name.
    const nameLookup = harness.findFirstCalls.find(
      (where) =>
        typeof where === 'object' &&
        where !== null &&
        'name' in (where as Record<string, unknown>),
    ) as { name: { equals: string; mode: string } };
    expect(nameLookup.name).toEqual({
      equals: 'PM Kisan Samman Nidhi',
      mode: 'insensitive',
    });
  });

  it('prefers sourceUrl match over name match when both would resolve', async () => {
    const harness = makeFakePrisma();
    harness.setExistingId('url-match');
    harness.setExistingByNameId('name-match');
    const store = new PrismaSchemePersistence(harness.fake);

    const result = await store.upsertScheme(makeIngestedRecord());

    expect(result.schemeId).toBe('url-match');
    // The name-fallback lookup should NOT have run — sourceUrl already
    // resolved a candidate.
    const nameLookupHappened = harness.findFirstCalls.some(
      (w) =>
        typeof w === 'object' && w !== null && 'name' in (w as Record<string, unknown>),
    );
    expect(nameLookupHappened).toBe(false);
  });
});

// ─── Vector / search adapters ────────────────────────────────────────────────

function makeFakeIndexer() {
  return {
    indexSchemeInVectorDB: vi.fn(async (_id: string, _scheme: IndexableScheme) => undefined),
    indexSchemeInElasticsearch: vi.fn(async (_id: string, _scheme: IndexableScheme) => undefined),
    removeSchemeFromIndices: vi.fn(async () => undefined),
  } satisfies SchemeIndexer;
}

describe('SchemeIndexerVectorAdapter', () => {
  it('translates SchemeObject to IndexableScheme and forwards to the vector indexer', async () => {
    const indexer = makeFakeIndexer();
    const adapter = new SchemeIndexerVectorAdapter(indexer);

    await adapter.indexScheme(
      'scheme-1',
      makeSchemeObject({
        name: 'Test',
        applicationProcess: [
          { stepNumber: 1, action: 'Apply', expectedOutcome: 'Done' },
        ],
      }),
    );

    expect(indexer.indexSchemeInVectorDB).toHaveBeenCalledTimes(1);
    const [, payload] = indexer.indexSchemeInVectorDB.mock.calls[0]!;
    expect(payload).toMatchObject({
      id: 'scheme-1',
      name: 'Test',
      category: 'Other',
      // SchemeObject.applicationProcess maps to IndexableScheme.applicationSteps
      applicationSteps: [
        { stepNumber: 1, action: 'Apply', expectedOutcome: 'Done' },
      ],
    });
  });
});

describe('SchemeIndexerSearchAdapter', () => {
  it('forwards to indexSchemeInElasticsearch', async () => {
    const indexer = makeFakeIndexer();
    const adapter = new SchemeIndexerSearchAdapter(indexer);

    await adapter.indexScheme('scheme-2', makeSchemeObject({ name: 'Other Scheme' }));

    expect(indexer.indexSchemeInElasticsearch).toHaveBeenCalledTimes(1);
    expect(indexer.indexSchemeInElasticsearch.mock.calls[0]![0]).toBe('scheme-2');
  });
});

// ─── PrismaCompatibilityStore ────────────────────────────────────────────────

describe('PrismaCompatibilityStore', () => {
  function makeFakePrisma(existing: Map<string, string> = new Map()) {
    const upserts: Array<{
      where: unknown;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }> = [];

    const fake: CompatibilityStorePrisma = {
      schemeCompatibility: {
        async upsert(args) {
          upserts.push(args);
          return undefined;
        },
      },
      scheme: {
        async findFirst({ where }) {
          const id = existing.get(where.sourceUrl);
          return id ? { id } : null;
        },
      },
    };

    return { fake, upserts };
  }

  function makeRelation(
    overrides: Partial<CompatibilityRelation> = {},
  ): CompatibilityRelation {
    return {
      sourceSchemeUrl: 'https://gov.in/source',
      relatedSchemeIdentifier: 'https://gov.in/related',
      type: 'can_combine_with',
      officialRule: 'See para 4.2',
      sourceUrl: 'https://gov.in/source',
      ...overrides,
    };
  }

  it('upserts using the named compound unique key', async () => {
    const { fake, upserts } = makeFakePrisma(
      new Map([['https://gov.in/related', 'related-id']]),
    );
    const store = new PrismaCompatibilityStore(fake);

    await store.recordRelations('scheme-id', [makeRelation()]);

    expect(upserts).toHaveLength(1);
    expect(upserts[0].where).toEqual({
      uq_scheme_compatibility: {
        schemeId: 'scheme-id',
        relatedSchemeId: 'related-id',
      },
    });
    expect(upserts[0].create).toMatchObject({
      schemeId: 'scheme-id',
      relatedSchemeId: 'related-id',
      relationshipType: 'can_combine_with',
      officialRule: 'See para 4.2',
      verified: false,
    });
  });

  it('skips relations whose related scheme is not yet in the catalogue', async () => {
    const { fake, upserts } = makeFakePrisma(); // empty
    const store = new PrismaCompatibilityStore(fake);

    await store.recordRelations('scheme-id', [makeRelation()]);

    expect(upserts).toHaveLength(0);
  });

  it('mixes-and-matches present and missing related schemes correctly', async () => {
    const { fake, upserts } = makeFakePrisma(
      new Map([['https://gov.in/relatedA', 'related-a']]),
    );
    const store = new PrismaCompatibilityStore(fake);

    await store.recordRelations('scheme-id', [
      makeRelation({ relatedSchemeIdentifier: 'https://gov.in/relatedA' }),
      makeRelation({ relatedSchemeIdentifier: 'https://gov.in/relatedB' }),
    ]);

    expect(upserts).toHaveLength(1);
    expect(upserts[0].create.relatedSchemeId).toBe('related-a');
  });
});
