import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';

import { ErrorResponse } from './core/errors';
import { LanguageDict } from './core/i18n';
import { disconnectAll } from './core/prisma';
import { validateEnv } from './core/env';
import { env } from './utils';
import { Logger } from './utils/Logger';

// Plugins
import securityPlugin from './plugins/security';
import languagePlugin from './plugins/language';
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

const NODE_ENV = process.env.NODE_ENV;

// ─── Initialize LanguageDict ────────────────────────

LanguageDict.initialize(process.env.STRINGS_PATH, 'en_US');

// ─── App Factory ────────────────────────────────────

export async function buildApp(options: RapiddOptions = {}): Promise<FastifyInstance> {
    // Validate required environment variables
    validateEnv();

    const app = Fastify({
        logger: NODE_ENV !== 'test',
        trustProxy: process.env.TRUST_PROXY !== undefined
            ? process.env.TRUST_PROXY === 'true'
            : NODE_ENV === 'production',
        routerOptions: {
            caseSensitive: true,
        },
    });

    // ── Body Parsing ────────────────────────────────
    await app.register(fastifyFormbody);

    // ── Static Files ────────────────────────────────
    const staticPath = process.env.PUBLIC_STATIC!;
    if (fs.existsSync(staticPath)) {
        await app.register(fastifyStatic, {
            root: staticPath,
            prefix: '/static/',
        });
    }

    // ── Cookies ─────────────────────────────────────
    await app.register(fastifyCookie, {
        secret: process.env.COOKIE_SECRET,
        parseOptions: {
            path: '/',
            httpOnly: true,
            secure: NODE_ENV === 'production',
            sameSite: 'strict' as const,
            signed: true,
        },
    });

    // ── CORS ────────────────────────────────────────
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((e: string) => e.trim());

    const sharedCorsOptions = {
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', process.env.AUTH_CUSTOM_HEADER || 'X-Auth-Token'],
        credentials: true,
    };

    const corsOptions = NODE_ENV === 'production'
        ? {
            ...sharedCorsOptions,
            origin: (origin: string, cb: (err: Error | null, origin: boolean) => void) => {
                if (!origin || allowedOrigins.includes('*')) return cb(null, true);
                let originHost: string;
                try {
                    originHost = new URL(origin).hostname;
                } catch {
                    return cb(new ErrorResponse(403, 'cors_blocked', { origin }), false);
                }
                const allowed = allowedOrigins.some((e: string) => {
                    const trimmed = e.replace(/^https?:\/\//, '');
                    return originHost === trimmed || originHost.endsWith(`.${trimmed}`);
                });
                if (allowed) return cb(null, true);
                return cb(new ErrorResponse(403, 'cors_blocked', { origin }), false);
            },
        }
        : { ...sharedCorsOptions, origin: true };

    await app.register(fastifyCors, corsOptions as any);

    // ── Security Headers ────────────────────────────
    await app.register(securityPlugin);

    // ── Language Resolution ──────────────────────────
    await app.register(languagePlugin);

    // ── API Decorators & Error Handler ───────────────
    await app.register(responsePlugin);

    // ── Authentication ──────────────────────────────
    await app.register(authPlugin);

    // ── RLS Context ─────────────────────────────────
    await app.register(rlsPlugin);

    // ── Rate Limiting (optional) ────────────────────
    if (options.rateLimit !== false && process.env.RATE_LIMIT_ENABLED !== 'false') {
        const rateLimitPlugin = (await import('./plugins/rateLimit')).default;
        await app.register(rateLimitPlugin);
    }

    // ── Route Loading ───────────────────────────────
    const routesPath = options.routesPath || process.env.ROUTES_PATH!;
    if (fs.existsSync(routesPath)) {
        await loadRoutes(app, routesPath);
    }

    // ── Request Logging ─────────────────────────────
    app.addHook('onSend', async (request, _reply, payload) => {
        if (typeof payload === 'string') {
            (request as any)._responsePayload = payload;
        }
        return payload;
    });

    app.addHook('onResponse', async (request, reply) => {
        Logger.request({
            method: request.method,
            url: request.url,
            status: reply.statusCode,
            time: reply.elapsedTime,
            ip: request.ip,
            contentLength: request.headers['content-length'],
            userId: request.user?.id,
            userAgent: request.headers['user-agent'],
            requestHeaders: request.headers,
            requestBody: request.body,
            responseHeaders: reply.getHeaders(),
            responseBody: (request as any)._responsePayload,
        });
    });

    // ── 404 Handler ─────────────────────────────────
    app.setNotFoundHandler((request, reply) => {
        const language = request.language || 'en_US';
        reply.code(404).send({ status_code: 404, message: LanguageDict.get('record_not_found', null, language) });
    });

    // ── Graceful Shutdown ───────────────────────────
    app.addHook('onClose', async () => {
        await disconnectAll();
    });

    return app;
}

// ─── Route Loader ───────────────────────────────────

async function loadRoutes(app: FastifyInstance, routePath: string): Promise<void> {
    const basePath = process.env.ROUTES_PATH!;
    const relativePath = '/' + path.relative(basePath, routePath).replace(/\\/g, '/');

    const entries = fs.readdirSync(routePath, { withFileTypes: true })
        .sort((a, b) =>
            (a.name === 'index.js' || a.name === 'index.ts' ? -2 : a.isDirectory() ? 0 : -1) -
            (b.name === 'index.js' || b.name === 'index.ts' ? -2 : b.isDirectory() ? 0 : -1)
        );

    for (const entry of entries) {
        if (entry.isDirectory()) {
            await loadRoutes(app, path.join(routePath, entry.name));
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


// Handle uncaught errors
process.on('uncaughtException', (err) => {
    Logger.error(err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    Logger.error(reason as Error);
});

export default buildApp;
