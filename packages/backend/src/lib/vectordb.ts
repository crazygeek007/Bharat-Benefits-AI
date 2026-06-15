import { Pinecone, Index } from '@pinecone-database/pinecone';

export interface VectorDBConfig {
  apiKey: string;
  indexName: string;
  namespace?: string;
}

function getVectorDBConfig(): VectorDBConfig {
  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'PINECONE_API_KEY environment variable is required for vector database connection'
    );
  }

  return {
    apiKey,
    indexName: process.env.PINECONE_INDEX_NAME || 'bharat-benefits-schemes',
    namespace: process.env.PINECONE_NAMESPACE || undefined,
  };
}

let pineconeClient: Pinecone | null = null;

/**
 * Gets or creates a singleton Pinecone client instance.
 * Used for storing and querying vector embeddings for semantic search
 * of government scheme data.
 */
export function getPineconeClient(): Pinecone {
  if (!pineconeClient) {
    const config = getVectorDBConfig();
    pineconeClient = new Pinecone({
      apiKey: config.apiKey,
    });
  }

  return pineconeClient;
}

/**
 * Gets the Pinecone index for scheme embeddings.
 * The index stores vector embeddings generated from scheme content
 * for semantic search and RAG retrieval.
 */
export function getSchemeIndex(): Index {
  const client = getPineconeClient();
  const config = getVectorDBConfig();
  return client.index(config.indexName);
}

/**
 * Gets the configured namespace for scheme embeddings.
 * Returns undefined if no namespace is configured.
 */
export function getSchemeNamespace(): string | undefined {
  const config = getVectorDBConfig();
  return config.namespace;
}

/**
 * Checks Pinecone connection health by describing the index.
 * Returns true if the index exists and is ready.
 */
export async function checkVectorDBHealth(): Promise<{
  healthy: boolean;
  indexName?: string;
  dimension?: number;
  recordCount?: number;
  error?: string;
}> {
  try {
    const client = getPineconeClient();
    const config = getVectorDBConfig();
    const indexDescription = await client.describeIndex(config.indexName);

    return {
      healthy: indexDescription.status?.ready === true,
      indexName: config.indexName,
      dimension: indexDescription.dimension,
      recordCount: indexDescription.status?.ready
        ? undefined
        : undefined,
    };
  } catch (error) {
    return {
      healthy: false,
      error:
        error instanceof Error ? error.message : 'Unknown Pinecone error',
    };
  }
}

/**
 * Disconnects the Pinecone client (resets singleton).
 * Pinecone's client doesn't require explicit disconnection,
 * but this resets the singleton for testing or reconfiguration.
 */
export function disconnectVectorDB(): void {
  pineconeClient = null;
}
