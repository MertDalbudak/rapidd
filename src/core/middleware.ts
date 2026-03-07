import type { MiddlewareHook, MiddlewareOperation, MiddlewareContext, MiddlewareFn } from '../types';

const middlewareRegistry = new Map<string, MiddlewareFn[]>();
const combinedCache = new Map<string, MiddlewareFn[]>();

const OPERATIONS: MiddlewareOperation[] = ['create', 'update', 'upsert', 'upsertMany', 'delete', 'get', 'getMany', 'count'];
const HOOKS: MiddlewareHook[] = ['before', 'after'];

function getKey(hook: string, operation: string, model: string = '*'): string {
    return `${hook}:${operation}:${model}`;
}

/**
 * Register a middleware function
 */
function use(hook: MiddlewareHook, operation: MiddlewareOperation, fn: MiddlewareFn, model: string = '*'): void {
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
    middlewareRegistry.get(key)!.push(fn);
    combinedCache.clear();
}

/**
 * Remove a specific middleware function
 */
function remove(hook: MiddlewareHook, operation: MiddlewareOperation, fn: MiddlewareFn, model: string = '*'): boolean {
    const key = getKey(hook, operation, model);
    const middlewares = middlewareRegistry.get(key);
    if (!middlewares) return false;

    const index = middlewares.indexOf(fn);
    if (index > -1) {
        middlewares.splice(index, 1);
        combinedCache.clear();
        return true;
    }
    return false;
}

/**
 * Clear all middleware for a specific hook/operation/model combination
 */
function clear(hook?: MiddlewareHook, operation?: MiddlewareOperation, model?: string): void {
    if (!hook && !operation && !model) {
        middlewareRegistry.clear();
        combinedCache.clear();
        return;
    }
    const key = getKey(hook!, operation!, model);
    middlewareRegistry.delete(key);
    combinedCache.clear();
}

/**
 * Get all middleware functions for a specific hook/operation/model.
 * Returns both model-specific and global ('*') middleware.
 */
function getMiddleware(hook: MiddlewareHook, operation: MiddlewareOperation, model: string): MiddlewareFn[] {
    const cacheKey = `${hook}:${operation}:${model}`;
    const cached = combinedCache.get(cacheKey);
    if (cached) return cached;

    const globalMiddleware = middlewareRegistry.get(getKey(hook, operation, '*'));
    const modelSpecific = middlewareRegistry.get(getKey(hook, operation, model));

    let result: MiddlewareFn[];
    if (!globalMiddleware?.length && !modelSpecific?.length) {
        result = [];
    } else if (!globalMiddleware?.length) {
        result = modelSpecific!;
    } else if (!modelSpecific?.length) {
        result = globalMiddleware;
    } else {
        result = [...globalMiddleware, ...modelSpecific];
    }

    combinedCache.set(cacheKey, result);
    return result;
}

/**
 * Execute middleware chain for a given context
 */
async function execute(hook: MiddlewareHook, operation: MiddlewareOperation, context: MiddlewareContext): Promise<MiddlewareContext> {
    const middlewares = getMiddleware(hook, operation, context.model.name);

    let ctx: MiddlewareContext = { ...context };
    for (const fn of middlewares) {
        const result = await fn(ctx);
        if (result !== undefined) {
            ctx = result;
        }
        if (ctx.abort) break;
    }

    return ctx;
}

/**
 * Create a middleware context object
 */
function createContext(
    model: { name: string },
    operation: string,
    params: Record<string, unknown>,
    user: MiddlewareContext['user'] = null
): MiddlewareContext {
    return {
        model,
        operation,
        user,
        timestamp: new Date(),
        ...params,
        abort: false,
        skip: false,
        softDelete: false,
    } as MiddlewareContext;
}

export const modelMiddleware = {
    use,
    remove,
    clear,
    getMiddleware,
    execute,
    createContext,
    OPERATIONS,
    HOOKS,
};
