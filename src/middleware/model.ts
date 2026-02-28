/**
 * Model Middleware — Register before/after hooks for CRUD operations.
 *
 * Import this file in main.ts (before start()) to activate middleware.
 * Hooks run for all models by default; pass a model name as the last
 * argument to scope a hook to a specific model.
 *
 * Usage:
 *   import './src/middleware/model';
 *
 * Available hooks:  'before' | 'after'
 * Available ops:    'create' | 'update' | 'upsert' | 'upsertMany'
 *                   | 'delete' | 'get' | 'getMany' | 'count'
 */

import { modelMiddleware } from '../core/middleware';

// ── Timestamps (all models) ─────────────────────────
// Automatically set createdAt on create

// modelMiddleware.use('before', 'create', async (ctx) => {
//     ctx.data = { ...ctx.data, createdAt: new Date(), createdBy: ctx.user?.id };
//     return ctx;
// });

// Automatically set updatedAt on update

// modelMiddleware.use('before', 'update', async (ctx) => {
//     ctx.data = { ...ctx.data, updatedAt: new Date(), updatedBy: ctx.user?.id };
//     return ctx;
// });

// ── Soft Delete (specific model) ────────────────────
// Convert delete to an update that sets deletedAt

// modelMiddleware.use('before', 'delete', async (ctx) => {
//     ctx.softDelete = true;
//     ctx.data = { deletedAt: new Date(), deletedBy: ctx.user?.id };
//     return ctx;
// }, 'posts');

// ── Transform Response ──────────────────────────────
// Add computed fields after fetching

// modelMiddleware.use('after', 'get', async (ctx) => {
//     const result = ctx.result as Record<string, unknown> | undefined;
//     if (result?.firstName && result?.lastName) {
//         result.fullName = `${result.firstName} ${result.lastName}`;
//     }
//     return ctx;
// }, 'users');

// ── Abort on Condition ──────────────────────────────
// Prevent creation if a condition is not met

// modelMiddleware.use('before', 'create', async (ctx) => {
//     if (!ctx.data?.email) {
//         ctx.abort = true; // stops the operation
//     }
//     return ctx;
// }, 'users');
