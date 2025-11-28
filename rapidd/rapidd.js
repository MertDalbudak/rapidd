const { PrismaClient, Prisma } = require('../prisma/client');
const { AsyncLocalStorage } = require('async_hooks');
const acl = require('./acl');
const dmmf = require('./dmmf');

// Request Context Storage
const requestContext = new AsyncLocalStorage();

// RLS Configuration aus Environment Variables
const RLS_CONFIG = {
    namespace: process.env.RLS_NAMESPACE || 'app',
    userId: process.env.RLS_USER_ID || 'current_user_id',
    userRole: process.env.RLS_USER_ROLE || 'current_user_role',
};

// =====================================================
// DATABASE ADAPTER FACTORY
// =====================================================

/**
 * Prisma 7 requires driver adapters for database connections.
 * Supports PostgreSQL and MySQL/MariaDB based on DATABASE_PROVIDER env var
 * or auto-detection from DATABASE_URL.
 *
 * IMPORTANT: The adapter MUST match the provider in prisma/schema.prisma
 * - For PostgreSQL: datasource db { provider = "postgresql" }
 * - For MySQL/MariaDB: datasource db { provider = "mysql" }
 *
 * If you change databases, you must:
 * 1. Update prisma/schema.prisma provider
 * 2. Run: npx prisma generate
 */

/**
 * Detect database provider from connection string
 * @param {string} connectionString - Database connection URL
 * @returns {string} 'postgresql' or 'mysql'
 */
function detectProvider(connectionString) {
    if (!connectionString) return 'postgresql';
    if (connectionString.startsWith('mysql://') || connectionString.startsWith('mariadb://')) {
        return 'mysql';
    }
    return 'postgresql';
}

/**
 * Parse MySQL/MariaDB connection string into config object
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
        database: url.pathname.slice(1), // Remove leading /
        connectionLimit: 10
    };
}

/**
 * Create database adapter based on provider
 * @param {string} connectionString - Database connection URL
 * @param {string} provider - Database provider (auto-detected if not provided)
 * @returns {Object} { adapter, pool } - Prisma adapter and underlying pool/connection
 */
function createAdapter(connectionString, provider = null) {
    const detectedProvider = provider || process.env.DATABASE_PROVIDER || detectProvider(connectionString);

    if (detectedProvider === 'mysql' || detectedProvider === 'mariadb') {
        // MySQL/MariaDB adapter
        const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
        const config = parseMySQLConnectionString(connectionString);
        const adapter = new PrismaMariaDb(config);
        return { adapter, pool: null, provider: 'mysql' };
    } else {
        // PostgreSQL adapter (default)
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

// Create adapters for auth and base clients
const authConnection = createAdapter(process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL);
const baseConnection = createAdapter(process.env.DATABASE_URL);

// Store provider info for RLS compatibility checks
const dbProvider = baseConnection.provider;

/**
 * ADMIN CLIENT - For authentication operations
 * Uses DATABASE_URL_ADMIN connection for RLS bypass
 */
const authPrisma = new PrismaClient({
    adapter: authConnection.adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

/**
 * BASE CLIENT - Regular user with RLS
 * Uses DATABASE_URL connection
 * Use for all business operations
 */
const basePrisma = new PrismaClient({
    adapter: baseConnection.adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

// =====================================================
// RLS HELPER FUNCTIONS
// =====================================================

/**
 * Set RLS Session Variables
 * PostgreSQL: Uses SET LOCAL for session variables
 * MySQL: Uses user-defined variables (@var)
 * Execute each SET command separately to avoid prepared statement error
 */
async function setRLSVariables(tx, userId, userRole) {
    const namespace = RLS_CONFIG.namespace;
    const userIdVar = RLS_CONFIG.userId;
    const userRoleVar = RLS_CONFIG.userRole;

    if (dbProvider === 'mysql') {
        // MySQL uses user-defined variables
        await tx.$executeRawUnsafe(`SET @${namespace}_${userIdVar} = '${userId}'`);
        await tx.$executeRawUnsafe(`SET @${namespace}_${userRoleVar} = '${userRole}'`);
    } else {
        // PostgreSQL uses session variables
        await tx.$executeRawUnsafe(`SET LOCAL ${namespace}.${userIdVar} = '${userId}'`);
        await tx.$executeRawUnsafe(`SET LOCAL ${namespace}.${userRoleVar} = '${userRole}'`);
    }
}

/**
 * Reset RLS Session Variables
 */
async function resetRLSVariables(tx) {
    const namespace = RLS_CONFIG.namespace;
    const userIdVar = RLS_CONFIG.userId;
    const userRoleVar = RLS_CONFIG.userRole;

    try {
        if (dbProvider === 'mysql') {
            // MySQL: Set variables to NULL to reset
            await tx.$executeRawUnsafe(`SET @${namespace}_${userIdVar} = NULL`);
            await tx.$executeRawUnsafe(`SET @${namespace}_${userRoleVar} = NULL`);
        } else {
            // PostgreSQL: Use RESET command
            await tx.$executeRawUnsafe(`RESET ${namespace}.${userIdVar}`);
            await tx.$executeRawUnsafe(`RESET ${namespace}.${userRoleVar}`);
        }
    } catch (e) {
        // Ignore errors on reset
        console.error('Failed to reset RLS variables:', e);
    }
}

// =====================================================
// EXTENDED PRISMA WITH AUTOMATIC RLS
// =====================================================

/**
 * Extended Prisma Client with automatic RLS context
 * Automatically wraps all operations in RLS context from AsyncLocalStorage
 */
const prisma = basePrisma.$extends({
    query: {
        async $allOperations({ operation, args, query, model }) {
            const context = requestContext.getStore();

            // No context = no RLS (e.g., system operations)
            if (!context?.userId || !context?.userRole) {
                return query(args);
            }

            const { userId, userRole } = context;

            // For operations that are already transactions, just set the variables
            if (operation === '$transaction') {
                return basePrisma.$transaction(async (tx) => {
                    await setRLSVariables(tx, userId, userRole);
                    return query(args);
                });
            }

            // For regular operations, wrap in transaction with RLS
            return basePrisma.$transaction(async (tx) => {
                // Set session variables
                await setRLSVariables(tx, userId, userRole);

                // Execute the original query using the transaction client
                if (model) {
                    // Model query (e.g., user.findMany())
                    return tx[model][operation](args);
                } else {
                    // Raw query or special operation
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
 * Helper for batch operations in single transaction
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
 * Express Middleware: Set RLS context from authenticated user
 * Use this AFTER your authentication middleware
 */
function setRLSContext(req, res, next) {
    if (req.user) {
        // Set context for async operations
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
 * Get RLS Config (for SQL generation)
 */
function getRLSConfig() {
    return RLS_CONFIG;
}

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

async function disconnectAll() {
    await authPrisma.$disconnect();
    await basePrisma.$disconnect();
    // Close PostgreSQL pools if they exist
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
// EXPORTS
// =====================================================

/**
 * Initialize the DMMF (must be called before using QueryBuilder)
 * This loads the full Prisma DMMF from @prisma/internals
 * @returns {Promise<Object>} The loaded DMMF
 */
async function initializeDMMF() {
    return dmmf.loadDMMF();
}

module.exports = {
    // Main clients
    prisma,              // Use for regular operations with automatic RLS from context
    authPrisma,          // Use ONLY for auth operations (login, register, etc.)

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
    PrismaClient,
    Prisma,
    acl,

    // DMMF
    initializeDMMF,
    dmmf,

    // Database info
    dbProvider
};
