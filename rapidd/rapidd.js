const { PrismaClient, Prisma } = require('../prisma/client');
const { AsyncLocalStorage } = require('async_hooks');
const acl = require('./acl');
const dmmf = require('./dmmf');

/** Request context storage for async operations */
const requestContext = new AsyncLocalStorage();

/** RLS configuration from environment variables */
const RLS_CONFIG = {
    namespace: process.env.RLS_NAMESPACE || 'app',
    userId: process.env.RLS_USER_ID || 'current_user_id',
    userRole: process.env.RLS_USER_ROLE || 'current_user_role',
};

// =====================================================
// DATABASE ADAPTER FACTORY
// =====================================================

/**
 * Detects database provider from connection string
 * @param {string} connectionString - Database connection URL
 * @returns {'postgresql'|'mysql'} Detected provider
 */
function detectProvider(connectionString) {
    if (!connectionString) return 'postgresql';
    if (connectionString.startsWith('mysql://') || connectionString.startsWith('mariadb://')) {
        return 'mysql';
    }
    return 'postgresql';
}

/**
 * Parses MySQL/MariaDB connection string into config object
 * @param {string} connectionString - Database connection URL
 * @returns {Object} Connection config for MariaDB adapter
 */
function parseMySQLConnectionString(connectionString) {
    const url = new URL(connectionString);
    return {
        host: url.hostname,
        port: parseInt(url.port, 10) || 3306,
        user: url.username,
        password: url.password,
        database: url.pathname.slice(1),
        connectionLimit: 10
    };
}

/**
 * Creates a database adapter based on provider.
 * Prisma 7 requires driver adapters for database connections.
 *
 * IMPORTANT: The adapter MUST match the provider in prisma/schema.prisma
 * - For PostgreSQL: datasource db { provider = "postgresql" }
 * - For MySQL/MariaDB: datasource db { provider = "mysql" }
 *
 * @param {string} connectionString - Database connection URL
 * @param {string|null} [provider=null] - Database provider (auto-detected if not provided)
 * @returns {{adapter: Object, pool: Object|null, provider: string}} Prisma adapter and underlying pool
 */
function createAdapter(connectionString, provider = null) {
    const detectedProvider = provider || process.env.DATABASE_PROVIDER || detectProvider(connectionString);

    if (detectedProvider === 'mysql' || detectedProvider === 'mariadb') {
        const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
        const config = parseMySQLConnectionString(connectionString);
        const adapter = new PrismaMariaDb(config);
        return { adapter, pool: null, provider: 'mysql' };
    } else {
        const { PrismaPg } = require('@prisma/adapter-pg');
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString });
        const adapter = new PrismaPg(pool);
        return { adapter, pool, provider: 'postgresql' };
    }
}

// =====================================================
// BASE PRISMA CLIENTS
// =====================================================

const authConnection = createAdapter(process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL);
const baseConnection = createAdapter(process.env.DATABASE_URL);

/** Database provider type ('postgresql' or 'mysql') */
const dbProvider = baseConnection.provider;

/**
 * Admin Prisma client for authentication operations.
 * Uses DATABASE_URL_ADMIN connection for RLS bypass.
 * @type {PrismaClient}
 */
