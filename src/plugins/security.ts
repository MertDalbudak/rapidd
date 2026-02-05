import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

const NODE_ENV = process.env.NODE_ENV;

/**
 * Security headers plugin.
 * Sets standard security headers on every response.
 */
const securityPlugin: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('onSend', async (_request, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('X-Frame-Options', 'DENY');
        reply.header('X-XSS-Protection', '1; mode=block');
        reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
        reply.header(
            'Content-Security-Policy',
            "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; " +
            "font-src 'self'"
        );

        if (NODE_ENV === 'production') {
            reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }
    });
};

export default fp(securityPlugin, { name: 'rapidd-security' });
