import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { Auth, setCurrentAuth, LoginResult } from '../auth/Auth';
import { ErrorResponse } from '../core/errors';
import { LanguageDict } from '../core/i18n';
import { safeRedirectTarget, appendQuery } from '../core/origins';
import { getAppConfig } from '../core/config';
import { anonymousUser } from '../core/user';
import { Logger } from '../utils/Logger';
import type { RapiddUser, AuthOptions, AuthStrategy, RouteAuthConfig } from '../types';

interface AuthPluginOptions {
    auth?: Auth;
    authOptions?: AuthOptions;
}

/** Binds a redirect login to the browser that started it (login-CSRF protection) */
const STATE_COOKIE = 'rapidd_auth_state';

/**
 * Authentication plugin for Fastify.
 * Authenticates every request with the configured strategies (bearer / basic / cookie /
 * header) and sets request.user. Registers the /auth/* routes: password login, logout,
 * refresh, me, the provider list, and redirect login (OAuth2 / OIDC) with ticket exchange.
 * Gracefully disables auth when there is neither a user table nor an external provider.
 */
const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, options) => {
    const auth = options.auth || new Auth(options.authOptions);

    // Initialize auth (auto-detects user model, fields, JWT secrets, provider discovery)
    await auth.initialize();

    fastify.decorateRequest('authSessionId', null);

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
        // Sign-in is off on purpose (AUTH_PROVIDERS=none): every request is the anonymous user,
        // so routes serve it and access rules decide what it may do. (Without a user table but
        // with sign-in configured, requests stay without a user — routes refuse them.)
        if (auth.isAnonymous?.()) {
            fastify.addHook('onRequest', async (request) => {
                request.user = anonymousUser();
            });
        }
        return;
    }

    setCurrentAuth(auth);
    fastify.addHook('onClose', async () => {
        await auth.close();
        setCurrentAuth(null);
    });

    // Load endpointAuthStrategy from config/app.json (prefix → strategy mapping)
    const endpointAuthStrategy: Record<string, AuthStrategy | AuthStrategy[] | null> =
        getAppConfig().endpointAuthStrategy || {};

    // Pre-sort prefixes by length (longest first) for correct matching
    const sortedPrefixes = Object.keys(endpointAuthStrategy)
        .sort((a, b) => b.length - a.length);

    // ── Cookies ─────────────────────────────────────
    // @fastify/cookie only decorates (un)signCookie when it was given a secret (COOKIE_SECRET);
    // probe it, since a misconfigured (e.g. empty) secret yields a signer that throws
    const signCookies = (() => {
        try {
            return typeof (fastify as unknown as { signCookie: (v: string) => string }).signCookie('probe') === 'string';
        } catch {
            return false;
        }
    })();
    const accessCookie = auth.options.cookieName;
    const refreshCookie = `${auth.options.cookieName}_refresh`;
    const cookieBase = {
        httpOnly: true,
        secure: auth.options.cookieSecure,
        sameSite: auth.options.cookieSameSite,
        ...(auth.options.cookieDomain ? { domain: auth.options.cookieDomain } : {}),
    };

    const readCookie = (request: FastifyRequest, name: string): string | undefined => {
        const raw = request.cookies?.[name];
        if (!raw) return undefined;
        if (!signCookies) return raw;
        const unsigned = request.unsignCookie(raw);
        return unsigned.valid ? unsigned.value! : undefined;
    };

    // Cookie-only mode: tokens live exclusively in signed httpOnly cookies
    const cookieOnly = auth.options.strategies.length === 1 && auth.options.strategies[0] === 'cookie';
    const usesCookie = auth.options.strategies.includes('cookie');

    const setAuthCookies = (reply: FastifyReply, tokens: { accessToken: string; refreshToken: string }) => {
        reply.setCookie(accessCookie, tokens.accessToken, { ...cookieBase, path: '/', signed: signCookies });
        // Only ever sent to the auth routes
        reply.setCookie(refreshCookie, tokens.refreshToken, { ...cookieBase, path: '/auth', signed: signCookies });
    };

    const clearAuthCookies = (reply: FastifyReply) => {
        // A cookie is only removed when path AND domain match the ones it was set with
        reply.clearCookie(accessCookie, { ...cookieBase, path: '/' });
        reply.clearCookie(refreshCookie, { ...cookieBase, path: '/auth' });
    };

    /** Login/refresh/exchange response body: tokens, unless they live in cookies only */
    const loginResponse = (reply: FastifyReply, result: LoginResult) => {
        if (usesCookie) setAuthCookies(reply, result);
        return cookieOnly ? { user: result.user } : result;
    };

    // ── Request authentication ──────────────────────
    // Strategies are checked in order. Priority: route config > endpointAuthStrategy prefix
    // match > global default.
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

        const cookieName = routeAuth?.cookieName || accessCookie;
        const customHeaderName = routeAuth?.customHeaderName || auth.options.customHeaderName;

        for (const strategy of strategies) {
            let result: { user: RapiddUser; sessionId: string | null } | null = null;

            switch (strategy) {
                case 'bearer': {
                    const h = request.headers.authorization;
                    if (h?.startsWith('Bearer ')) {
                        result = await auth.authenticateToken(h.substring(7));
                    }
                    break;
                }
                case 'basic': {
                    const h = request.headers.authorization;
                    if (h?.startsWith('Basic ')) {
                        const user = await auth.handleBasicAuth(h.substring(6));
                        result = user ? { user, sessionId: null } : null;
                    }
                    break;
                }
                case 'cookie': {
                    const value = readCookie(request, cookieName);
                    if (value) {
                        result = await auth.authenticateToken(value);
                    }
                    break;
                }
                case 'header': {
                    const value = request.headers[customHeaderName.toLowerCase()] as string | undefined;
                    if (value) {
                        result = await auth.authenticateToken(value);
                    }
                    break;
                }
            }

            if (result) {
                request.user = result.user;
                request.authSessionId = result.sessionId;
                break;
            }
        }
    });

    // ── Password login & session routes ─────────────

    fastify.post('/auth/login', async (request, reply) => {
        const result = await auth.login(request.body as { user: string; password: string; provider?: string });
        return reply.send(loginResponse(reply, result));
    });

    fastify.post('/auth/logout', async (request, reply) => {
        // Revoke whatever identifies the session: the authenticated access token (any
        // strategy), and/or a refresh token from the body or cookie (expired-access clients)
        if (request.authSessionId) {
            await auth.revokeSession(request.authSessionId);
        }
        const body = request.body as { refreshToken?: string } | undefined;
        const refreshToken = body?.refreshToken || readCookie(request, refreshCookie);
        if (refreshToken) {
            await auth.revokeRefreshToken(refreshToken);
        }

        if (usesCookie) {
            clearAuthCookies(reply);
        }

        return reply.send({ message: LanguageDict.get('logged_out', null, request.language || null) });
    });

    fastify.post('/auth/refresh', async (request, reply) => {
        const body = request.body as { refreshToken?: string } | undefined;
        const refreshToken = body?.refreshToken || readCookie(request, refreshCookie);
        const result = await auth.refresh({ refreshToken: refreshToken as string });

        if (usesCookie) {
            setAuthCookies(reply, result);
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

    fastify.get('/auth/providers', async (_request, reply) => {
        return reply.send({
            providers: auth.describeProviders().map((p) => ({
                ...p,
                ...(p.redirect ? { loginUrl: `/auth/${p.name}/login` } : {}),
            })),
        });
    });

    // ── Redirect login (OAuth2 / OpenID Connect) ────

    const loginRedirect = auth.config.loginRedirect || '/';
    const loginRedirectOrigin = (() => {
        try { return [new URL(loginRedirect).origin]; } catch { return []; }
    })();

    const requestOrigin = (request: FastifyRequest) => `${request.protocol}://${request.host}`;

    const callbackUrl = (request: FastifyRequest, providerName: string): string => {
        const configured = (auth.getProvider(providerName) as { redirectUri?: string } | undefined)?.redirectUri;
        if (configured) return configured;
        if (process.env.PUBLIC_URL) return `${process.env.PUBLIC_URL.replace(/\/$/, '')}/auth/${providerName}/callback`;
        // The Host header is client-controlled: with a lax IdP redirect-URI policy, an attacker
        // could steer authorization codes to their own host. Production must be explicit.
        if (process.env.NODE_ENV === 'production') {
            Logger.error('Auth: set PUBLIC_URL (or the provider\'s redirectUri) to enable redirect login in production');
            throw new ErrorResponse(500, 'auth_not_configured');
        }
        return `${requestOrigin(request)}/auth/${providerName}/callback`;
    };

    fastify.get('/auth/:provider/login', async (request, reply) => {
        const { provider } = request.params as { provider: string };
        const { redirect } = request.query as { redirect?: string };

        const returnTo = safeRedirectTarget(redirect, loginRedirect, {
            requestOrigin: requestOrigin(request),
            extra: loginRedirectOrigin,
        });
        const { url, state } = await auth.beginRedirectLogin(provider, {
            redirectUri: callbackUrl(request, provider),
            returnTo,
        });

        // SameSite=Lax: the cookie must survive the IdP's top-level redirect back to us
        reply.setCookie(STATE_COOKIE, state, {
            ...cookieBase,
            sameSite: 'lax',
            path: `/auth/${provider}/callback`,
            maxAge: 600,
            signed: signCookies,
        });
        return reply.redirect(url);
    });

    fastify.get('/auth/:provider/callback', async (request, reply) => {
        const { provider } = request.params as { provider: string };
        const query = request.query as Record<string, string | undefined>;
        reply.clearCookie(STATE_COOKIE, { ...cookieBase, sameSite: 'lax', path: `/auth/${provider}/callback` });

        try {
            const { result, returnTo } = await auth.completeRedirectLogin(provider, query, readCookie(request, STATE_COOKIE));
            if (usesCookie) setAuthCookies(reply, result);
            // Tokens never travel in a URL: SPAs redeem a single-use, 60s ticket at /auth/exchange
            const target = cookieOnly ? returnTo : appendQuery(returnTo, { auth_ticket: await auth.issueLoginTicket(result) });
            return reply.redirect(target);
        } catch (err) {
            const key = err instanceof ErrorResponse ? err.message : 'auth_login_failed';
            if (!(err instanceof ErrorResponse)) Logger.error(err as Error, { route: 'auth callback', provider });
            return reply.redirect(appendQuery(loginRedirect, { auth_error: key }));
        }
    });

    fastify.post('/auth/exchange', async (request, reply) => {
        const { ticket } = (request.body || {}) as { ticket?: string };
        const result = await auth.redeemLoginTicket(ticket as string);
        return reply.send(loginResponse(reply, result));
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
            const userRole = request.user.role?.toLowerCase();
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

    interface FastifyRequest {
        /** Id of the Rapidd session that authenticated this request (null for basic / external tokens) */
        authSessionId: string | null;
    }

    interface FastifyContextConfig {
        auth?: RouteAuthConfig;
    }
}
