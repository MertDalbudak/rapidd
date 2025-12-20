const Redis = require('ioredis');
const ISessionStore = require('../ISessionStore');

/**
 * Redis session store using ioredis
 * Recommended for production and multi-instance deployments
 *
 * Environment variables:
 * - REDIS_HOST (default: localhost)
 * - REDIS_PORT (default: 6379)
 * - REDIS_DB_AUTH (default: 1)
 * - REDIS_PASSWORD (optional)
 */
class RedisStore extends ISessionStore {
    constructor(options = {}) {
        super();
        this.ttl = options.ttl || 86400; // seconds
        this.prefix = options.prefix || 'session:';
        this.client = null;
        this._initialized = false;
    }

    /**
     * Initialize Redis client (once)
     * ioredis handles reconnection automatically
     */
    _ensureClient() {
        if (this._initialized) return this.client;

        const host = process.env.REDIS_HOST || 'localhost';
        const port = parseInt(process.env.REDIS_PORT, 10) || 6379;
        const db = parseInt(process.env.REDIS_DB_AUTH, 10) || 1;
        const password = process.env.REDIS_PASSWORD || undefined;

        this.client = new Redis({
            host,
            port,
            db,
            password,
            // ioredis auto-reconnects by default
            retryStrategy: (times) => {
                // Exponential backoff, max 30 seconds
                return Math.min(times * 500, 30000);
            },
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            connectTimeout: 5000
        });

        this.client.on('connect', () => {
            console.log('[RedisStore] Connected');
        });

        this.client.on('ready', () => {
            console.log('[RedisStore] Ready');
        });

        this.client.on('error', (err) => {
            console.error('[RedisStore] Error:', err.message);
        });

        this.client.on('close', () => {
            console.warn('[RedisStore] Connection closed');
        });

        this.client.on('reconnecting', () => {
            console.log('[RedisStore] Reconnecting...');
        });

        this._initialized = true;
        return this.client;
    }

    _key(sessionId) {
        return `${this.prefix}${sessionId}`;
    }

    async create(sessionId, data) {
        const client = this._ensureClient();
        await client.set(this._key(sessionId), JSON.stringify(data), 'EX', this.ttl);
    }

    async get(sessionId) {
        const client = this._ensureClient();
        const result = await client.get(this._key(sessionId));
        return result ? JSON.parse(result) : null;
    }

    async delete(sessionId) {
        const client = this._ensureClient();
        await client.del(this._key(sessionId));
    }

    async refresh(sessionId) {
        const client = this._ensureClient();
        await client.expire(this._key(sessionId), this.ttl);
    }

    async isHealthy() {
        try {
            const client = this._ensureClient();
            // Check ioredis status - 'ready' means connected and ready for commands
            if (client.status !== 'ready') {
                return false;
            }
            const result = await client.ping();
            return result === 'PONG';
        } catch {
            return false;
        }
    }

    async destroy() {
        if (this.client) {
            await this.client.quit();
            this.client = null;
            this._initialized = false;
        }
    }
}

module.exports = RedisStore;
