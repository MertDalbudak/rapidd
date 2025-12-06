/**
 * Model Middleware Configuration
 * Register middleware functions to intercept Model operations before/after Prisma calls
 *
 * Available hooks: 'before', 'after'
 * Available operations: 'create', 'update', 'upsert', 'delete', 'get', 'getMany', 'count'
 *
 * Context object properties:
 * - model: string - The model name being operated on
 * - operation: string - The operation being performed
 * - user: Object - The current user (from Model options)
 * - timestamp: Date - When the operation started
 * - data: Object - Data for create/update operations (mutable)
 * - id: any - ID for get/update/delete operations
 * - query: Object - Query filter for getMany/count operations
 * - options: Object - Additional Prisma options
 * - result: any - The result (only in 'after' hooks)
 * - abort: boolean - Set to true to abort the operation
 * - softDelete: boolean - Set to true to convert delete to soft delete
 */

const { Model } = require('../src/Model');

// =====================================================
// TIMESTAMP MIDDLEWARE
// =====================================================

/**
 * Auto-add createdAt/createdBy on create
 */
Model.middleware.use('before', 'create', async (ctx) => {
    ctx.data.createdAt = ctx.data.createdAt || new Date();
    ctx.data.createdBy = ctx.data.createdBy || ctx.user?.id;
    return ctx;
});

/**
 * Auto-add updatedAt/updatedBy on update
 */
Model.middleware.use('before', 'update', async (ctx) => {
    ctx.data.updatedAt = new Date();
    ctx.data.updatedBy = ctx.user?.id;
    return ctx;
});

// =====================================================
// SOFT DELETE MIDDLEWARE (EXAMPLE - DISABLED)
// =====================================================

/**
 * Convert hard delete to soft delete for specific models
 * Uncomment and customize for your needs
 */
// Model.middleware.use('before', 'delete', async (ctx) => {
//     ctx.softDelete = true;
//     ctx.data = {
//         deletedAt: new Date(),
//         deletedBy: ctx.user?.id,
//         isDeleted: true
//     };
//     return ctx;
// }, 'posts'); // Apply only to 'posts' model

// =====================================================
// LOGGING MIDDLEWARE (EXAMPLE - DISABLED)
// =====================================================

/**
 * Log all create operations
 * Uncomment for debugging
 */
// Model.middleware.use('after', 'create', async (ctx) => {
//     console.log(`[Model] Created ${ctx.model}:`, ctx.result?.id);
//     return ctx;
// });

/**
 * Log all update operations
 * Uncomment for debugging
 */
// Model.middleware.use('after', 'update', async (ctx) => {
//     console.log(`[Model] Updated ${ctx.model}:`, ctx.id);
//     return ctx;
// });

/**
 * Log all delete operations
 * Uncomment for debugging
 */
// Model.middleware.use('after', 'delete', async (ctx) => {
//     console.log(`[Model] Deleted ${ctx.model}:`, ctx.id, ctx.softDelete ? '(soft)' : '(hard)');
//     return ctx;
// });

// =====================================================
// VALIDATION MIDDLEWARE (EXAMPLE - DISABLED)
// =====================================================

/**
 * Validate email format before creating users
 * Uncomment and customize for your needs
 */
// Model.middleware.use('before', 'create', async (ctx) => {
//     if (ctx.data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ctx.data.email)) {
//         const { ErrorResponse } = require('../src/Api');
//         throw new ErrorResponse(400, 'invalid_email_format');
//     }
//     return ctx;
// }, 'users');

// =====================================================
// TRANSFORM MIDDLEWARE (EXAMPLE - DISABLED)
// =====================================================

/**
 * Add computed fields to response
 * Uncomment and customize for your needs
 */
// Model.middleware.use('after', 'get', async (ctx) => {
//     if (ctx.result?.firstName && ctx.result?.lastName) {
//         ctx.result.fullName = `${ctx.result.firstName} ${ctx.result.lastName}`;
//     }
//     return ctx;
// }, 'users');

// =====================================================
// CACHE MIDDLEWARE (EXAMPLE - DISABLED)
// =====================================================

/**
 * Simple in-memory cache example
 * Uncomment and customize for your needs
 */
// const cache = new Map();
// const CACHE_TTL = 60000; // 1 minute
//
// Model.middleware.use('before', 'get', async (ctx) => {
//     const cacheKey = `${ctx.model}:${ctx.id}`;
//     const cached = cache.get(cacheKey);
//     if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
//         ctx.abort = true;
//         ctx.result = cached.data;
//     }
//     return ctx;
// });
//
// Model.middleware.use('after', 'get', async (ctx) => {
//     const cacheKey = `${ctx.model}:${ctx.id}`;
//     cache.set(cacheKey, { data: ctx.result, timestamp: Date.now() });
//     return ctx;
// });
//
// // Invalidate cache on update/delete
// Model.middleware.use('after', 'update', async (ctx) => {
//     cache.delete(`${ctx.model}:${ctx.id}`);
//     return ctx;
// });
//
// Model.middleware.use('after', 'delete', async (ctx) => {
//     cache.delete(`${ctx.model}:${ctx.id}`);
//     return ctx;
// });

module.exports = {};
