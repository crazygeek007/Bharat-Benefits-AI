/**
 * Embedding generation utilities for scheme content.
 *
 * Wraps OpenAI's `text-embedding-3-small` model (1536 dimensions, matching
 * the Pinecone index and `pgvector(1536)` column in PostgreSQL) and provides
 * a simple text-chunking strategy used by the scheme indexer.
 *
 * Validates: Requirements 6.1, 2.6
 */

import OpenAI from 'openai';

/** OpenAI model used for scheme embeddings. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';

/** Dimensionality of the embedding produced by {@link EMBEDDING_MODEL}. */
export const EMBEDDING_DIMENSIONS = 768;

/** Default chunk size in tokens for {@link chunkText}. */
export const DEFAULT_CHUNK_TOKENS = 500;

/** Default token overlap between adjacent chunks. */
export const DEFAULT_CHUNK_OVERLAP_TOKENS = 50;

/**
 * Heuristic factor used to convert tokens to characters when the
 * `tiktoken` library is unavailable. ~4 chars per token is a common
 * approximation for English/Latin-script text used by OpenAI tokenizers.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Minimal interface satisfied by the OpenAI SDK's `embeddings.create`
 * method. Tests inject a stub conforming to this shape so we never hit
 * the real API.
 */
export interface EmbeddingsClient {
  embeddings: {
    create(args: {
      model: string;
      input: string | string[];
    }): Promise<{
      data: Array<{ embedding: number[] }>;
    }>;
  };
}

let cachedClient: EmbeddingsClient | null = null;

/**
 * Returns a singleton embeddings client. Prefers Gemini if GEMINI_API_KEY
 * is set; falls back to OpenAI if OPENAI_API_KEY is set instead.
 */
export function getOpenAIClient(): EmbeddingsClient {
  if (cachedClient) {
    return cachedClient;
  }

  // Prefer Gemini
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey && geminiKey.trim().length > 0) {
    // Lazy require so embeddings can run without GEMINI when only OPENAI
    // is configured. Static `import` would force-load the Gemini SDK on
    // every consumer of this module.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createGeminiEmbeddingsClient } = require('../../lib/gemini');
    cachedClient = createGeminiEmbeddingsClient();
    if (cachedClient !== null) return cachedClient;
  }

  // Fall back to OpenAI
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      'GEMINI_API_KEY or OPENAI_API_KEY environment variable is required to generate embeddings',
    );
  }

  cachedClient = new OpenAI({ apiKey }) as unknown as EmbeddingsClient;
  return cachedClient;
}

/** Resets the cached OpenAI client (testing/reconfiguration). */
export function resetOpenAIClient(): void {
  cachedClient = null;
}

/**
 * Generates a 1536-dimensional embedding for the given text using the
 * `text-embedding-3-small` model.
 *
 * @param text  The text to embed. Must be a non-empty string.
 * @param client  Optional injected client (defaults to the singleton).
 */
export async function generateEmbedding(
  text: string,
  client: EmbeddingsClient = getOpenAIClient(),
): Promise<number[]> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('generateEmbedding: text must be a non-empty string');
  }

  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });

  const embedding = response?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('OpenAI embeddings response was empty or malformed');
  }

  return embedding;
}

/**
 * Splits `text` into overlapping chunks suitable for embedding.
 *
 * Uses a character-based heuristic (~{@link CHARS_PER_TOKEN} chars per
 * token) so the function has no native dependencies. Chunks are split
 * on whitespace boundaries when possible to avoid breaking words.
 *
 * @param text          Source text. Whitespace-only input yields `[]`.
 * @param maxTokens     Maximum tokens per chunk (default 500).
 * @param overlapTokens Token overlap between adjacent chunks (default 50).
 *                      Must be strictly less than `maxTokens`.
 */
export function chunkText(
  text: string,
  maxTokens: number = DEFAULT_CHUNK_TOKENS,
  overlapTokens: number = DEFAULT_CHUNK_OVERLAP_TOKENS,
): string[] {
  if (typeof text !== 'string') {
    return [];
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error('chunkText: maxTokens must be a positive number');
  }
  if (!Number.isFinite(overlapTokens) || overlapTokens < 0) {
    throw new Error('chunkText: overlapTokens must be non-negative');
  }
  if (overlapTokens >= maxTokens) {
    throw new Error('chunkText: overlapTokens must be smaller than maxTokens');
  }

  const maxChars = Math.max(1, Math.floor(maxTokens * CHARS_PER_TOKEN));
  const overlapChars = Math.max(0, Math.floor(overlapTokens * CHARS_PER_TOKEN));
  const stride = maxChars - overlapChars;

  if (trimmed.length <= maxChars) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < trimmed.length) {
    let end = Math.min(start + maxChars, trimmed.length);

    // Try to split on whitespace to avoid mid-word breaks, unless we're
    // at the end of the input.
    if (end < trimmed.length) {
      const slice = trimmed.slice(start, end);
      const lastWs = slice.search(/\s\S*$/);
      if (lastWs > 0 && lastWs > Math.floor(maxChars / 2)) {
        end = start + lastWs;
      }
    }

    const chunk = trimmed.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    if (end >= trimmed.length) {
      break;
    }

    const nextStart = end - overlapChars;
    // Ensure forward progress; otherwise stop to avoid infinite loops.
    if (nextStart <= start || stride <= 0) {
      break;
    }
    start = nextStart;
  }

  return chunks;
}
