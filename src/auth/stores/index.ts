import { ISessionStore } from './ISessionStore';
import { MemoryStore } from './MemoryStore';
import { RedisStore } from './RedisStore';
import { Logger } from '../../utils/Logger';

const builtInStores: Record<string, new (options?: any) => ISessionStore> = {
    memory: MemoryStore,
    redis: RedisStore,
};

/**
 * Central session store manager with automatic fallback.
 * Handles store failures transparently and switches to fallback.
 */
export class SessionStoreManager extends ISessionStore {
    private ttl: number;
    private storeName: string;
    private healthCheckInterval: number;
    private _primaryStore: ISessionStore | null = null;
    private _fallbackStore: ISessionStore | null = null;
    private _usingFallback = false;
    private _initialized = false;
    private _healthCheckTimer: ReturnType<typeof setInterval> | null = null;

    constructor(options: { ttl?: number; store?: string; healthCheckInterval?: number } = {}) {
        super();
        this.ttl = options.ttl || parseInt(process.env.AUTH_SESSION_TTL || '86400', 10);
        this.storeName = (options.store || process.env.AUTH_SESSION_STORAGE || 'redis').toLowerCase();
        this.healthCheckInterval = options.healthCheckInterval || 30000;
    }

    private async _ensureInitialized(): Promise<void> {
        if (this._initialized) return;

        this._fallbackStore = new MemoryStore({ ttl: this.ttl });

        if (this.storeName === 'memory') {
            this._primaryStore = this._fallbackStore;
            this._initialized = true;
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
            this._primaryStore = new StoreClass({ ttl: this.ttl });
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
    }

    private async _checkPrimaryHealth(): Promise<void> {
        try {
            const isHealthy = await this._primaryStore!.isHealthy();
            if (isHealthy && this._usingFallback) {
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

    async create(sessionId: string, data: Record<string, unknown>): Promise<void> {
        return this._execute('create', sessionId, data);
    }

    async get(sessionId: string): Promise<Record<string, unknown> | null> {
        return this._execute('get', sessionId);
    }

    async delete(sessionId: string): Promise<void> {
        return this._execute('delete', sessionId);
    }

    async refresh(sessionId: string): Promise<void> {
        return this._execute('refresh', sessionId);
    }

    async isHealthy(): Promise<boolean> {
        await this._ensureInitialized();
        const store = this._usingFallback ? this._fallbackStore! : this._primaryStore!;
        return store.isHealthy();
    }

    destroy(): void {
        if (this._healthCheckTimer) {
            clearInterval(this._healthCheckTimer);
            this._healthCheckTimer = null;
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

export function createStore(options: { ttl?: number; store?: string } = {}): SessionStoreManager {
    return new SessionStoreManager(options);
}

export { ISessionStore, MemoryStore, RedisStore };
