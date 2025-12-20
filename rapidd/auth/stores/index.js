const fs = require('fs');
const path = require('path');
const ISessionStore = require('../ISessionStore');
const MemoryStore = require('./MemoryStore');
const RedisStore = require('./RedisStore');

// ============================================
// STORE REGISTRY
// ============================================

const builtInStores = {
    memory: MemoryStore,
    redis: RedisStore
};

// Load custom stores from this directory (any .js file not built-in)
const customStores = {};
fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.js') && !['index.js', 'MemoryStore.js', 'RedisStore.js'].includes(f))
    .forEach(file => {
        const name = path.parse(file).name.toLowerCase();
        customStores[name] = require(path.join(__dirname, file));
    });

const stores = { ...builtInStores, ...customStores };

// ============================================
// SESSION STORE MANAGER
// ============================================

/**
 * Central session store manager with automatic fallback
 * Handles store failures transparently and switches to fallback
 * Background health check periodically monitors primary store
 */
class SessionStoreManager extends ISessionStore {
    constructor(options = {}) {
        super();
        this.ttl = options.ttl || parseInt(process.env.AUTH_SESSION_TTL, 10) || 86400;
        this.storeName = (options.store || process.env.AUTH_SESSION_STORAGE || 'redis').toLowerCase();
        this.healthCheckInterval = options.healthCheckInterval || 30000; // Check every 30s

        this._primaryStore = null;
        this._fallbackStore = null;
        this._usingFallback = false;
        this._initialized = false;
        this._healthCheckTimer = null;
    }

    /**
     * Initialize stores lazily on first use
     */
    async _ensureInitialized() {
        if (this._initialized) return;

        // Create fallback store (always memory)
        this._fallbackStore = new MemoryStore({ ttl: this.ttl });

        // If explicitly set to memory, no need for primary
        if (this.storeName === 'memory') {
            this._primaryStore = this._fallbackStore;
            this._initialized = true;
            return;
        }

        // Create primary store
        const StoreClass = stores[this.storeName];
        if (!StoreClass) {
            console.warn(`[SessionStore] Unknown store "${this.storeName}", using memory`);
            this._primaryStore = this._fallbackStore;
            this._initialized = true;
            return;
        }

        try {
            this._primaryStore = new StoreClass({ ttl: this.ttl });
        } catch (err) {
            console.warn(`[SessionStore] Failed to create ${this.storeName}: ${err.message}, using memory`);
            this._primaryStore = this._fallbackStore;
        }

        this._initialized = true;

        // Start background health check if primary is different from fallback
        if (this._primaryStore !== this._fallbackStore) {
            this._startHealthCheck();
        }
    }

    /**
     * Start background health check interval
     */
    _startHealthCheck() {
        if (this._healthCheckTimer) return;

        this._healthCheckTimer = setInterval(async () => {
            await this._checkPrimaryHealth();
        }, this.healthCheckInterval);
    }

    /**
     * Check primary store health and switch accordingly
     */
    async _checkPrimaryHealth() {
        try {
            const isHealthy = await this._primaryStore.isHealthy();

            if (isHealthy && this._usingFallback) {
                console.log(`[SessionStore] ${this.storeName} recovered, switching back from memory`);
                this._usingFallback = false;
            } else if (!isHealthy && !this._usingFallback) {
                console.warn(`[SessionStore] ${this.storeName} unavailable, switching to memory`);
                this._usingFallback = true;
            }
        } catch {
            if (!this._usingFallback) {
                console.warn(`[SessionStore] ${this.storeName} health check failed, switching to memory`);
                this._usingFallback = true;
            }
        }
    }

    /**
     * Execute operation on active store, fallback on failure
     */
    async _execute(operation, ...args) {
        await this._ensureInitialized();

        // If primary is same as fallback, just use it
        if (this._primaryStore === this._fallbackStore) {
            return this._primaryStore[operation](...args);
        }

        // Use fallback if flagged
        if (this._usingFallback) {
            return this._fallbackStore[operation](...args);
        }

        // Use primary, switch to fallback on failure
        try {
            return await this._primaryStore[operation](...args);
        } catch (err) {
            console.warn(`[SessionStore] ${this.storeName}.${operation} failed: ${err.message}, switching to memory`);
            this._usingFallback = true;
            return this._fallbackStore[operation](...args);
        }
    }

    /**
     * Stop health check timer
     */
    destroy() {
        if (this._healthCheckTimer) {
            clearInterval(this._healthCheckTimer);
            this._healthCheckTimer = null;
        }
    }

    async create(sessionId, data) {
        return this._execute('create', sessionId, data);
    }

    async get(sessionId) {
        return this._execute('get', sessionId);
    }

    async delete(sessionId) {
        return this._execute('delete', sessionId);
    }

    async refresh(sessionId) {
        return this._execute('refresh', sessionId);
    }

    async isHealthy() {
        const store = await this._getStore();
        return store.isHealthy();
    }

    /**
     * Get current store status
     */
    getStatus() {
        return {
            configured: this.storeName,
            active: this._usingFallback ? 'memory' : this.storeName,
            usingFallback: this._usingFallback
        };
    }
}

// ============================================
// FACTORY
// ============================================

/**
 * Create a session store manager
 * @param {Object} [options]
 * @param {string} [options.store] - Store type (redis, memory, or custom)
 * @param {number} [options.ttl] - Session TTL in seconds
 * @returns {SessionStoreManager}
 */
function createStore(options = {}) {
    return new SessionStoreManager(options);
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    createStore,
    SessionStoreManager,
    ISessionStore,
    stores,

    // Individual stores for advanced usage
    MemoryStore,
    RedisStore
};
