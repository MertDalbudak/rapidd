const ISessionStore = require('../ISessionStore');

/**
 * In-memory session store
 * Suitable for development or single-instance deployments
 */
class MemoryStore extends ISessionStore {
    constructor(options = {}) {
        super();
        this.ttl = (options.ttl || 86400) * 1000; // Convert to ms
        this.sessions = new Map();

        // Cleanup expired sessions every minute
        this._cleanupInterval = setInterval(() => this._cleanup(), 60000);
    }

    async create(sessionId, data) {
        this.sessions.set(sessionId, {
            data,
            expiresAt: Date.now() + this.ttl
        });
    }

    async get(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        if (Date.now() > session.expiresAt) {
            this.sessions.delete(sessionId);
            return null;
        }

        return session.data;
    }

    async delete(sessionId) {
        this.sessions.delete(sessionId);
    }

    async refresh(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.expiresAt = Date.now() + this.ttl;
        }
    }

    async isHealthy() {
        return true;
    }

    _cleanup() {
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            if (session.expiresAt < now) {
                this.sessions.delete(id);
            }
        }
    }

    destroy() {
        clearInterval(this._cleanupInterval);
        this.sessions.clear();
    }
}

module.exports = MemoryStore;
