import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { requestContext, rlsEnabled } from '../core/prisma';
import rlsContextFn from '../config/rls';
import type { RLSVariables } from '../types';

/**
 * RLS (Row-Level Security) context plugin.
 * Calls the user-defined rlsContext() function from src/config/rls.ts
 * to build SQL session variables, then stores them in AsyncLocalStorage
 * so that Prisma's $allOperations extension can inject them per-query.
 *
 * MUST be registered AFTER the auth plugin so that request.user is available.
 * Skips entirely when RLS is disabled (auto: off for MySQL, on for PostgreSQL).
 *
 * Uses callback-style hook to preserve AsyncLocalStorage context
 * across the entire request lifecycle (preHandler → handler → onSend).
 */
const rlsPlugin: FastifyPluginAsync = async (fastify) => {
    if (!rlsEnabled) return;

    fastify.addHook('preHandler', (request, _reply, done) => {
        const result = rlsContextFn(request);

        if (result instanceof Promise) {
            result.then((variables) => {
                runWithContext(variables, done);
            }).catch(done);
        } else {
            runWithContext(result, done);
        }
    });
};

function runWithContext(variables: RLSVariables, done: () => void): void {
    // Filter out null/undefined values
    const filtered: RLSVariables = {};
    for (const [key, value] of Object.entries(variables)) {
        if (value !== null && value !== undefined) {
            filtered[key] = value;
        }
    }

    if (Object.keys(filtered).length > 0) {
        requestContext.run({ variables: filtered }, () => done());
    } else {
        done();
    }
}

export default fp(rlsPlugin, { name: 'rapidd-rls' });
