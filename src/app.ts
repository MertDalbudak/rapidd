import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';

import { ErrorResponse } from './core/errors';
import { LanguageDict } from './core/language';
import { disconnectAll } from './core/prisma';

// Plugins
import securityPlugin from './plugins/security';
import languagePlugin from './plugins/language';
import apiPlugin from './plugins/api';
import authPlugin from './plugins/auth';
import rlsPlugin from './plugins/rls';

import type { RapiddOptions } from './types';

// ─── Path Setup ─────────────────────────────────────
// Use process.cwd() as the project root — works from both source (tsx) and compiled (dist/) contexts.

const ROOT = process.env.ROOT || process.cwd();
process.env.ROOT = ROOT;
process.env.ROUTES_PATH = process.env.ROUTES_PATH || path.join(ROOT, 'dist', 'routes');
process.env.STRINGS_PATH = process.env.STRINGS_PATH || path.join(ROOT, 'strings');
process.env.PUBLIC_PATH = process.env.PUBLIC_PATH || path.join(ROOT, 'public');
process.env.PUBLIC_STATIC = process.env.PUBLIC_STATIC || path.join(process.env.PUBLIC_PATH!, 'static');

const NODE_ENV = process.env.NODE_ENV;

// ─── Initialize LanguageDict ────────────────────────

LanguageDict.initialize(process.env.STRINGS_PATH, 'en-US');

// ─── App Factory ────────────────────────────────────

export async function buildApp(options: RapiddOptions = {}): Promise<FastifyInstance> {
    const app = Fastify({
        logger: NODE_ENV !== 'test',
        trustProxy: NODE_ENV === 'production',
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

    const corsOptions = NODE_ENV === 'production'
        ? {
            origin: (origin: string, cb: (err: Error | null, origin: boolean) => void) => {
                if (!origin || allowedOrigins.find((e: string) => origin.endsWith(e))) {
                    return cb(null, true);
                }
                return cb(new ErrorResponse(403, 'cors_blocked', { origin }), false);
            },
        }
        : { origin: '*' as const };

    await app.register(fastifyCors, corsOptions as any);

    // ── Security Headers ────────────────────────────
    await app.register(securityPlugin);

    // ── Language Resolution ──────────────────────────
    await app.register(languagePlugin);

    // ── API Decorators & Error Handler ───────────────
    await app.register(apiPlugin);

    // ── Authentication ──────────────────────────────
    await app.register(authPlugin);

    // ── RLS Context ─────────────────────────────────
    await app.register(rlsPlugin);

    // ── Rate Limiting (optional) ────────────────────
    if (options.rateLimit !== false && process.env.RATE_LIMIT_ENABLED !== 'false') {
        const rateLimiterPlugin = (await import('./plugins/rateLimiter')).default;
        await app.register(rateLimiterPlugin);
    }

    // ── Route Loading ───────────────────────────────
    const routesPath = options.routesPath || process.env.ROUTES_PATH!;
    if (fs.existsSync(routesPath)) {
        await loadRoutes(app, routesPath);
    }

    // ── 404 Handler ─────────────────────────────────
    app.setNotFoundHandler((_request, reply) => {
        reply.code(404).send({ status_code: 404, message: 'Not found' });
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
            (a.name === 'root.js' || a.name === 'root.ts' ? -2 : a.isDirectory() ? 0 : -1) -
            (b.name === 'root.js' || b.name === 'root.ts' ? -2 : b.isDirectory() ? 0 : -1)
        );

    for (const entry of entries) {
        if (entry.isDirectory()) {
            await loadRoutes(app, path.join(routePath, entry.name));
        } else {
            const ext = path.extname(entry.name);
            if ((ext === '.js' || ext === '.ts') && entry.name[0] !== '_' && !entry.name.endsWith('.d.ts')) {
                const isRoot = entry.name === 'root.js' || entry.name === 'root.ts';
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
                    console.error(`Failed to load route ${route}:`, (err as Error).message);
                }
            }
        }
    }
}

export default buildApp;
