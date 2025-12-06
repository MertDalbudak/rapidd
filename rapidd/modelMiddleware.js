/**
 * Model Middleware System
 * Allows registering middleware functions that run before/after Prisma operations
 *
 * @example
 * const { modelMiddleware } = require('./modelMiddleware');
 *
 * // Register a middleware for all models
 * modelMiddleware.use('before', 'create', async (context) => {
 *     context.data.createdAt = new Date();
 *     return context;
 * });
 *
 * // Register a middleware for specific model
 * modelMiddleware.use('before', 'create', async (context) => {
 *     if (context.model === 'users') {
 *         context.data.role = context.data.role || 'USER';
 *     }
 *     return context;
 * }, 'users');
 */

/** @type {Map<string, Function[]>} Middleware registry */
const middlewareRegistry = new Map();

/**
 * Supported operations for middleware
 * @type {string[]}
 */
const OPERATIONS = ['create', 'update', 'upsert', 'delete', 'get', 'getMany', 'count'];

/**
 * Supported hooks
 * @type {string[]}
 */
const HOOKS = ['before', 'after'];

/**
 * Generate a registry key for middleware lookup
 * @param {string} hook - 'before' or 'after'
 * @param {string} operation - Operation name (create, update, etc.)
 * @param {string} [model='*'] - Model name or '*' for all models
 * @returns {string} Registry key
 */
function getKey(hook, operation, model = '*') {
    return `${hook}:${operation}:${model}`;
}

/**
 * Register a middleware function
 * @param {'before'|'after'} hook - When to run: 'before' or 'after' the operation
 * @param {string} operation - Operation to intercept: 'create', 'update', 'upsert', 'delete', 'get', 'getMany', 'count'
 * @param {Function} fn - Middleware function: async (context) => context
 * @param {string} [model='*'] - Model name to target, or '*' for all models
 * @throws {Error} If hook or operation is invalid
 *
 * @example
 * // Add timestamps to all creates
 * modelMiddleware.use('before', 'create', async (ctx) => {
 *     ctx.data.createdAt = new Date();
 *     ctx.data.createdBy = ctx.user?.id;
 *     return ctx;
 * });
 *
 * // Soft delete instead of hard delete for 'posts' model
 * modelMiddleware.use('before', 'delete', async (ctx) => {
 *     ctx.softDelete = true;
 *     ctx.data = { deletedAt: new Date() };
 *     return ctx;
 * }, 'posts');
 */
function use(hook, operation, fn, model = '*') {
    if (!HOOKS.includes(hook)) {
        throw new Error(`Invalid hook '${hook}'. Must be one of: ${HOOKS.join(', ')}`);
    }
    if (!OPERATIONS.includes(operation)) {
        throw new Error(`Invalid operation '${operation}'. Must be one of: ${OPERATIONS.join(', ')}`);
    }
    if (typeof fn !== 'function') {
        throw new Error('Middleware must be a function');
    }

    const key = getKey(hook, operation, model);
    if (!middlewareRegistry.has(key)) {
        middlewareRegistry.set(key, []);
    }
    middlewareRegistry.get(key).push(fn);
}

/**
 * Remove a specific middleware function
 * @param {'before'|'after'} hook - Hook type
 * @param {string} operation - Operation name
 * @param {Function} fn - The middleware function to remove
 * @param {string} [model='*'] - Model name
 * @returns {boolean} True if middleware was found and removed
 */
function remove(hook, operation, fn, model = '*') {
    const key = getKey(hook, operation, model);
    const middlewares = middlewareRegistry.get(key);
    if (!middlewares) return false;

    const index = middlewares.indexOf(fn);
    if (index > -1) {
        middlewares.splice(index, 1);
        return true;
    }
    return false;
}

/**
 * Clear all middleware for a specific hook/operation/model combination
 * @param {'before'|'after'} [hook] - Hook type (optional, clears all if not provided)
 * @param {string} [operation] - Operation name (optional)
 * @param {string} [model] - Model name (optional)
 */
function clear(hook, operation, model) {
    if (!hook && !operation && !model) {
        middlewareRegistry.clear();
        return;
    }

    const key = getKey(hook, operation, model);
    middlewareRegistry.delete(key);
}

/**
 * Get all middleware functions for a specific hook/operation/model
 * Returns both model-specific and global ('*') middleware
 * @param {'before'|'after'} hook - Hook type
 * @param {string} operation - Operation name
 * @param {string} model - Model name
 * @returns {Function[]} Array of middleware functions to execute
 */
function getMiddleware(hook, operation, model) {
    const globalKey = getKey(hook, operation, '*');
    const modelKey = getKey(hook, operation, model);

    const globalMiddleware = middlewareRegistry.get(globalKey) || [];
    const modelMiddleware = middlewareRegistry.get(modelKey) || [];

    // Global middleware runs first, then model-specific
    return [...globalMiddleware, ...modelMiddleware];
}

/**
 * Execute middleware chain for a given context
 * @param {'before'|'after'} hook - Hook type
 * @param {string} operation - Operation name
 * @param {Object} context - Context object to pass through middleware
 * @param {string} context.model - Model name
 * @param {Object} [context.data] - Data for create/update operations
 * @param {*} [context.id] - ID for get/update/delete operations
 * @param {Object} [context.user] - Current user
 * @param {Object} [context.options] - Additional options
 * @param {*} [context.result] - Result (for 'after' hooks)
 * @returns {Promise<Object>} Modified context
 */
async function execute(hook, operation, context) {
    const middlewares = getMiddleware(hook, operation, context.model);

    let ctx = { ...context };
    for (const fn of middlewares) {
        const result = await fn(ctx);
        if (result !== undefined) {
            ctx = result;
        }
        // Allow middleware to abort by setting ctx.abort = true
        if (ctx.abort) {
            break;
        }
    }

    return ctx;
}

/**
 * Create a middleware context object
 * @param {string} model - Model name
 * @param {string} operation - Operation being performed
 * @param {Object} params - Operation parameters
 * @param {Object} [user] - Current user
 * @returns {Object} Context object for middleware
 */
function createContext(model, operation, params, user = null) {
    return {
        model,
        operation,
        user,
        timestamp: new Date(),
        ...params,
        // Flags that middleware can set
        abort: false,
        skip: false,
        softDelete: false,
    };
}

/**
 * Model middleware instance
 */
const modelMiddleware = {
    use,
    remove,
    clear,
    getMiddleware,
    execute,
    createContext,
    OPERATIONS,
    HOOKS,
};

module.exports = { modelMiddleware };
