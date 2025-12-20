/**
 * Session Store Interface
 * All session stores must implement these methods
 */
class ISessionStore {
    /**
     * Create a new session
     * @param {string} sessionId - Unique session identifier
     * @param {Object} data - Session data to store
     * @returns {Promise<void>}
     */
    async create(sessionId, data) {
        throw new Error('Not implemented');
    }

    /**
     * Get session data by ID
     * @param {string} sessionId - Session identifier
     * @returns {Promise<Object|null>} Session data or null if not found/expired
     */
    async get(sessionId) {
        throw new Error('Not implemented');
    }

    /**
     * Delete a session
     * @param {string} sessionId - Session identifier
     * @returns {Promise<void>}
     */
    async delete(sessionId) {
        throw new Error('Not implemented');
    }

    /**
     * Refresh session TTL (for sliding expiration)
     * @param {string} sessionId - Session identifier
     * @returns {Promise<void>}
     */
    async refresh(sessionId) {
        // Optional - default no-op
    }

    /**
     * Check if store is healthy/connected
     * @returns {Promise<boolean>}
     */
    async isHealthy() {
        return true;
    }
}

module.exports = ISessionStore;
