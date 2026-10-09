/** Options for a single session-store write */
export interface SessionWriteOptions {
    /** Lifetime in seconds for this entry (default: the store's TTL) */
    ttl?: number;
    /** Index the entry under this user so deleteByUser() can revoke it */
    userId?: string | number | null;
}

/**
 * Session Store Interface
 * All session stores must implement create/get/delete. The other methods have
 * non-atomic defaults built on those three; stores override them when the backend
 * can do better (Redis: GETEX, GETDEL, per-user index sets).
 */
export abstract class ISessionStore {
    abstract create(sessionId: string, data: Record<string, unknown>, options?: SessionWriteOptions): Promise<void>;
    abstract get(sessionId: string): Promise<Record<string, unknown> | null>;
    abstract delete(sessionId: string): Promise<void>;

    async refresh(_sessionId: string): Promise<void> {
        // Optional - default no-op
    }

    /** Read an entry and extend its TTL (sliding sessions) */
    async touch(sessionId: string): Promise<Record<string, unknown> | null> {
        const data = await this.get(sessionId);
        if (data) await this.refresh(sessionId);
        return data;
    }

    /** Read and delete an entry — for single-use values (login state, one-time tickets) */
    async take(sessionId: string): Promise<Record<string, unknown> | null> {
        const data = await this.get(sessionId);
        if (data) await this.delete(sessionId);
        return data;
    }

    /** Write only if the entry still exists; true when written. Default is not atomic. */
    async replace(sessionId: string, data: Record<string, unknown>, options?: SessionWriteOptions): Promise<boolean> {
        if (!await this.get(sessionId)) return false;
        await this.create(sessionId, data, options);
        return true;
    }

    /** Write only if the entry does not exist yet; true when written. Default is not atomic. */
    async add(sessionId: string, data: Record<string, unknown>, options?: SessionWriteOptions): Promise<boolean> {
        if (await this.get(sessionId)) return false;
        await this.create(sessionId, data, options);
        return true;
    }

    /**
     * Delete every entry written with this userId. Returns the number of entries removed.
     * Optional — Auth.revokeUserSessions() reports stores without it as unsupported.
     */
    deleteByUser?(userId: string | number): Promise<number>;

    async isHealthy(): Promise<boolean> {
        return true;
    }

    destroy?(): void | Promise<void>;
}
