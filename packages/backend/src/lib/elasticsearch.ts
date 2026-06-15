import { Client } from '@elastic/elasticsearch';

export interface ElasticsearchConfig {
  node: string;
  apiKey?: string;
  username?: string;
  password?: string;
  caFingerprint?: string;
  requestTimeout?: number;
  maxRetries?: number;
}

function getElasticsearchConfig(): ElasticsearchConfig {
  return {
    node: process.env.ELASTICSEARCH_NODE || 'http://localhost:9200',
    apiKey: process.env.ELASTICSEARCH_API_KEY || undefined,
    username: process.env.ELASTICSEARCH_USERNAME || undefined,
    password: process.env.ELASTICSEARCH_PASSWORD || undefined,
    caFingerprint: process.env.ELASTICSEARCH_CA_FINGERPRINT || undefined,
    requestTimeout: Number(process.env.ELASTICSEARCH_REQUEST_TIMEOUT) || 30000,
    maxRetries: Number(process.env.ELASTICSEARCH_MAX_RETRIES) || 3,
  };
}

let esClient: Client | null = null;

/**
 * Gets or creates a singleton Elasticsearch client instance.
 * Used for full-text search indexing of government schemes.
 */
export function getElasticsearchClient(): Client {
  if (!esClient) {
    const config = getElasticsearchConfig();

    const clientOptions: ConstructorParameters<typeof Client>[0] = {
      node: config.node,
      requestTimeout: config.requestTimeout,
      maxRetries: config.maxRetries,
    };

    // Use API key auth if available, otherwise fall back to basic auth
    if (config.apiKey) {
      clientOptions.auth = { apiKey: config.apiKey };
    } else if (config.username && config.password) {
      clientOptions.auth = {
        username: config.username,
        password: config.password,
      };
    }

    if (config.caFingerprint) {
      clientOptions.caFingerprint = config.caFingerprint;
    }

    esClient = new Client(clientOptions);
  }

  return esClient;
}

/**
 * Checks Elasticsearch connection health by pinging the cluster.
 * Returns true if the cluster responds successfully.
 */
export async function checkElasticsearchHealth(): Promise<{
  healthy: boolean;
  clusterName?: string;
  status?: string;
  error?: string;
}> {
  try {
    const client = getElasticsearchClient();
    const start = Date.now();
    const health = await client.cluster.health();
    const latencyMs = Date.now() - start;

    return {
      healthy: health.status !== 'red',
      clusterName: health.cluster_name,
      status: health.status,
    };
  } catch (error) {
    return {
      healthy: false,
      error:
        error instanceof Error ? error.message : 'Unknown Elasticsearch error',
    };
  }
}

/**
 * Closes the Elasticsearch client connection.
 */
export async function disconnectElasticsearch(): Promise<void> {
  if (esClient) {
    await esClient.close();
    esClient = null;
  }
}

/** Index name for government schemes full-text search */
export const SCHEMES_INDEX = 'bharat_benefits_schemes';
