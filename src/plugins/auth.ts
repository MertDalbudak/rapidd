import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { Auth } from '../auth/Auth';
import { ErrorResponse } from '../core/errors';
import type { RapiddUser, AuthOptions } from '../types';

interface AuthPluginOptions {
    auth?: Auth;
    authOptions?: AuthOptions;
}

/**
 * Authentication plugin for Fastify.
 * Parses Authorization header (Basic / Bearer) and sets request.user.
 * Registers /auth/* routes when a user table is detected.
 * Gracefully disables auth when no user table exists in the schema.
 */
const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, options) => {
    const auth = options.auth || new Auth(options.authOptions);

    // Initialize auth (auto-detects user model, fields, JWT secrets)
    await auth.initialize();

    if (!auth.isEnabled()) {
        // Auth disabled — still decorate for type safety but skip routes
        fastify.decorate('auth', auth);
        fastify.decorate('requireAuth', function requireAuth(_request: FastifyRequest) {
            throw new ErrorResponse(401, 'authentication_not_available');
        });
        fastify.decorate('requireRole', function requireRole(..._roles: string[]) {
            return async function (_request: FastifyRequest) {
                throw new ErrorResponse(401, 'authentication_not_available');
            };
        });
        return;
    }

    // Parse auth on every request using configured strategies (checked in order)
    fastify.addHook('onRequest', async (request) => {
        let user: RapiddUser | null = null;

        for (const strategy of auth.options.strategies) {
            if (user) break;

            switch (strategy) {
                case 'bearer': {
                    const h = request.headers.authorization;
                    if (h?.startsWith('Bearer ')) {
                        user = await auth.handleBearerAuth(h.substring(7));
                    }
                    break;
                }
                case 'basic': {
                    const h = request.headers.authorization;
                    if (h?.startsWith('Basic ')) {
                        user = await auth.handleBasicAuth(h.substring(6));
                    }
                    break;
                }
                case 'cookie': {
                    const raw = request.cookies?.[auth.options.cookieName];
                    if (raw) {
                        const val = typeof raw === 'object' ? (raw as any).value : raw;
                        user = await auth.handleCookieAuth(val);
                    }
                    break;
                }
                case 'header': {
                    const val = request.headers[auth.options.customHeaderName.toLowerCase()] as string | undefined;
                    if (val) {
                        user = await auth.handleCustomHeaderAuth(val);
                    }
                    break;
                }
            }
        }

        if (user) {
            request.user = user;
        }
    });

    // Auth routes
    fastify.post('/auth/login', async (request, reply) => {
        const result = await auth.login(request.body as { user: string; password: string });

        if (auth.options.strategies.includes('cookie')) {
            reply.setCookie(auth.options.cookieName, result.accessToken, {
                path: '/',
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                signed: !!process.env.COOKIE_SECRET,
            });
        }

        return reply.send(result);
    });

    fastify.post('/auth/logout', async (request, reply) => {
        const result = await auth.logout(request.headers.authorization);

        if (auth.options.strategies.includes('cookie')) {
            reply.clearCookie(auth.options.cookieName, { path: '/' });
        }

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
export { Auth };

// Fastify type augmentation for auth decorators
declare module 'fastify' {
    interface FastifyInstance {
        auth: Auth;
        requireAuth(request: FastifyRequest): void;
        requireRole(...roles: string[]): (request: FastifyRequest) => Promise<void>;
    }
}
