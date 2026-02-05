import { ISessionStore } from './ISessionStore';

interface SessionEntry {
    data: Record<string, unknown>;
    expiresAt: number;
}

/**
 * In-memory session store.
 * Suitable for development or single-instance deployments.
 */
export class MemoryStore extends ISessionStore {
    private ttl: number;
    private sessions = new Map<string, SessionEntry>();
    private _cleanupInterval: ReturnType<typeof setInterval>;

    constructor(options: { ttl?: number } = {}) {
        super();
        this.ttl = (options.ttl || 86400) * 1000; // Convert to ms
        this._cleanupInterval = setInterval(() => this._cleanup(), 60000);
    }

    async create(sessionId: string, data: Record<string, unknown>): Promise<void> {
        this.sessions.set(sessionId, {
            data,
            expiresAt: Date.now() + this.ttl,
        });
    }

    async get(sessionId: string): Promise<Record<string, unknown> | null> {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        if (Date.now() > session.expiresAt) {
            this.sessions.delete(sessionId);
            return null;
        }

        return session.data;
    }

    async delete(sessionId: string): Promise<void> {
        this.sessions.delete(sessionId);
    }

    async refresh(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.expiresAt = Date.now() + this.ttl;
        }
    }

    async isHealthy(): Promise<boolean> {
        return true;
    }

    private _cleanup(): void {
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            if (session.expiresAt < now) {
                this.sessions.delete(id);
            }
        }
    }

    destroy(): void {
        clearInterval(this._cleanupInterval);
        this.sessions.clear();
    }
}
