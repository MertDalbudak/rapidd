import path from 'path';
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { Auth } from '../auth/Auth';
import { ErrorResponse } from '../core/errors';
import { LanguageDict } from '../core/i18n';
import type { RapiddUser, AuthOptions, AuthStrategy, RouteAuthConfig } from '../types';

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

    // Load endpointAuthStrategy from config/app.json (prefix → strategy mapping)
    let endpointAuthStrategy: Record<string, AuthStrategy | AuthStrategy[] | null> = {};
    try {
        const appConfig = require(path.join(process.cwd(), 'config', 'app.json'));
        if (appConfig.endpointAuthStrategy) {
            endpointAuthStrategy = appConfig.endpointAuthStrategy;
        }
    } catch {
        // No app.json or no endpointAuthStrategy — use global default
    }

    // Pre-sort prefixes by length (longest first) for correct matching
    const sortedPrefixes = Object.keys(endpointAuthStrategy)
        .sort((a, b) => b.length - a.length);

    // Parse auth on every request using configured strategies (checked in order).
    // Priority: route config > endpointAuthStrategy prefix match > global default
    fastify.addHook('onRequest', async (request) => {
        const routeAuth = (request.routeOptions?.config as any)?.auth as RouteAuthConfig | undefined;

        let strategies: AuthStrategy[];
        if (routeAuth?.strategies) {
            strategies = routeAuth.strategies;
        } else {
            const matchedPrefix = sortedPrefixes.find(p => request.url.startsWith(p));
            if (matchedPrefix) {
                const value = endpointAuthStrategy[matchedPrefix];
                if (value === null) {
                    strategies = auth.options.strategies;
                } else if (typeof value === 'string') {
                    strategies = [value];
                } else {
                    strategies = value;
                }
            } else {
                strategies = auth.options.strategies;
            }
        }

        const cookieName = routeAuth?.cookieName || auth.options.cookieName;
        const customHeaderName = routeAuth?.customHeaderName || auth.options.customHeaderName;

        let user: RapiddUser | null = null;

        for (const strategy of strategies) {
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
                    const raw = request.cookies?.[cookieName];
                    if (raw) {
                        const unsigned = request.unsignCookie(raw);
                        const val = unsigned.valid ? unsigned.value! : raw;
                        user = await auth.handleCookieAuth(val);
                    }
                    break;
                }
                case 'header': {
                    const val = request.headers[customHeaderName.toLowerCase()] as string | undefined;
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

    // Cookie-only mode: tokens live exclusively in signed httpOnly cookies
    const cookieOnly = auth.options.strategies.length === 1 && auth.options.strategies[0] === 'cookie';
    const usesCookie = auth.options.strategies.includes('cookie');

    const setCookieToken = (reply: any, token: string) => {
        reply.setCookie(auth.options.cookieName, token, {
            path: '/',
            httpOnly: true,
            secure: auth.options.cookieSecure,
            sameSite: auth.options.cookieSameSite,
            signed: !!process.env.COOKIE_SECRET,
            ...(auth.options.cookieDomain && { domain: auth.options.cookieDomain }),
        });
    };

    // Auth routes
    fastify.post('/auth/login', async (request, reply) => {
        const result = await auth.login(request.body as { user: string; password: string });

        if (usesCookie) {
            setCookieToken(reply, result.accessToken);
        }

        if (cookieOnly) {
            return reply.send({ user: result.user });
        }

        return reply.send(result);
    });

    fastify.post('/auth/logout', async (request, reply) => {
        await auth.logout(request.headers.authorization);

        if (usesCookie) {
            reply.clearCookie(auth.options.cookieName, { path: '/' });
        }

        const language = request.language || 'en_US';
        return reply.send({ message: LanguageDict.get('logged_out', null, language) });
    });

    fastify.post('/auth/refresh', async (request, reply) => {
        const result = await auth.refresh(request.body as { refreshToken: string });

        if (usesCookie) {
            setCookieToken(reply, result.accessToken);
        }

        if (cookieOnly) {
            return reply.send({ message: 'refreshed' });
        }

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

    interface FastifyContextConfig {
        auth?: RouteAuthConfig;
    }
}
