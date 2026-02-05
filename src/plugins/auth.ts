import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { Auth, defaultAuth } from '../auth/Auth';
import { ErrorResponse } from '../core/errors';
import type { RapiddUser, AuthOptions } from '../types';

interface AuthPluginOptions {
    auth?: Auth;
    authOptions?: AuthOptions;
}

/**
 * Authentication plugin for Fastify.
 * Parses Authorization header (Basic / Bearer) and sets request.user.
 * Also registers /auth/* routes for login, logout, refresh, me.
 */
const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, options) => {
    const auth = options.auth || (options.authOptions ? new Auth(options.authOptions) : defaultAuth);

    // Parse auth on every request
    fastify.addHook('onRequest', async (request) => {
        const authHeader = request.headers.authorization;

        if (authHeader) {
            let user: RapiddUser | null = null;

            if (authHeader.startsWith('Basic ')) {
                user = await auth.handleBasicAuth(authHeader.substring(6));
            } else if (authHeader.startsWith('Bearer ')) {
                user = await auth.handleBearerAuth(authHeader.substring(7));
            }

            if (user) {
                request.user = user;
            }
        }
    });

    // Auth routes
    fastify.post('/auth/login', async (request, reply) => {
        const result = await auth.login(request.body as { user: string; password: string });
        return reply.send(result);
    });

    fastify.post('/auth/logout', async (request, reply) => {
        const result = await auth.logout(request.headers.authorization);
        return reply.send(result);
    });

    fastify.post('/auth/refresh', async (request, reply) => {
        const result = await auth.refresh(request.body as { refreshToken: string });
        return reply.send(result);
    });

    fastify.get('/auth/me', async (request, reply) => {
        const result = await auth.me(request.user);
        return reply.send(result);
    });

    // Expose auth instance and helpers on fastify
    fastify.decorate('auth', auth);
    fastify.decorate('requireAuth', function requireAuth(request: FastifyRequest) {
        if (!request.user) {
            throw new ErrorResponse(401, 'authentication_required');
        }
    });
    fastify.decorate('requireRole', function requireRole(...roles: string[]) {
        const allowedRoles = roles.flat().map((r: string) => r.toLowerCase());

        return async function (request: FastifyRequest) {
            if (!request.user) {
                throw new ErrorResponse(401, 'authentication_required');
            }
            const userRole = (request.user.role as string)?.toLowerCase();
            if (!userRole || !allowedRoles.includes(userRole)) {
                throw new ErrorResponse(403, 'insufficient_permissions');
            }
        };
    });
};

export default fp(authPlugin, { name: 'rapidd-auth' });
export { Auth, defaultAuth };

// Fastify type augmentation for auth decorators
declare module 'fastify' {
    interface FastifyInstance {
        auth: Auth;
        requireAuth(request: FastifyRequest): void;
        requireRole(...roles: string[]): (request: FastifyRequest) => Promise<void>;
    }
}
