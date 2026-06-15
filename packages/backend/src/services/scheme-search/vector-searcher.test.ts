/**
 * Unit tests for the vector-based scheme searcher.
 *
 * Validates that:
 *   - The Pinecone index is queried with an embedding generated from the
 *     citizen's query (no real network calls — both clients are stubbed).
 *   - Multiple chunks of the same scheme are deduplicated to a single
 *     scheme-level hit using the best chunk score.
 *   - Results are returned sorted descending by score.
 *   - Empty / blank queries short-circuit without hitting any client.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  EMBEDDING_DIMENSIONS,
  type EmbeddingsClient,
} from '../crawler/embeddings';
import {
  createVectorSearcher,
  VECTOR_DEFAULT_TOP_K,
  type PineconeIndexLike,
} from './vector-searcher';

function makeEmbeddingsStub(): EmbeddingsClient & {
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => ({
    data: [
      {
        embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1),
      },
    ],
  }));
  return {
    embeddings: { create },
    create,
  } as unknown as EmbeddingsClient & { create: ReturnType<typeof vi.fn> };
}

function makeIndexStub(
  matches: Array<{ id?: string; score?: number; metadata?: Record<string, unknown> }>,
): PineconeIndexLike & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ matches }));
  return { query } as PineconeIndexLike & { query: ReturnType<typeof vi.fn> };
}

describe('createVectorSearcher', () => {
  it('returns an empty array for empty / whitespace queries without hitting clients', async () => {
    const embeddings = makeEmbeddingsStub();
    const index = makeIndexStub([]);
    const searcher = createVectorSearcher(index, embeddings);
    expect(await searcher.searchByQuery('')).toEqual([]);
    expect(await searcher.searchByQuery('   ')).toEqual([]);
    expect(embeddings.create).not.toHaveBeenCalled();
    expect(index.query).not.toHaveBeenCalled();
  });

  it('queries Pinecone with the generated embedding and includeMetadata=true', async () => {
    const embeddings = makeEmbeddingsStub();
    const index = makeIndexStub([
      { id: 's1-0', score: 0.9, metadata: { schemeId: 's1', chunkText: 'x', chunkIndex: 0 } },
    ]);
    const searcher = createVectorSearcher(index, embeddings);
    await searcher.searchByQuery('education loan');

    expect(embeddings.create).toHaveBeenCalledTimes(1);
    expect(index.query).toHaveBeenCalledTimes(1);
    const callArg = index.query.mock.calls[0]![0];
    expect(callArg.includeMetadata).toBe(true);
    expect(callArg.vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(callArg.topK).toBeGreaterThanOrEqual(VECTOR_DEFAULT_TOP_K);
  });

  it('aggregates multiple chunks of the same scheme to a single hit using the best score', async () => {
    const embeddings = makeEmbeddingsStub();
    const index = makeIndexStub([
      { id: 's1-0', score: 0.5, metadata: { schemeId: 's1', chunkIndex: 0 } },
      { id: 's1-1', score: 0.9, metadata: { schemeId: 's1', chunkIndex: 1 } },
      { id: 's2-0', score: 0.7, metadata: { schemeId: 's2', chunkIndex: 0 } },
    ]);
    const searcher = createVectorSearcher(index, embeddings);
    const hits = await searcher.searchByQuery('any');

    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ schemeId: 's1', score: 0.9 });
    expect(hits[1]).toEqual({ schemeId: 's2', score: 0.7 });
  });

  it('skips matches that are missing schemeId metadata', async () => {
    const embeddings = makeEmbeddingsStub();
    const index = makeIndexStub([
      { id: 'orphan', score: 0.99, metadata: { chunkText: 'x' } },
      { id: 's1', score: 0.5, metadata: { schemeId: 's1' } },
    ]);
    const searcher = createVectorSearcher(index, embeddings);
    const hits = await searcher.searchByQuery('any');

    expect(hits).toEqual([{ schemeId: 's1', score: 0.5 }]);
  });

  it('respects a smaller topK by trimming the final list', async () => {
    const embeddings = makeEmbeddingsStub();
    const index = makeIndexStub([
      { metadata: { schemeId: 'a' }, score: 0.9 },
      { metadata: { schemeId: 'b' }, score: 0.8 },
      { metadata: { schemeId: 'c' }, score: 0.7 },
    ]);
    const searcher = createVectorSearcher(index, embeddings);
    const hits = await searcher.searchByQuery('any', 2);
    expect(hits.map((h) => h.schemeId)).toEqual(['a', 'b']);
  });
});
