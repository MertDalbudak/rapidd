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
 * - RESP2 (`protocol: 2`), as before ioredis 6.
 * - `env` defaults to process.env (the setup wizard passes the settings being edited).
 */
export function createRedisClient(options: RedisOptions = {}, env: NodeJS.ProcessEnv = process.env): Redis {
    const shared: RedisOptions = {
        // ioredis 6 speaks RESP3 by default: RESP2 keeps the replies (Lua scripts included) as
        // they were, and works with servers before Redis 6
        protocol: 2,
        ...(env.REDIS_USERNAME ? { username: env.REDIS_USERNAME } : {}),
        ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
        ...(env.REDIS_TLS === 'true' ? { tls: {} } : {}),
        ...options,
    };

    if (env.REDIS_URL) {
        return new Redis(env.REDIS_URL, shared);
    }
    return new Redis({
        host: env.REDIS_HOST || 'localhost',
        port: parseInt(env.REDIS_PORT || '6379', 10),
        ...shared,
    });
}
