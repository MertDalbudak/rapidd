import './setup/env'; // ENV_FILE / .env — before anything reads the environment
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';

import { ErrorResponse } from './core/errors';
import { LanguageDict } from './core/i18n';
import { disconnectAll, prisma, getAcl } from './core/prisma';
import { auditAcl } from './core/acl';
import { validateEnv } from './core/env';
import { parseAllowedOrigins, isOriginAllowed } from './core/origins';
import { parseTrustProxy, trustProxyOption, isCloudflare } from './core/trustProxy';
import { env } from './utils';
import { Logger } from './utils/Logger';

// Plugins
import securityPlugin from './plugins/security';
import languagePlugin from './plugins/language';
import requestPlugin from './plugins/request';
import responsePlugin from './plugins/response';
import authPlugin from './plugins/auth';
import rlsPlugin from './plugins/rls';

import type { RapiddOptions } from './types';

// ─── BigInt Serialization ────────────────────────────
// Prisma returns BigInt values that JSON.stringify cannot handle natively.
// This polyfill converts them to strings during serialization.
(BigInt.prototype as any).toJSON = function () {
    return this.toString();
};

// ─── Path Setup ─────────────────────────────────────
// Use process.cwd() as the project root — works from both source (tsx) and compiled (dist/) contexts.

const ROOT = process.env.ROOT || process.cwd();
process.env.ROOT = ROOT;
process.env.ROUTES_PATH = process.env.ROUTES_PATH || path.join(ROOT, env.isDevelopment() ? 'routes' : 'dist/routes');
process.env.STRINGS_PATH = process.env.STRINGS_PATH || path.join(ROOT, 'locales');
process.env.PUBLIC_PATH = process.env.PUBLIC_PATH || path.join(ROOT, 'public');
process.env.PUBLIC_STATIC = process.env.PUBLIC_STATIC || path.join(process.env.PUBLIC_PATH!, 'static');

const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || 'en_US';

// ─── Initialize LanguageDict ────────────────────────

LanguageDict.initialize(process.env.STRINGS_PATH, DEFAULT_LANGUAGE);

// ─── Helpers ────────────────────────────────────────

/** TRUST_PROXY: see core/trustProxy */
export { parseTrustProxy };

const REQUEST_ID_HEADER = (process.env.REQUEST_ID_HEADER || 'x-request-id').toLowerCase();
/** Incoming ids are reused for end-to-end correlation — but only when they are log-safe */
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const shuttingDown = new WeakSet<FastifyInstance>();

/** Make readiness fail while the server drains (called by startServer on SIGTERM/SIGINT) */
export function markShuttingDown(app: FastifyInstance): void {
    shuttingDown.add(app);
}

/** Resolve within `ms` or reject — health checks must never hang a probe */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), ms);
        promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
}

let processHandlersInstalled = false;

/**
 * Log (and report) crashes. Unhandled rejections are logged without exiting, as Rapidd
 * always did; uncaught exceptions leave the process in an unknown state, so it exits.
 */
export function installProcessHandlers(errorReporter?: RapiddOptions['errorReporter']): void {
    if (processHandlersInstalled) return;
    processHandlersInstalled = true;

    process.on('uncaughtException', (err) => {
        Logger.error(err);
        try { errorReporter?.(err); } catch { /* never mask the crash */ }
        process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
        Logger.error(reason as Error);
        try { errorReporter?.(reason); } catch { /* ignore */ }
    });
}

// ─── App Factory ────────────────────────────────────

