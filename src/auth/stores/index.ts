import { ISessionStore, SessionWriteOptions } from './ISessionStore';
import { MemoryStore } from './MemoryStore';
import { RedisStore } from './RedisStore';
import { isRedisConfigured } from '../../core/redis';
import { Logger } from '../../utils/Logger';

const builtInStores: Record<string, new (options?: any) => ISessionStore> = {
    memory: MemoryStore,
    redis: RedisStore,
};

export interface SessionStoreManagerOptions {
    /** Default entry lifetime in seconds (AUTH_SESSION_TTL) */
    ttl?: number;
    /** 'redis' | 'memory' (AUTH_SESSION_STORAGE; default: redis when REDIS_URL/REDIS_HOST is set) */
    store?: string;
    /** Upper bound of any entry's lifetime — sizes the per-user revocation index */
    indexTtl?: number;
    healthCheckInterval?: number;
}

/**
 * Central session store manager with automatic fallback.
 * Handles store failures transparently and switches to fallback.
 */
export class SessionStoreManager extends ISessionStore {
    private ttl: number;
    private indexTtl: number;
    private storeName: string;
    private healthCheckInterval: number;
    private _primaryStore: ISessionStore | null = null;
    private _fallbackStore: ISessionStore | null = null;
    private _usingFallback = false;
    private _initialized = false;
    private _healthCheckTimer: ReturnType<typeof setInterval> | null = null;
    /**
     * Deletions the primary could not receive (it was down). Replayed before switching back —
     * otherwise a logout or revocation made during a Redis outage would be undone the moment
     * Redis returns with its old copy of the session. Value: when the tombstone may be dropped.
     */
    private _pendingDeletes = new Map<string, number>();
    private _pendingUserDeletes = new Map<string, number>();

    constructor(options: SessionStoreManagerOptions = {}) {
        super();
        this.ttl = options.ttl || parseInt(process.env.AUTH_SESSION_TTL || '86400', 10);
        this.indexTtl = Math.max(options.indexTtl || 0, this.ttl);
        this.storeName = (options.store || process.env.AUTH_SESSION_STORAGE || (isRedisConfigured() ? 'redis' : 'memory')).toLowerCase();
        this.healthCheckInterval = options.healthCheckInterval || 30000;
    }

    private async _ensureInitialized(): Promise<void> {
        if (this._initialized) return;

        this._fallbackStore = new MemoryStore({ ttl: this.ttl });

        if (this.storeName === 'memory') {
            this._primaryStore = this._fallbackStore;
            this._initialized = true;
            if (process.env.NODE_ENV === 'production') {
                Logger.warn('SessionStore: using in-memory sessions in production — sessions are lost on restart and not shared between instances. Set REDIS_URL or REDIS_HOST.');
            }
            return;
        }

        const StoreClass = builtInStores[this.storeName];
        if (!StoreClass) {
            Logger.warn('SessionStore: unknown store, using memory', { store: this.storeName });
            this._primaryStore = this._fallbackStore;
            this._initialized = true;
            return;
        }

        try {
            this._primaryStore = new StoreClass({ ttl: this.ttl, indexTtl: this.indexTtl });
        } catch (err) {
            Logger.warn('SessionStore: failed to create store, using memory', { store: this.storeName, error: (err as Error).message });
            this._primaryStore = this._fallbackStore;
        }

        this._initialized = true;

        if (this._primaryStore !== this._fallbackStore) {
            this._startHealthCheck();
        }
    }

    private _startHealthCheck(): void {
        if (this._healthCheckTimer) return;
        this._healthCheckTimer = setInterval(() => this._checkPrimaryHealth(), this.healthCheckInterval);
        this._healthCheckTimer.unref?.();
    }

    private _remember(pending: Map<string, number>, key: string): void {
        const now = Date.now();
        for (const [k, expiresAt] of pending) {
            if (expiresAt < now) pending.delete(k);
        }
        pending.set(key, now + this.indexTtl * 1000);
    }

    /** Apply deletions made during the outage to the primary. False if it failed again. */
    private async _replayPending(): Promise<boolean> {
        try {
            for (const key of [...this._pendingDeletes.keys()]) {
                await this._primaryStore!.delete(key);
                this._pendingDeletes.delete(key);
            }
            for (const userId of [...this._pendingUserDeletes.keys()]) {
                await this._primaryStore!.deleteByUser?.(userId);
                this._pendingUserDeletes.delete(userId);
            }
            return true;
        } catch (err) {
            Logger.warn('SessionStore: replaying revocations failed — staying on memory', { store: this.storeName, error: (err as Error).message });
            return false;
        }
    }

    private async _checkPrimaryHealth(): Promise<void> {
        try {
            const isHealthy = await this._primaryStore!.isHealthy();
            if (isHealthy && this._usingFallback) {
                if (!await this._replayPending()) return;
                Logger.log('SessionStore: recovered, switching back from memory', { store: this.storeName });
                this._usingFallback = false;
            } else if (!isHealthy && !this._usingFallback) {
                Logger.warn('SessionStore: unavailable, switching to memory', { store: this.storeName });
                this._usingFallback = true;
            }
        } catch {
            if (!this._usingFallback) {
                Logger.warn('SessionStore: health check failed, switching to memory', { store: this.storeName });
                this._usingFallback = true;
            }
        }
    }

