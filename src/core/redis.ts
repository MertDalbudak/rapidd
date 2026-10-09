import Redis, { RedisOptions } from 'ioredis';

/**
 * Whether a Redis server is configured (REDIS_URL or REDIS_HOST).
 * Session storage and rate limiting use Redis when it is, and process memory otherwise.
 */
export function isRedisConfigured(): boolean {
    return !!(process.env.REDIS_URL || process.env.REDIS_HOST);
}

/**
 * Create an ioredis client from the shared REDIS_* env configuration.
 *
 * - `REDIS_URL` (redis:// or rediss:// for TLS) takes precedence over REDIS_HOST/REDIS_PORT.
 *   A database number in the URL wins over the per-purpose `db` passed here.
 * - `REDIS_USERNAME` / `REDIS_PASSWORD` for Redis 6+ ACL users.
 * - `REDIS_TLS=true` enables TLS for host/port configs (managed Redis on Azure/AWS/GCP).
 */
export function createRedisClient(options: RedisOptions = {}): Redis {
    const shared: RedisOptions = {
        ...(process.env.REDIS_USERNAME ? { username: process.env.REDIS_USERNAME } : {}),
        ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
        ...(process.env.REDIS_TLS === 'true' ? { tls: {} } : {}),
        ...options,
    };

    if (process.env.REDIS_URL) {
        return new Redis(process.env.REDIS_URL, shared);
    }
    return new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        ...shared,
    });
}
