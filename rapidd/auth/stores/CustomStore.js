const ISessionStore = require('../ISessionStore');

/**
 * Custom Session Store Template
 *
 * Copy this file and rename it to create your own session store.
 * The filename (without .js) becomes the store name.
 *
 * Example: DatabaseStore.js -> AUTH_SESSION_STORAGE=databasestore
 *
 * Usage:
 *   1. Copy this file: cp CustomStore.js MyStore.js
 *   2. Implement the methods below
 *   3. Set AUTH_SESSION_STORAGE=mystore in .env
 */
class CustomStore extends ISessionStore {
    /**
     * @param {Object} options
     * @param {number} options.ttl - Session TTL in seconds
     */
    constructor(options = {}) {
        super();
        this.ttl = options.ttl || 86400;

        // Initialize your storage connection here
        // Example:
        // this.db = require('./my-database');
    }

    /**
     * Create a new session
     * @param {string} sessionId - Unique session identifier
     * @param {Object} data - Session data (user object)
     */
    async create(sessionId, data) {
        // TODO: Implement session creation
        // Example:
        // await this.db.sessions.create({
        //     id: sessionId,
        //     data: JSON.stringify(data),
        //     expiresAt: new Date(Date.now() + this.ttl * 1000)
        // });
        throw new Error('CustomStore.create() not implemented');
    }

    /**
     * Get session data by ID
     * @param {string} sessionId - Session identifier
     * @returns {Promise<Object|null>} Session data or null if not found/expired
     */
    async get(sessionId) {
        // TODO: Implement session retrieval
        // Example:
        // const session = await this.db.sessions.findUnique({
        //     where: { id: sessionId }
        // });
        // if (!session || session.expiresAt < new Date()) {
        //     return null;
        // }
        // return JSON.parse(session.data);
        throw new Error('CustomStore.get() not implemented');
    }

    /**
     * Delete a session
     * @param {string} sessionId - Session identifier
     */
    async delete(sessionId) {
        // TODO: Implement session deletion
        // Example:
        // await this.db.sessions.delete({
        //     where: { id: sessionId }
        // });
        throw new Error('CustomStore.delete() not implemented');
    }

    /**
     * Refresh session TTL (for sliding expiration)
     * @param {string} sessionId - Session identifier
     */
    async refresh(sessionId) {
        // TODO: Implement session refresh (optional)
        // Example:
        // await this.db.sessions.update({
        //     where: { id: sessionId },
        //     data: { expiresAt: new Date(Date.now() + this.ttl * 1000) }
        // });
    }

    /**
     * Check if store is healthy/connected
     * Used for automatic fallback to memory store
     * @returns {Promise<boolean>}
     */
    async isHealthy() {
        // TODO: Implement health check
        // Example:
        // try {
        //     await this.db.$queryRaw`SELECT 1`;
        //     return true;
        // } catch {
        //     return false;
        // }
        return true;
    }
}

module.exports = CustomStore;
