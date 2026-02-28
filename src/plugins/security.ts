import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

const NODE_ENV = process.env.NODE_ENV;

/**
 * Security headers plugin for API-only servers.
 * Sets strict security headers optimized for JSON API responses.
 */
const securityPlugin: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('onSend', async (_request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
        reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

        if (NODE_ENV === 'production') {
            reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }
    });
};

export default fp(securityPlugin, { name: 'rapidd-security' });
