/**
 * Vector-based semantic search for schemes (Requirement 2.6).
 *
 * Wraps the same Pinecone + OpenAI embeddings stack used by the RAG
 * assistant (see `services/assistant/scheme-assistant.ts`) and exposes a
 * uniform `searchByQuery(query, topK)` interface so the upstream search
 * orchestrator can mix vector hits with Elasticsearch hits.
 *
 * Design notes:
 *   - Each Pinecone match represents a *chunk* of a scheme. We aggregate
 *     to scheme-level by keeping each scheme's best chunk score, which
 *     matches how the assistant resolves citations.
 *   - The function is purely functional given its inputs: tests inject
 *     stub embeddings + index clients to avoid real network calls.
 */

import type { EmbeddingsClient } from '../crawler/embeddings';
import { generateEmbedding } from '../crawler/embeddings';

/**
 * Subset of the Pinecone `Index.query` API used here. Mirrors the shape
 * already consumed by the scheme-assistant module so we can share index
 * clients across services.
 */
export interface PineconeIndexLike {
  query(args: {
    topK: number;
    vector: number[];
    includeMetadata?: boolean;
    includeValues?: boolean;
  }): Promise<{
    matches?: Array<{
      id?: string;
      score?: number;
      metadata?: Record<string, unknown> | null;
    }>;
  }>;
}

/** A single scheme-level vector match. */
export interface VectorSearchHit {
  schemeId: string;
  /** Similarity score returned by the vector index (typically cosine, [0, 1]). */
  score: number;
}

/** Interface used by the search orchestrator. */
export interface VectorSearcher {
  searchByQuery(query: string, topK?: number): Promise<VectorSearchHit[]>;
}

/** Default top-K applied to vector retrieval when no override is supplied. */
export const VECTOR_DEFAULT_TOP_K = 50;

/**
 * Builds a {@link VectorSearcher} backed by a Pinecone-compatible index
 * and OpenAI embeddings.
 *
 * @param pineconeIndex   Pinecone index (or compatible stub).
 * @param embeddingsClient Optional embeddings client. Falls back to the
 *                          shared singleton when omitted, enabling tests
 *                          to inject a no-network stub.
 */
export function createVectorSearcher(
  pineconeIndex: PineconeIndexLike,
  embeddingsClient?: EmbeddingsClient,
): VectorSearcher {
  return {
    async searchByQuery(query, topK = VECTOR_DEFAULT_TOP_K) {
      if (typeof query !== 'string' || query.trim().length === 0) return [];

      const requestedTopK = Math.max(1, Math.min(topK, 200));
      // Pull a few extra chunks because multiple chunks of the same
      // scheme often dominate the top results — we deduplicate below.
      const fetchTopK = Math.max(requestedTopK, requestedTopK * 2);

      const vector = embeddingsClient
        ? await generateEmbedding(query, embeddingsClient)
        : await generateEmbedding(query);

      const response = await pineconeIndex.query({
        topK: fetchTopK,
        vector,
        includeMetadata: true,
      });

      const matches = response.matches ?? [];
      const bestByScheme = new Map<string, number>();

      for (const match of matches) {
        const meta = (match.metadata ?? {}) as Record<string, unknown>;
        const schemeId =
          typeof meta.schemeId === 'string' && meta.schemeId.length > 0
            ? meta.schemeId
            : null;
        if (!schemeId) continue;
        const score =
          typeof match.score === 'number' && Number.isFinite(match.score)
            ? match.score
            : 0;
        const existing = bestByScheme.get(schemeId);
        if (existing === undefined || score > existing) {
          bestByScheme.set(schemeId, score);
        }
      }

      const hits: VectorSearchHit[] = Array.from(bestByScheme.entries()).map(
        ([schemeId, score]) => ({ schemeId, score }),
      );
      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, requestedTopK);
    },
  };
}
