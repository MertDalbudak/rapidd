import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { requestContext } from '../core/prisma';

/**
 * RLS (Row-Level Security) context plugin.
 * Wraps the request lifecycle in AsyncLocalStorage so that
 * Prisma's $allOperations extension can automatically inject RLS variables.
 *
 * MUST be registered AFTER the auth plugin so that request.user is available.
 *
 * Uses callback-style hook to preserve AsyncLocalStorage context
 * across the entire request lifecycle (preHandler → handler → onSend).
 */
const rlsPlugin: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', (request, _reply, done) => {
        if (request.user) {
            requestContext.run(
                { userId: request.user.id, userRole: request.user.role },
                () => done()
            );
        } else {
            done();
        }
    });
};

export default fp(rlsPlugin, { name: 'rapidd-rls' });