const authPrisma = new PrismaClient({
    adapter: authConnection.adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

/**
 * Base Prisma client for regular user operations with RLS.
 * Uses DATABASE_URL connection.
 * @type {PrismaClient}
 */
const basePrisma = new PrismaClient({
    adapter: baseConnection.adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

// =====================================================
// RLS HELPER FUNCTIONS
// =====================================================

/**
 * Sanitize value for use in RLS session variables
 * Prevents SQL injection by escaping quotes and validating input
 * @param {string|number} value - Value to sanitize
 * @returns {string} Sanitized value
 */
function sanitizeRLSValue(value) {
    if (value === null || value === undefined) {
        return '';
    }
    // Convert to string and escape single quotes
    return String(value).replace(/'/g, "''");
}

/**
 * Sets RLS session variables for the current transaction.
 * PostgreSQL uses SET LOCAL, MySQL uses user-defined variables (@var).
 * @param {Object} tx - Prisma transaction client
 * @param {string} userId - Current user ID
 * @param {string} userRole - Current user role
 */
async function setRLSVariables(tx, userId, userRole) {
    const { namespace, userId: userIdVar, userRole: userRoleVar } = RLS_CONFIG;

    // Sanitize inputs to prevent SQL injection
    const safeUserId = sanitizeRLSValue(userId);
    const safeUserRole = sanitizeRLSValue(userRole);

    if (dbProvider === 'mysql') {
        await tx.$executeRawUnsafe(`SET @${namespace}_${userIdVar} = '${safeUserId}'`);
        await tx.$executeRawUnsafe(`SET @${namespace}_${userRoleVar} = '${safeUserRole}'`);
    } else {
        await tx.$executeRawUnsafe(`SET LOCAL ${namespace}.${userIdVar} = '${safeUserId}'`);
        await tx.$executeRawUnsafe(`SET LOCAL ${namespace}.${userRoleVar} = '${safeUserRole}'`);
    }
}

/**
 * Resets RLS session variables for the current transaction
 * @param {Object} tx - Prisma transaction client
 */
async function resetRLSVariables(tx) {
    const { namespace, userId: userIdVar, userRole: userRoleVar } = RLS_CONFIG;

    try {
        if (dbProvider === 'mysql') {
            await tx.$executeRawUnsafe(`SET @${namespace}_${userIdVar} = NULL`);
            await tx.$executeRawUnsafe(`SET @${namespace}_${userRoleVar} = NULL`);
        } else {
            await tx.$executeRawUnsafe(`RESET ${namespace}.${userIdVar}`);
            await tx.$executeRawUnsafe(`RESET ${namespace}.${userRoleVar}`);
        }
    } catch (e) {
        // Ignore errors on reset
    }
}

// =====================================================
// EXTENDED PRISMA WITH AUTOMATIC RLS
// =====================================================

/**
 * Extended Prisma client with automatic RLS context.
 * Automatically wraps all operations in RLS context from AsyncLocalStorage.
 * @type {PrismaClient}
 */
const prisma = basePrisma.$extends({
    query: {
        async $allOperations({ operation, args, query, model }) {
            const context = requestContext.getStore();

            if (!context?.userId || !context?.userRole) {
                return query(args);
            }

            const { userId, userRole } = context;

            if (operation === '$transaction') {
                return basePrisma.$transaction(async (tx) => {
                    await setRLSVariables(tx, userId, userRole);
                    return query(args);
                });
            }

            return basePrisma.$transaction(async (tx) => {
                await setRLSVariables(tx, userId, userRole);

                if (model) {
                    return tx[model][operation](args);
                } else {
                    return tx[operation](args);
                }
            });
        },
    },
});

// =====================================================
// TRANSACTION HELPERS
// =====================================================

/**
 * Executes multiple operations in a single transaction with RLS context
 * @param {Array<Function>} operations - Array of functions that receive tx and return promises
 * @returns {Promise<Array>} Results of all operations
 */
async function prismaTransaction(operations) {
    const context = requestContext.getStore();

    return basePrisma.$transaction(async (tx) => {
        if (context?.userId && context?.userRole) {
            await setRLSVariables(tx, context.userId, context.userRole);
        }
        return Promise.all(operations.map(op => op(tx)));
    });
}

// =====================================================
// CONTEXT HELPERS
// =====================================================

/**
 * Express middleware that sets RLS context from authenticated user.
 * Use this AFTER your authentication middleware.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function setRLSContext(req, res, next) {
    if (req.user) {
        requestContext.run(
            {
                userId: req.user.id,
                userRole: req.user.role
            },
            () => next()
        );
    } else {
        next();
    }
}

/**
 * Returns the current RLS configuration
 * @returns {{namespace: string, userId: string, userRole: string}} RLS config
 */
function getRLSConfig() {
    return RLS_CONFIG;
}

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

/**
 * Disconnects all Prisma clients and closes connection pools
 * @returns {Promise<void>}
 */
async function disconnectAll() {
    await authPrisma.$disconnect();
    await basePrisma.$disconnect();
    if (authConnection.pool) {
        await authConnection.pool.end();
    }
    if (baseConnection.pool) {
        await baseConnection.pool.end();
    }
}

process.on('beforeExit', async () => {
    await disconnectAll();
});

// =====================================================
// INITIALIZATION
// =====================================================

/**
 * Initializes the DMMF (must be called before using QueryBuilder).
 * Loads the full Prisma DMMF from @prisma/internals.
 * @returns {Promise<Object>} The loaded DMMF
 */
async function initializeDMMF() {
    return dmmf.loadDMMF();
}

// Auto-initialize DMMF on module load
initializeDMMF();

// =====================================================
// EXPORTS
// =====================================================

// Lazy-load to avoid circular dependencies
const getModelMiddleware = () => require('./modelMiddleware').modelMiddleware;

module.exports = {
    // Main clients
    prisma,
    authPrisma,

    // Transaction helpers
    prismaTransaction,

    // Context helpers
    requestContext,
    setRLSContext,

    // RLS utilities
    setRLSVariables,
    resetRLSVariables,
    getRLSConfig,

    // Utilities
    disconnectAll,
    initializeDMMF,
    PrismaClient,
    Prisma,
    acl,
    dmmf,

    // Database info
    dbProvider,

    // Model middleware (lazy-loaded)
    get modelMiddleware() {
        return getModelMiddleware();
    }
};