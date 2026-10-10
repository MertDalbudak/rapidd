import { ISessionStore, SessionWriteOptions } from './ISessionStore';
import { Logger } from '../../utils/Logger';

interface SessionEntry {
    data: Record<string, unknown>;
    expiresAt: number;
    userId?: string;
}

/** Default cap — unauthenticated routes (e.g. redirect-login state) must not grow memory without bound */
const DEFAULT_MAX_ENTRIES = 100_000;

/**
 * In-memory session store.
 * Suitable for development or single-instance deployments.
 *
 * Every operation is synchronous under the hood (no await between read and write), so
 * take / replace / add are atomic on the event loop. Reads return copies: a caller
 * mutating the returned object (e.g. `request.user`) can never rewrite the stored session.
 */
export class MemoryStore extends ISessionStore {
    private ttl: number;
    private maxEntries: number;
    private sessions = new Map<string, SessionEntry>();
    private byUser = new Map<string, Set<string>>();
    private _cleanupInterval: ReturnType<typeof setInterval>;
    private _warnedFull = false;

    constructor(options: { ttl?: number; maxEntries?: number } = {}) {
        super();
        this.ttl = (options.ttl || 86400) * 1000; // Convert to ms
        this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
        this._cleanupInterval = setInterval(() => this._cleanup(), 60000);
        // Housekeeping must never keep the process alive
        this._cleanupInterval.unref?.();
    }

    async create(sessionId: string, data: Record<string, unknown>, options: SessionWriteOptions = {}): Promise<void> {
        this._write(sessionId, data, options);
    }

    async get(sessionId: string): Promise<Record<string, unknown> | null> {
        return copy(this._read(sessionId));
    }

    async delete(sessionId: string): Promise<void> {
        this._remove(sessionId);
    }

    async refresh(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.expiresAt = Date.now() + this.ttl;
        }
    }

    async touch(sessionId: string): Promise<Record<string, unknown> | null> {
        const data = this._read(sessionId);
        if (data) this.sessions.get(sessionId)!.expiresAt = Date.now() + this.ttl;
        return copy(data);
    }

    async take(sessionId: string): Promise<Record<string, unknown> | null> {
        // Read + delete without an await in between — atomic on the event loop, so a
        // single-use value can never be redeemed twice by concurrent requests
        const data = this._read(sessionId);
        if (data) this._remove(sessionId);
        return copy(data);
    }

    async replace(sessionId: string, data: Record<string, unknown>, options: SessionWriteOptions = {}): Promise<boolean> {
        if (!this._read(sessionId)) return false;
        this._write(sessionId, data, options);
        return true;
    }

    async add(sessionId: string, data: Record<string, unknown>, options: SessionWriteOptions = {}): Promise<boolean> {
        if (this._read(sessionId)) return false;
        this._write(sessionId, data, options);
        return true;
    }

    async deleteByUser(userId: string | number): Promise<number> {
        const keys = this.byUser.get(String(userId));
        if (!keys) return 0;
        let removed = 0;
        for (const key of [...keys]) {
            if (this.sessions.has(key)) removed++;
            this._remove(key);
        }
        this.byUser.delete(String(userId));
        return removed;
    }

    async isHealthy(): Promise<boolean> {
        return true;
    }

    private _write(sessionId: string, data: Record<string, unknown>, options: SessionWriteOptions): void {
        this._unindex(sessionId);
        if (!this.sessions.has(sessionId) && this.sessions.size >= this.maxEntries) {
            this._cleanup();
            // Still full: evict the oldest entry (Map keeps insertion order)
            if (this.sessions.size >= this.maxEntries) {
                if (!this._warnedFull) {
                    Logger.warn(`MemoryStore: ${this.maxEntries} entries reached — evicting the oldest. Use Redis for production traffic.`);
                    this._warnedFull = true;
                }
                this._remove(this.sessions.keys().next().value!);
            }
        }
        const userId = options.userId != null ? String(options.userId) : undefined;
        this.sessions.set(sessionId, {
            data: copy(data)!,
            expiresAt: Date.now() + (options.ttl != null ? options.ttl * 1000 : this.ttl),
            userId,
        });
        if (userId !== undefined) {
            let keys = this.byUser.get(userId);
            if (!keys) this.byUser.set(userId, keys = new Set());
            keys.add(sessionId);
        }
    }

    private _read(sessionId: string): Record<string, unknown> | null {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        if (Date.now() > session.expiresAt) {
            this._remove(sessionId);
            return null;
        }

        return session.data;
    }

    private _remove(sessionId: string): void {
        this._unindex(sessionId);
        this.sessions.delete(sessionId);
    }

    private _unindex(sessionId: string): void {
        const userId = this.sessions.get(sessionId)?.userId;
        if (userId === undefined) return;
        const keys = this.byUser.get(userId);
        keys?.delete(sessionId);
        if (keys && keys.size === 0) this.byUser.delete(userId);
    }

    private _cleanup(): void {
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            if (session.expiresAt < now) {
                this._remove(id);
            }
        }
    }

    destroy(): void {
        clearInterval(this._cleanupInterval);
        this.sessions.clear();
        this.byUser.clear();
    }
}

/**
 * JSON round-trip copy — exactly what the Redis store returns, so development (memory) and
 * production (Redis) see identical session data: Dates as ISO strings, Decimals via toJSON,
 * BigInts as strings.
 */
function copy(data: Record<string, unknown> | null): Record<string, unknown> | null {
    return data === null ? null : JSON.parse(JSON.stringify(data, bigintSafe));
}

function bigintSafe(_key: string, value: unknown): unknown {
    return typeof value === 'bigint' ? value.toString() : value;
}