export async function buildApp(options: RapiddOptions = {}): Promise<FastifyInstance> {
    // Validate required environment variables
    validateEnv();

    if (options.processHandlers !== false) {
        installProcessHandlers(options.errorReporter);
    }

    // Re-initialize translations when a custom dictionary path is provided
    if (options.stringsPath) {
        LanguageDict.initialize(options.stringsPath, DEFAULT_LANGUAGE);
    }

    const production = process.env.NODE_ENV === 'production';
    if (production && !process.env.TRUST_PROXY) {
        Logger.warn('TRUST_PROXY is not set — trusting X-Forwarded-For from any client (production default). Set it to your proxy\'s IP/CIDR or hop count, or clients can spoof their IP and dodge rate limits.');
    }

    const app = Fastify({
        // Rapidd has its own request/access logger (Logger.request) — Fastify's pino
        // would log every request a second time. Opt back in with FASTIFY_LOGGER=true.
        logger: process.env.FASTIFY_LOGGER === 'true',
        trustProxy: trustProxyOption(parseTrustProxy(process.env.TRUST_PROXY)),
        requestIdHeader: false,
        genReqId: (req) => {
            const incoming = req.headers[REQUEST_ID_HEADER];
            return typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
        },
        ...(process.env.BODY_LIMIT ? { bodyLimit: parseInt(process.env.BODY_LIMIT, 10) } : {}),
        // Graceful close: Fastify's default ('idle') ends up calling closeAllConnections(),
        // which destroys IN-FLIGHT requests too. With false, Node's server.close() closes idle
        // keep-alive sockets and waits for running requests; startServer() bounds the wait.
        forceCloseConnections: false,
        routerOptions: {
            caseSensitive: true,
        },
    });

    // Behind Cloudflare without trusting it every visitor is a Cloudflare server — said once
    let cloudflareUntrusted = false;
    app.addHook('onRequest', async (request) => {
        if (!cloudflareUntrusted && request.headers['cf-ray'] && isCloudflare(request.ip)) {
            cloudflareUntrusted = true;
            Logger.warn(`Requests come through Cloudflare, but TRUST_PROXY does not trust it: every visitor looks like a Cloudflare server (${request.ip}) — one rate limit for all visitors behind it. Set TRUST_PROXY=private,cloudflare.`);
        }
    });

    // ── Graceful close ──────────────────────────────
    // Requests still running when close() starts end their keep-alive socket with their
    // response — otherwise each lingers until keepAliveTimeout and close() hangs.
    let closing = false;
    app.addHook('preClose', async () => {
        closing = true;
    });
    app.addHook('onSend', async (request, reply, payload) => {
        if (closing && request.raw.httpVersionMajor < 2) reply.header('Connection', 'close');
        return payload;
    });

    // ── Request ID & log context ────────────────────
    // Every log line written while handling a request carries its id (callback-style
    // hook so the AsyncLocalStorage context spans the whole request lifecycle).
    app.addHook('onRequest', (request, reply, done) => {
        reply.header('X-Request-Id', request.id);
        Logger.withContext({ requestId: request.id }, done);
    });

    // ── Body Parsing ────────────────────────────────
    await app.register(fastifyFormbody);

    // ── Static Files ────────────────────────────────
    const staticPath = options.publicPath
        ? path.join(options.publicPath, 'static')
        : process.env.PUBLIC_STATIC!;
    if (fs.existsSync(staticPath)) {
        await app.register(fastifyStatic, {
            root: staticPath,
            prefix: '/static/',
        });
    }

    // ── Cookies ─────────────────────────────────────
    // COOKIE_SAME_SITE: strict (default) | lax | none — invalid values fall back to strict.
    // Note: auth cookies have their own setting (AUTH_COOKIE_SAME_SITE).
    const cookieSameSite = (['strict', 'lax', 'none'].includes(process.env.COOKIE_SAME_SITE as string)
        ? process.env.COOKIE_SAME_SITE
        : 'strict') as 'strict' | 'lax' | 'none';
    const cookieSecure = production;
    if (cookieSameSite === 'none' && !cookieSecure) {
        Logger.warn('COOKIE_SAME_SITE=none requires Secure cookies — browsers will reject these cookies outside production');
    }

    await app.register(fastifyCookie, {
        // An empty COOKIE_SECRET must mean "no signing", not a broken signer
        secret: process.env.COOKIE_SECRET || undefined,
        parseOptions: {
            path: '/',
            httpOnly: true,
            secure: cookieSecure,
            sameSite: cookieSameSite,
            // Signing needs a secret — defaulting to signed without one makes every setCookie throw
            signed: !!process.env.COOKIE_SECRET,
        },
    });

    // ── CORS ────────────────────────────────────────
    const allowedOrigins = parseAllowedOrigins();
    const extraHeaders = (process.env.CORS_ALLOWED_HEADERS || '').split(',').map((h) => h.trim()).filter(Boolean);

    const corsBase = {
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', process.env.AUTH_CUSTOM_HEADER || 'X-Auth-Token', 'X-Request-Id', ...extraHeaders],
        // Let browser clients read correlation and rate-limit information
        exposedHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After'],
        credentials: true,
    };

    if (production) {
        await app.register(fastifyCors, {
            delegator: (request: FastifyRequest, callback: (err: Error | null, options?: Record<string, unknown>) => void) => {
                // An identity provider's answer (SAML POST) comes from its own origin — the route
                // checks it by signature and binds it to the browser, and needs no CORS headers
                if (request.routeOptions?.config?.anyOrigin) return callback(null, { origin: false });
                const origin = request.headers.origin;
                // A page served by this API (e.g. a login form) posting to itself is same-origin
                const allowed = !origin
                    || isOriginAllowed(origin, allowedOrigins)
                    || origin === `${request.protocol}://${request.host}`;
                if (!allowed) {
                    return callback(new ErrorResponse(403, 'cors_blocked', { origin }));
                }
                // options.cors overrides individual CORS settings (merged over env-derived defaults)
                callback(null, { ...corsBase, origin: origin || false, ...(options.cors || {}) });
            },
        } as any);
    } else {
        await app.register(fastifyCors, { ...corsBase, origin: true, ...(options.cors || {}) } as any);
    }

    // ── Security Headers ────────────────────────────
    await app.register(securityPlugin);

    // ── Language Resolution ──────────────────────────
    await app.register(languagePlugin);

    // ── Request Utilities ─────────────────────────────
    await app.register(requestPlugin);

    // ── API Decorators & Error Handler ───────────────
    await app.register(responsePlugin, { errorReporter: options.errorReporter });

    // ── Rate Limiting (optional) ────────────────────
    // Before authentication: a throttled request must not still cost a bcrypt compare,
    // an LDAP bind or a token introspection
    if (options.rateLimit !== false && process.env.RATE_LIMIT_ENABLED !== 'false') {
        const rateLimitPlugin = (await import('./plugins/rateLimit')).default;
        await app.register(rateLimitPlugin);
    }

    // ── Authentication ──────────────────────────────
    await app.register(authPlugin, { authOptions: options.auth });

    // ── RLS Context ─────────────────────────────────
    await app.register(rlsPlugin);

    // ── App Plugins ─────────────────────────────────
    // Registered after the core plugins (auth, RLS, rate limiting are in place) and
    // before the route loader — e.g. error tracking, OpenAPI, custom decorators.
    for (const entry of options.plugins || []) {
        const [plugin, pluginOptions] = Array.isArray(entry) ? entry : [entry, undefined];
        await app.register(plugin as any, pluginOptions as any);
    }

    // ── Route Loading ───────────────────────────────
    const routesPath = options.routesPath || process.env.ROUTES_PATH!;
    if (fs.existsSync(routesPath)) {
        await loadRoutes(app, routesPath);
    }

    // Surface models without an ACL entry in the boot log
    auditAcl(getAcl());

    // ── Health Checks ───────────────────────────────
    // Registered after the app's routes so an app that defines its own keeps it.
    if (options.health !== false && process.env.HEALTH_ENABLED !== 'false') {
        registerHealthRoutes(app);
    }

    // Flush buffered log writes on graceful shutdown
    app.addHook('onClose', async () => {
        await Logger.flush();
    });

    // ── Request Logging ─────────────────────────────
    // Response payloads are only printed at LOG_LEVEL=finest — don't retain them otherwise
    if (Logger.level === 'finest') {
        app.addHook('onSend', async (request, _reply, payload) => {
            if (typeof payload === 'string') {
                (request as any)._responsePayload = payload;
            }
            return payload;
        });
    }

    app.addHook('onResponse', async (request, reply) => {
        // Routes can opt out of access logging (health probes would flood the log)
        if ((request.routeOptions?.config as { accessLog?: boolean } | undefined)?.accessLog === false) return;
        Logger.request({
            method: request.method,
            url: request.url,
            status: reply.statusCode,
            time: reply.elapsedTime,
            ip: request.ip,
            contentLength: request.headers['content-length'],
            userId: request.user?.id,
            userAgent: request.headers['user-agent'],
            requestId: request.id,
            requestHeaders: request.headers,
            requestBody: request.body,
            responseHeaders: reply.getHeaders(),
            responseBody: (request as any)._responsePayload,
        });
    });

    // ── 404 Handler ─────────────────────────────────
    app.setNotFoundHandler((request, reply) => {
        reply.code(404).send({
            status_code: 404,
            message: LanguageDict.get('record_not_found', null, request.language || null),
            key: 'record_not_found',
        });
    });

    // ── Graceful Shutdown ───────────────────────────
    app.addHook('onClose', async () => {
        await disconnectAll();
    });

    return app;
}

