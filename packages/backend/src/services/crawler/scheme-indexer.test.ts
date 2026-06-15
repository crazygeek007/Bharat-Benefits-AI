/**
 * Unit tests for the scheme indexer (Pinecone + Postgres + Elasticsearch).
 *
 * Validates: Requirements 6.1, 2.6
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  CHARS_PER_TOKEN,
  DEFAULT_CHUNK_OVERLAP_TOKENS,
  DEFAULT_CHUNK_TOKENS,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  chunkText,
  generateEmbedding,
  resetOpenAIClient,
  type EmbeddingsClient,
} from './embeddings';
import {
  buildSchemeText,
  buildSearchDocument,
  createSchemeIndexer,
  type ElasticsearchLikeClient,
  type IndexableScheme,
  type SchemeEmbeddingPersister,
  type VectorIndex,
} from './scheme-indexer';

// ─── Test fixtures ───────────────────────────────────────────────────────────

const SAMPLE_SCHEME: IndexableScheme = {
  id: 'scheme-1',
  name: 'PM Kisan Samman Nidhi',
  description: 'Income support scheme for small and marginal farmers.',
  ministry: 'Ministry of Agriculture',
  state: null,
  category: 'Agriculture',
  sourceUrl: 'https://pmkisan.gov.in',
  eligibilityCriteria: [
    {
      field: 'occupation',
      operator: 'eq',
      value: 'Farmer',
      description: 'Must be a farmer',
    },
    {
      field: 'landHolding',
      operator: 'lte',
      value: 2,
      description: 'Land holding must be less than or equal to 2 hectares',
    },
  ],
  benefits: [
    {
      type: 'monetary',
      amount: 6000,
      description: 'Annual income support of INR 6,000',
    },
  ],
  applicationSteps: [
    {
      stepNumber: 1,
      action: 'Visit pmkisan.gov.in',
      expectedOutcome: 'Land on the portal',
    },
    {
      stepNumber: 2,
      action: 'Register with Aadhaar',
      expectedOutcome: 'Account created',
    },
  ],
  trustScore: 95,
  verified: true,
  lastVerifiedAt: new Date('2025-01-10T00:00:00Z'),
};

function makeMockEmbeddingsClient(): EmbeddingsClient & {
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async (args: { model: string; input: string | string[] }) => {
    const inputs = Array.isArray(args.input) ? args.input : [args.input];
    return {
      data: inputs.map(() => ({
        embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0),
      })),
    };
  });
  return { embeddings: { create }, create } as unknown as EmbeddingsClient & {
    create: ReturnType<typeof vi.fn>;
  };
}

function makeMockVectorIndex(): VectorIndex & {
  upsert: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
  namespace: ReturnType<typeof vi.fn>;
} {
  const index: any = {
    upsert: vi.fn(async () => ({ upsertedCount: 0 })),
    deleteMany: vi.fn(async () => ({})),
  };
  index.namespace = vi.fn(() => index);
  return index;
}

function makeMockEsClient(): ElasticsearchLikeClient & {
  index: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    index: vi.fn(async () => ({ result: 'created' })),
    delete: vi.fn(async () => ({ result: 'deleted' })),
  } as unknown as ElasticsearchLikeClient & {
    index: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
}

interface MockDb extends SchemeEmbeddingPersister {
  schemeEmbedding: SchemeEmbeddingPersister['schemeEmbedding'] & {
    findMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
  };
}

function makeMockDb(existingChunkIndices: number[] = []): MockDb {
  return {
    schemeEmbedding: {
      findMany: vi.fn(async () =>
        existingChunkIndices.map((i) => ({ chunkIndex: i })),
      ),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
  } as unknown as MockDb;
}

// ─── chunkText ───────────────────────────────────────────────────────────────

describe('chunkText', () => {
  it('returns an empty array for empty / whitespace input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\t')).toEqual([]);
  });

  it('returns a single chunk when text fits within the budget', () => {
    const text = 'Short scheme description.';
    expect(chunkText(text)).toEqual([text]);
  });

  it('splits long text into multiple chunks with overlap', () => {
    // 4000 characters ≈ 1000 tokens at the heuristic — well above the
    // default 500-token chunk size.
    const text = 'a'.repeat(4000);
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should respect the byte budget derived from the
    // default chunk size in tokens.
    const maxChars = DEFAULT_CHUNK_TOKENS * CHARS_PER_TOKEN;
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxChars);
      expect(chunk.length).toBeGreaterThan(0);
    }

    // Concatenating with the overlap accounted for should reconstruct
    // at least the full text length.
    const overlapChars = DEFAULT_CHUNK_OVERLAP_TOKENS * CHARS_PER_TOKEN;
    const reconstructed =
      chunks[0] +
      chunks
        .slice(1)
        .map((c) => c.slice(overlapChars))
        .join('');
    expect(reconstructed.length).toBeGreaterThanOrEqual(text.length - chunks.length);
  });

  it('rejects invalid maxTokens / overlap combinations', () => {
    expect(() => chunkText('hello', 0)).toThrow();
    expect(() => chunkText('hello', 100, 100)).toThrow();
    expect(() => chunkText('hello', 100, -1)).toThrow();
  });

  it('prefers whitespace boundaries when splitting', () => {
    const text = 'word '.repeat(500); // 2500 chars; splits expected
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Each chunk should not start or end with whitespace after trim.
      expect(chunk).toEqual(chunk.trim());
    }
  });
});

// ─── generateEmbedding ───────────────────────────────────────────────────────

describe('generateEmbedding', () => {
  beforeEach(() => {
    resetOpenAIClient();
  });

  it('calls OpenAI embeddings API with the text-embedding-3-small model', async () => {
    const client = makeMockEmbeddingsClient();
    const text = 'sample text';
    const embedding = await generateEmbedding(text, client);

    expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(client.embeddings.create).toHaveBeenCalledTimes(1);
    expect(client.embeddings.create).toHaveBeenCalledWith({
      model: EMBEDDING_MODEL,
      input: text,
    });
  });

  it('rejects empty / whitespace input', async () => {
    const client = makeMockEmbeddingsClient();
    await expect(generateEmbedding('', client)).rejects.toThrow();
    await expect(generateEmbedding('   ', client)).rejects.toThrow();
  });

  it('throws when the API returns an empty embedding', async () => {
    const client: EmbeddingsClient = {
      embeddings: {
        create: vi.fn(async () => ({ data: [{ embedding: [] }] })) as any,
      },
    };
    await expect(generateEmbedding('hi', client)).rejects.toThrow();
  });
});

// ─── indexSchemeInVectorDB ───────────────────────────────────────────────────

describe('indexSchemeInVectorDB', () => {
  it('upserts one vector per chunk and persists matching DB rows', async () => {
    const vectorIndex = makeMockVectorIndex();
    const db = makeMockDb();
    const embeddingsClient = makeMockEmbeddingsClient();

    const indexer = createSchemeIndexer({
      vectorIndex,
      db,
      embeddingsClient,
      esClient: makeMockEsClient(),
    });

    await indexer.indexSchemeInVectorDB('scheme-1', SAMPLE_SCHEME);

    const text = buildSchemeText(SAMPLE_SCHEME);
    const expectedChunks = chunkText(text);

    expect(expectedChunks.length).toBeGreaterThan(0);

    // generateEmbedding called once per chunk.
    expect(embeddingsClient.embeddings.create).toHaveBeenCalledTimes(
      expectedChunks.length,
    );

    // Pinecone upsert called exactly once with the right number of records.
    expect(vectorIndex.upsert).toHaveBeenCalledTimes(1);
    const upsertedRecords = vectorIndex.upsert.mock.calls[0]![0] as Array<{
      id: string;
      values: number[];
      metadata: { schemeId: string; chunkIndex: number; chunkText: string };
    }>;
    expect(upsertedRecords).toHaveLength(expectedChunks.length);

    upsertedRecords.forEach((record, i) => {
      expect(record.id).toBe(`scheme-1-${i}`);
      expect(record.values).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(record.metadata).toEqual({
        schemeId: 'scheme-1',
        chunkIndex: i,
        chunkText: expectedChunks[i],
      });
    });

    // Postgres rows match the upserted vectors.
    expect(db.schemeEmbedding.deleteMany).toHaveBeenCalledWith({
      where: { schemeId: 'scheme-1' },
    });
    expect(db.schemeEmbedding.createMany).toHaveBeenCalledTimes(1);
    const dbCall = db.schemeEmbedding.createMany.mock.calls[0]![0] as {
      data: Array<{ schemeId: string; chunkText: string; chunkIndex: number }>;
    };
    expect(dbCall.data).toHaveLength(expectedChunks.length);
    dbCall.data.forEach((row, i) => {
      expect(row).toEqual({
        schemeId: 'scheme-1',
        chunkText: expectedChunks[i],
        chunkIndex: i,
      });
    });
  });

  it('skips upsert when the scheme produces no embeddable text but still clears existing rows', async () => {
    const vectorIndex = makeMockVectorIndex();
    const db = makeMockDb();
    const embeddingsClient = makeMockEmbeddingsClient();

    const indexer = createSchemeIndexer({
      vectorIndex,
      db,
      embeddingsClient,
      esClient: makeMockEsClient(),
    });

    const empty: IndexableScheme = {
      name: '',
      description: '',
      ministry: '',
      category: '',
      sourceUrl: 'https://gov.in',
    };

    await indexer.indexSchemeInVectorDB('empty-scheme', empty);

    expect(embeddingsClient.embeddings.create).not.toHaveBeenCalled();
    expect(vectorIndex.upsert).not.toHaveBeenCalled();
    expect(db.schemeEmbedding.createMany).not.toHaveBeenCalled();
    expect(db.schemeEmbedding.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('rejects empty schemeId', async () => {
    const indexer = createSchemeIndexer({
      vectorIndex: makeMockVectorIndex(),
      db: makeMockDb(),
      embeddingsClient: makeMockEmbeddingsClient(),
      esClient: makeMockEsClient(),
    });
    await expect(indexer.indexSchemeInVectorDB('', SAMPLE_SCHEME)).rejects.toThrow();
  });
});

// ─── indexSchemeInElasticsearch ──────────────────────────────────────────────

describe('indexSchemeInElasticsearch', () => {
  it('indexes a document with all relevant fields', async () => {
    const esClient = makeMockEsClient();

    const indexer = createSchemeIndexer({
      vectorIndex: makeMockVectorIndex(),
      db: makeMockDb(),
      embeddingsClient: makeMockEmbeddingsClient(),
      esClient,
      schemesIndex: 'test_schemes_index',
    });

    await indexer.indexSchemeInElasticsearch('scheme-1', SAMPLE_SCHEME);

    expect(esClient.index).toHaveBeenCalledTimes(1);
    const call = esClient.index.mock.calls[0]![0] as {
      index: string;
      id: string;
      document: Record<string, unknown>;
    };

    expect(call.index).toBe('test_schemes_index');
    expect(call.id).toBe('scheme-1');

    const expectedDoc = buildSearchDocument('scheme-1', SAMPLE_SCHEME);
    expect(call.document).toEqual(expectedDoc);

    // Spot-check critical fields are present.
    expect(call.document.name).toBe(SAMPLE_SCHEME.name);
    expect(call.document.description).toBe(SAMPLE_SCHEME.description);
    expect(call.document.category).toBe(SAMPLE_SCHEME.category);
    expect(call.document.ministry).toBe(SAMPLE_SCHEME.ministry);
    expect(typeof call.document.eligibilityCriteria).toBe('string');
    expect(call.document.eligibilityCriteria).toContain('Must be a farmer');
    expect(typeof call.document.benefits).toBe('string');
    expect(call.document.benefits).toContain('6000');
  });
});

// ─── removeSchemeFromIndices ─────────────────────────────────────────────────

describe('removeSchemeFromIndices', () => {
  it('deletes vector embeddings, DB rows, and ES doc', async () => {
    const vectorIndex = makeMockVectorIndex();
    const esClient = makeMockEsClient();
    const db = makeMockDb([0, 1, 2]);

    const indexer = createSchemeIndexer({
      vectorIndex,
      db,
      embeddingsClient: makeMockEmbeddingsClient(),
      esClient,
      schemesIndex: 'test_schemes_index',
    });

    await indexer.removeSchemeFromIndices('scheme-1');

    expect(vectorIndex.deleteMany).toHaveBeenCalledTimes(1);
    expect(vectorIndex.deleteMany).toHaveBeenCalledWith([
      'scheme-1-0',
      'scheme-1-1',
      'scheme-1-2',
    ]);

    expect(db.schemeEmbedding.deleteMany).toHaveBeenCalledWith({
      where: { schemeId: 'scheme-1' },
    });

    expect(esClient.delete).toHaveBeenCalledWith({
      index: 'test_schemes_index',
      id: 'scheme-1',
    });
  });

  it('skips vector deletion when no chunks exist but still deletes ES doc', async () => {
    const vectorIndex = makeMockVectorIndex();
    const esClient = makeMockEsClient();
    const db = makeMockDb([]);

    const indexer = createSchemeIndexer({
      vectorIndex,
      db,
      embeddingsClient: makeMockEmbeddingsClient(),
      esClient,
    });

    await indexer.removeSchemeFromIndices('scheme-1');

    expect(vectorIndex.deleteMany).not.toHaveBeenCalled();
    expect(db.schemeEmbedding.deleteMany).toHaveBeenCalledTimes(1);
    expect(esClient.delete).toHaveBeenCalledTimes(1);
  });

  it('swallows 404 errors from Elasticsearch on delete', async () => {
    const vectorIndex = makeMockVectorIndex();
    const db = makeMockDb([0]);
    const esClient: ElasticsearchLikeClient = {
      index: vi.fn(),
      delete: vi.fn(async () => {
        const err: any = new Error('not_found');
        err.statusCode = 404;
        throw err;
      }),
    };

    const indexer = createSchemeIndexer({
      vectorIndex,
      db,
      embeddingsClient: makeMockEmbeddingsClient(),
      esClient,
    });

    await expect(indexer.removeSchemeFromIndices('scheme-1')).resolves.toBeUndefined();
  });

  it('rejects empty schemeId', async () => {
    const indexer = createSchemeIndexer({
      vectorIndex: makeMockVectorIndex(),
      db: makeMockDb(),
      embeddingsClient: makeMockEmbeddingsClient(),
      esClient: makeMockEsClient(),
    });
    await expect(indexer.removeSchemeFromIndices('')).rejects.toThrow();
  });
});

// ─── buildSchemeText ─────────────────────────────────────────────────────────

describe('buildSchemeText', () => {
  it('concatenates all major scheme sections', () => {
    const text = buildSchemeText(SAMPLE_SCHEME);

    expect(text).toContain(SAMPLE_SCHEME.name);
    expect(text).toContain(SAMPLE_SCHEME.ministry);
    expect(text).toContain(SAMPLE_SCHEME.category);
    expect(text).toContain(SAMPLE_SCHEME.description);
    expect(text).toContain('Must be a farmer');
    expect(text).toContain('Annual income support');
    expect(text).toContain('Visit pmkisan.gov.in');
  });

  it('omits sections when underlying data is empty', () => {
    const minimal: IndexableScheme = {
      name: 'Minimal Scheme',
      description: 'desc',
      ministry: 'Ministry X',
      category: 'Other',
      sourceUrl: 'https://gov.in',
    };
    const text = buildSchemeText(minimal);
    expect(text).toContain('Minimal Scheme');
    expect(text).not.toContain('Eligibility Criteria');
    expect(text).not.toContain('Benefits:');
    expect(text).not.toContain('Application Steps:');
  });
});
