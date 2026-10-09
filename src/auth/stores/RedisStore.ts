import type Redis from 'ioredis';
import { ISessionStore, SessionWriteOptions } from './ISessionStore';
import { createRedisClient } from '../../core/redis';
import { Logger } from '../../utils/Logger';

/**
 * Redis session store using ioredis.
 * Recommended for production and multi-instance deployments.
 *
 * Entries written with a userId are also recorded in a per-user index set, so all of a
 * user's sessions can be revoked without scanning the keyspace.
 */
export class RedisStore extends ISessionStore {
    private ttl: number;
    private indexTtl: number;
    private prefix: string;
    private client: Redis | null = null;

    /**
     * @param options.ttl      default entry lifetime in seconds
     * @param options.indexTtl lifetime of the per-user index — must cover the longest-lived
     *                         entry (refresh tokens), or an entry could outlive its index
     *                         and escape revocation
     */
    constructor(options: { ttl?: number; indexTtl?: number; prefix?: string } = {}) {
        super();
        this.ttl = options.ttl || 86400;
        this.indexTtl = Math.max(options.indexTtl || 0, this.ttl);
        this.prefix = options.prefix || 'session:';
    }

    private _ensureClient(): Redis {
        if (this.client) return this.client;

        this.client = createRedisClient({
            db: parseInt(process.env.REDIS_DB_AUTH || '1', 10),
            retryStrategy: (times: number) => Math.min(times * 500, 30000),
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            connectTimeout: 5000,
        });

        this.client.on('ready', () => Logger.log('RedisStore ready'));
        this.client.on('error', (err: Error) => Logger.error(err));
        this.client.on('close', () => Logger.warn('RedisStore connection closed'));
        return this.client;
    }

    private _key(sessionId: string): string {
        return `${this.prefix}${sessionId}`;
    }

    private _userKey(userId: string | number): string {
        return `${this.prefix}idx:user:${userId}`;
    }

    async create(sessionId: string, data: Record<string, unknown>, options: SessionWriteOptions = {}): Promise<void> {
        const ttl = options.ttl ?? this.ttl;
        await this._ensureClient().set(this._key(sessionId), serialize(data), 'EX', ttl);
        await this._index(sessionId, options.userId, ttl);
    }

    /** SET … XX: only while the entry still exists (a refresh must not resurrect a revoked session) */
    async replace(sessionId: string, data: Record<string, unknown>, options: SessionWriteOptions = {}): Promise<boolean> {
        const ttl = options.ttl ?? this.ttl;
        const ok = await this._ensureClient().set(this._key(sessionId), serialize(data), 'EX', ttl, 'XX');
        if (ok !== 'OK') return false;
        await this._index(sessionId, options.userId, ttl);
        return true;
    }

    /** SET … NX: only if absent (single-use markers) */
    async add(sessionId: string, data: Record<string, unknown>, options: SessionWriteOptions = {}): Promise<boolean> {
        const ttl = options.ttl ?? this.ttl;
        const ok = await this._ensureClient().set(this._key(sessionId), serialize(data), 'EX', ttl, 'NX');
        if (ok !== 'OK') return false;
        await this._index(sessionId, options.userId, ttl);
        return true;
    }

    /**
     * Per-user index: a sorted set scored by expiry, pruned on every write so it never grows
     * with dead members. Single-key commands only (cluster-friendly); the index TTL is a fixed
     * upper bound, so no instance can shorten it below a sibling entry's lifetime.
     */
    private async _index(sessionId: string, userId: string | number | null | undefined, ttl: number): Promise<void> {
        if (userId == null) return;
        const userKey = this._userKey(userId);
        const now = Date.now();
        await this._ensureClient().pipeline()
            .zremrangebyscore(userKey, '-inf', now)
            .zadd(userKey, now + ttl * 1000, sessionId)
            .expire(userKey, Math.max(this.indexTtl, ttl))
            .exec();
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

    /** GET + EXPIRE in one round trip (MULTI) — the hot path of every authenticated request */
    async touch(sessionId: string): Promise<Record<string, unknown> | null> {
        const key = this._key(sessionId);
        const results = await this._ensureClient().multi().get(key).expire(key, this.ttl).exec();
        const value = results?.[0]?.[1] as string | null | undefined;
        return value ? JSON.parse(value) : null;
    }

    /** GET + DEL atomically (MULTI) — a single-use value can be redeemed only once */
    async take(sessionId: string): Promise<Record<string, unknown> | null> {
        const key = this._key(sessionId);
        const results = await this._ensureClient().multi().get(key).del(key).exec();
        const value = results?.[0]?.[1] as string | null | undefined;
        return value ? JSON.parse(value) : null;
    }

    async deleteByUser(userId: string | number): Promise<number> {
        const client = this._ensureClient();
        const userKey = this._userKey(userId);
        const members = await client.zrange(userKey, 0, -1);
        if (members.length === 0) return 0;
        // ZREM only the members we saw: a session created concurrently stays indexed
        const [[, deleted]] = (await client.pipeline()
            .del(...members.map((m) => this._key(m)))
            .zrem(userKey, ...members)
            .exec())!;
        return Number(deleted) || 0;
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
        const client = this.client;
        this.client = null;
        if (client && client.status !== 'end') {
            await client.quit().catch(() => client.disconnect());
        }
    }
}

/** JSON with BigInt support (Prisma BigInt ids) — the memory store copies data the same way */
function serialize(data: Record<string, unknown>): string {
    return JSON.stringify(data, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
}