// ─── Health Checks ──────────────────────────────────

/**
 * GET /health        — liveness: the process is up and serving
 * GET /health/ready  — readiness: database (and session store) reachable, not shutting down
 * Exempt from rate limiting and access logging; skipped when the app defines the routes itself.
 */
function registerHealthRoutes(app: FastifyInstance): void {
    const config = { rateLimit: false, accessLog: false, auth: { strategies: [] } };

    if (!app.hasRoute({ method: 'GET', url: '/health' })) {
        app.get('/health', { config }, async () => ({ status: 'ok' }));
    }

    if (!app.hasRoute({ method: 'GET', url: '/health/ready' })) {
        app.get('/health/ready', { config }, async (_request, reply) => {
            const checks: Record<string, 'ok' | 'fail' | 'degraded' | 'skipped'> = {};

            // `onFailure`: what an unhealthy dependency means for readiness. The session store
            // falls back to memory, so Redis being down is 'degraded' — failing readiness would
            // pull every instance out of the load balancer at once and turn a degradation into
            // an outage. The database has no fallback.
            const run = async (name: string, check: () => Promise<boolean>, onFailure: 'fail' | 'degraded') => {
                try {
                    checks[name] = await withTimeout(check(), 3000) ? 'ok' : onFailure;
                } catch (err) {
                    checks[name] = onFailure;
                    Logger.warn(`Readiness check "${name}" failed`, { error: (err as Error).message });
                }
            };

            await Promise.all([
                run('database', async () => {
                    await (prisma as any).$queryRawUnsafe('SELECT 1');
                    return true;
                }, 'fail'),
                app.auth?.isEnabled?.()
                    ? run('sessions', () => app.auth.getSessionStore().isHealthy(), 'degraded')
                    : Promise.resolve(void (checks.sessions = 'skipped')),
            ]);

            const draining = shuttingDown.has(app);
            const ready = !draining && Object.values(checks).every((c) => c !== 'fail');
            return reply.code(ready ? 200 : 503).send({
                status: ready ? 'ok' : (draining ? 'shutting_down' : 'unavailable'),
                checks,
            });
        });
    }
}