    private async _execute<T>(operation: string, ...args: any[]): Promise<T> {
        await this._ensureInitialized();

        if (this._primaryStore === this._fallbackStore) {
            return (this._primaryStore as any)[operation](...args);
        }

        if (this._usingFallback) {
            return (this._fallbackStore as any)[operation](...args);
        }

        try {
            return await (this._primaryStore as any)[operation](...args);
        } catch (err) {
            Logger.warn('SessionStore: operation failed, switching to memory', { store: this.storeName, operation, error: (err as Error).message });
            this._usingFallback = true;
            return (this._fallbackStore as any)[operation](...args);
        }
    }

    async create(sessionId: string, data: Record<string, unknown>, options?: SessionWriteOptions): Promise<void> {
        return this._execute('create', sessionId, data, options);
    }

    async get(sessionId: string): Promise<Record<string, unknown> | null> {
        return this._execute('get', sessionId);
    }

    async delete(sessionId: string): Promise<void> {
        await this._ensureInitialized();
        if (this._primaryStore === this._fallbackStore) return this._primaryStore!.delete(sessionId);

        // Copies created during an outage live in memory — always clear them
        await this._fallbackStore!.delete(sessionId);
        if (this._usingFallback) {
            this._remember(this._pendingDeletes, sessionId);
            return;
        }
        try {
            await this._primaryStore!.delete(sessionId);
        } catch (err) {
            Logger.warn('SessionStore: delete failed, switching to memory (will be replayed)', { store: this.storeName, error: (err as Error).message });
            this._usingFallback = true;
            this._remember(this._pendingDeletes, sessionId);
        }
    }

    async refresh(sessionId: string): Promise<void> {
        return this._execute('refresh', sessionId);
    }

    async touch(sessionId: string): Promise<Record<string, unknown> | null> {
        await this._ensureInitialized();
        const store = this._usingFallback ? this._fallbackStore! : this._primaryStore!;
        // Custom stores written against the original interface may lack touch()
        if (typeof (store as any).touch !== 'function') return super.touch(sessionId);
        return this._execute('touch', sessionId);
    }

    async take(sessionId: string): Promise<Record<string, unknown> | null> {
        await this._ensureInitialized();
        const store = this._usingFallback ? this._fallbackStore! : this._primaryStore!;
        if (typeof (store as any).take !== 'function') return super.take(sessionId);
        return this._execute('take', sessionId);
    }

    async replace(sessionId: string, data: Record<string, unknown>, options?: SessionWriteOptions): Promise<boolean> {
        await this._ensureInitialized();
        const store = this._usingFallback ? this._fallbackStore! : this._primaryStore!;
        if (typeof (store as any).replace !== 'function') return super.replace(sessionId, data, options);
        return this._execute('replace', sessionId, data, options);
    }

    async add(sessionId: string, data: Record<string, unknown>, options?: SessionWriteOptions): Promise<boolean> {
        await this._ensureInitialized();
        const store = this._usingFallback ? this._fallbackStore! : this._primaryStore!;
        if (typeof (store as any).add !== 'function') return super.add(sessionId, data, options);
        return this._execute('add', sessionId, data, options);
    }

    /**
     * Revoke a user's entries in BOTH the primary and the fallback store — sessions created
     * during a Redis outage live in memory, and revocation must reach them too.
     */
    async deleteByUser(userId: string | number): Promise<number> {
        await this._ensureInitialized();
        const stores = this._primaryStore === this._fallbackStore
            ? [this._primaryStore!]
            : [this._primaryStore!, this._fallbackStore!];

        for (const store of stores) {
            if (typeof store.deleteByUser !== 'function') {
                throw new Error(`[SessionStore] store "${this.storeName}" does not support deleteByUser()`);
            }
        }

        let removed = await this._fallbackStore!.deleteByUser!(userId);
        if (stores.length === 1) return removed;

        if (this._usingFallback) {
            this._remember(this._pendingUserDeletes, String(userId));
            return removed;
        }
        try {
            removed += await this._primaryStore!.deleteByUser!(userId);
        } catch (err) {
            // Memory is already clean and reads are served from it until the primary is back;
            // the revocation is replayed against the primary before switching back
            Logger.error('SessionStore: revoking user sessions failed on the primary — will be replayed', { store: this.storeName, error: (err as Error).message });
            this._usingFallback = true;
            this._remember(this._pendingUserDeletes, String(userId));
        }
        return removed;
    }

    async isHealthy(): Promise<boolean> {
        await this._ensureInitialized();
        const store = this._usingFallback ? this._fallbackStore! : this._primaryStore!;
        return store.isHealthy();
    }

    async destroy(): Promise<void> {
        if (this._healthCheckTimer) {
            clearInterval(this._healthCheckTimer);
            this._healthCheckTimer = null;
        }
        const stores = new Set([this._primaryStore, this._fallbackStore]);
        for (const store of stores) {
            await store?.destroy?.();
        }
    }

    getStatus(): { configured: string; active: string; usingFallback: boolean } {
        return {
            configured: this.storeName,
            active: this._usingFallback ? 'memory' : this.storeName,
            usingFallback: this._usingFallback,
        };
    }
}

export function createStore(options: SessionStoreManagerOptions = {}): SessionStoreManager {
    return new SessionStoreManager(options);
}

export { ISessionStore, MemoryStore, RedisStore };
export type { SessionWriteOptions };
