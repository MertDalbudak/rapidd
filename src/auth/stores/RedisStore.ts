import Redis from 'ioredis';
import { ISessionStore } from './ISessionStore';

/**
 * Redis session store using ioredis.
 * Recommended for production and multi-instance deployments.
 */
export class RedisStore extends ISessionStore {
    private ttl: number;
    private prefix: string;
    private client: Redis | null = null;
    private _initialized = false;

    constructor(options: { ttl?: number; prefix?: string } = {}) {
        super();
        this.ttl = options.ttl || 86400;
        this.prefix = options.prefix || 'session:';
    }

    private _ensureClient(): Redis {
        if (this._initialized && this.client) return this.client;

        const host = process.env.REDIS_HOST || 'localhost';
        const port = parseInt(process.env.REDIS_PORT || '6379', 10);
        const db = parseInt(process.env.REDIS_DB_AUTH || '1', 10);
        const password = process.env.REDIS_PASSWORD || undefined;

        this.client = new Redis({
            host,
            port,
            db,
            password,
            retryStrategy: (times: number) => Math.min(times * 500, 30000),
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            connectTimeout: 5000,
        });

        this.client.on('connect', () => console.log('[RedisStore] Connected'));
        this.client.on('ready', () => console.log('[RedisStore] Ready'));
        this.client.on('error', (err: Error) => console.error('[RedisStore] Error:', err.message));
        this.client.on('close', () => console.warn('[RedisStore] Connection closed'));
        this.client.on('reconnecting', () => console.log('[RedisStore] Reconnecting...'));

        this._initialized = true;
        return this.client;
    }

    private _key(sessionId: string): string {
        return `${this.prefix}${sessionId}`;
    }

    async create(sessionId: string, data: Record<string, unknown>): Promise<void> {
        const client = this._ensureClient();
        await client.set(this._key(sessionId), JSON.stringify(data), 'EX', this.ttl);
    }

    async get(sessionId: string): Promise<Record<string, unknown> | null> {
        const client = this._ensureClient();
        const result = await client.get(this._key(sessionId));
        return result ? JSON.parse(result) : null;
    }

    async delete(sessionId: string): Promise<void> {
        const client = this._ensureClient();
        await client.del(this._key(sessionId));
    }

    async refresh(sessionId: string): Promise<void> {
        const client = this._ensureClient();
        await client.expire(this._key(sessionId), this.ttl);
    }

    async isHealthy(): Promise<boolean> {
        try {
            const client = this._ensureClient();
            if (client.status !== 'ready') return false;
            const result = await client.ping();
            return result === 'PONG';
        } catch {
            return false;
        }
    }

    async destroy(): Promise<void> {
        if (this.client) {
            await this.client.quit();
            this.client = null;
            this._initialized = false;
        }
    }
}