// ─── Route Loader ───────────────────────────────────

/** Register the route files under `routePath` — URL prefixes follow their path below `basePath` */
async function loadRoutes(app: FastifyInstance, routePath: string, basePath: string = routePath): Promise<void> {
    const relativePath = '/' + path.relative(basePath, routePath).replace(/\\/g, '/');

    const entries = fs.readdirSync(routePath, { withFileTypes: true })
        .sort((a, b) =>
            (a.name === 'index.js' || a.name === 'index.ts' ? -2 : a.isDirectory() ? 0 : -1) -
            (b.name === 'index.js' || b.name === 'index.ts' ? -2 : b.isDirectory() ? 0 : -1)
        );

    for (const entry of entries) {
        if (entry.isDirectory()) {
            await loadRoutes(app, path.join(routePath, entry.name), basePath);
        } else {
            const ext = path.extname(entry.name);
            if ((ext === '.js' || ext === '.ts') && entry.name[0] !== '_' && !entry.name.endsWith('.d.ts')) {
                const isRoot = entry.name === 'index.js' || entry.name === 'index.ts';
                const route = isRoot
                    ? relativePath
                    : `${relativePath.length > 1 ? relativePath : ''}/${path.parse(entry.name).name}`;

                const modulePath = path.join(routePath, entry.name);

                try {
                    const routeModule = require(modulePath);
                    const plugin = routeModule.default || routeModule;

                    if (typeof plugin === 'function') {
                        await app.register(plugin, { prefix: route });
                    }
                } catch (err) {
                    Logger.error(err as Error, { route });
                }
            }
        }
    }
}

export default buildApp;
