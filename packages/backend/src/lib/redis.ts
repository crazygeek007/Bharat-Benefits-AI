import Redis from 'ioredis';

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  maxRetriesPerRequest?: number;
  connectTimeout?: number;
}

function getRedisConfig(): RedisConfig {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB) || 0,
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'bharat:',
    maxRetriesPerRequest: Number(process.env.REDIS_MAX_RETRIES) || 3,
    connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT) || 5000,
  };
}

let redisClient: Redis | null = null;

/**
 * Gets or creates a singleton Redis client instance.
 * Used for session management and API response caching.
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    const config = getRedisConfig();
    // Managed Redis providers (Upstash, ElastiCache TLS endpoints, etc.)
    // require TLS on the connection. We auto-enable it whenever
    // `REDIS_TLS=true` is set OR the host looks like an Upstash endpoint
    // (`*.upstash.io`). Self-hosted dev Redis on `localhost` stays plain
    // TCP. The opt-in env var lets callers force-disable detection if
    // their managed provider serves TLS on a non-Upstash hostname.
    const useTls =
      process.env.REDIS_TLS === 'true' ||
      (process.env.REDIS_TLS !== 'false' && config.host.endsWith('.upstash.io'));

    redisClient = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
      keyPrefix: config.keyPrefix,
      maxRetriesPerRequest: config.maxRetriesPerRequest,
      connectTimeout: config.connectTimeout,
      lazyConnect: true,
      // Empty TLS options ⇒ defaults (verify cert, SNI from host). Upstash
      // serves a real cert so no `rejectUnauthorized: false` workaround
      // is needed — leaving the default keeps the connection authentic.
      ...(useTls ? { tls: {} } : {}),
    });
  }
  return redisClient;
}

/**
 * Checks Redis connection health by sending a PING command.
 * Returns true if Redis responds with PONG.
 */
export async function checkRedisHealth(): Promise<{
  healthy: boolean;
  latencyMs?: number;
  error?: string;
}> {
  try {
    const client = getRedisClient();
    const start = Date.now();
    const result = await client.ping();
    const latencyMs = Date.now() - start;

    return {
      healthy: result === 'PONG',
      latencyMs,
    };
  } catch (error) {
    return {
      healthy: false,
      error: error instanceof Error ? error.message : 'Unknown Redis error',
    };
  }
}

/**
 * Gracefully disconnects the Redis client.
 */
export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
