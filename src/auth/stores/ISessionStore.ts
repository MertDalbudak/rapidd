/**
 * Session Store Interface
 * All session stores must implement these methods
 */
export abstract class ISessionStore {
    abstract create(sessionId: string, data: Record<string, unknown>): Promise<void>;
    abstract get(sessionId: string): Promise<Record<string, unknown> | null>;
    abstract delete(sessionId: string): Promise<void>;

    async refresh(_sessionId: string): Promise<void> {
        // Optional - default no-op
    }

    async isHealthy(): Promise<boolean> {
        return true;
    }

    destroy?(): void | Promise<void>;
}
