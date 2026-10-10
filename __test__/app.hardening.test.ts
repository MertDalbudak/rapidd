/**
 * Enterprise hardening of buildApp: health/readiness, request ids, CORS in production,
 * error reporting, app plugins, TRUST_PROXY parsing.
 */
import path from 'path';
import fs from 'fs';

const mockQueryRaw = jest.fn().mockResolvedValue([{ ok: 1 }]);

jest.mock('../src/core/prisma', () => ({
    rlsActive: () => false,
    prisma: { $queryRawUnsafe: (...args: unknown[]) => mockQueryRaw(...args) },
    prismaTransaction: jest.fn(),
    requestContext: { run: jest.fn((_store: any, fn: any) => fn()) },
    getAcl: () => ({ model: {} }),
    disconnectAll: jest.fn().mockResolvedValue(undefined),
    rlsEnabled: false,
}));

jest.mock('../src/core/dmmf', () => ({
    loadDMMF: jest.fn().mockResolvedValue({}),
    getDMMFSync: jest.fn(() => ({ datamodel: { models: [] } })),
    getModel: jest.fn(),
    getFields: jest.fn(() => ({})),
    getScalarFields: jest.fn(() => ({})),
    getPrimaryKey: jest.fn(() => 'id'),
    getRelations: jest.fn(() => []),
    isListRelation: jest.fn(() => false),
    getRelationInfo: jest.fn(),
    buildRelationships: jest.fn(() => []),
    findUserModel: jest.fn(() => null),
    findIdentifierFields: jest.fn(() => ['email']),
    findPasswordField: jest.fn(() => 'password'),
}));

jest.mock('../src/core/i18n', () => ({
    LanguageDict: {
        initialize: jest.fn(),
        get: jest.fn((key: string) => key),
        getAvailableLanguages: jest.fn(() => ['en_US']),
        hasLanguage: jest.fn(() => true),
        getDictionary: jest.fn(() => ({})),
        defaultLanguage: 'en_US',
    },
}));

import fp from 'fastify-plugin';
import { buildApp, parseTrustProxy, markShuttingDown } from '../src/app';
import { ErrorResponse } from '../src/core/errors';
import { Logger } from '../src/utils/Logger';

// Per run: the IDE's watcher may run this file at the same time
const ROUTES = fs.mkdtempSync(path.join(__dirname, '__temp_routes_hardening_'));

beforeAll(() => {
    fs.mkdirSync(path.join(ROUTES, 'api'), { recursive: true });
    fs.writeFileSync(path.join(ROUTES, 'api', 'boom.js'), `
        module.exports = async function (fastify) {
            fastify.get('/', async () => { throw new Error('kaboom'); });
            fastify.get('/denied', async () => { throw new (require(${JSON.stringify(path.join(__dirname, '../src/core/errors'))}).ErrorResponse)(403, 'no_permission'); });
            fastify.get('/ip', async (request) => ({ ip: request.ip }));
        };
    `);
    process.env.ROUTES_PATH = ROUTES;
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
});

afterAll(() => {
    fs.rmSync(ROUTES, { recursive: true, force: true });
});

const savedEnv = { ...process.env };
beforeEach(() => {
    // Independent of the developer's .env: no user table → auth disabled
    delete process.env.DB_USER_TABLE;
    delete process.env.AUTH_PROVIDERS;
});
afterEach(() => {
    process.env = { ...savedEnv, ROUTES_PATH: ROUTES };
    mockQueryRaw.mockReset().mockResolvedValue([{ ok: 1 }]);
});

const build = (options: Record<string, unknown> = {}) =>
    buildApp({ routesPath: ROUTES, rateLimit: false, processHandlers: false, ...options });

describe('health endpoints', () => {
    it('GET /health answers liveness', async () => {
        const app = await build();
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: 'ok' });
        await app.close();
    });

    it('GET /health/ready checks the database', async () => {
        const app = await build();
        const ok = await app.inject({ method: 'GET', url: '/health/ready' });
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toEqual({ status: 'ok', checks: { database: 'ok', sessions: 'skipped' } });
        expect(mockQueryRaw).toHaveBeenCalledWith('SELECT 1');

        mockQueryRaw.mockRejectedValueOnce(new Error('connection refused'));
        const down = await app.inject({ method: 'GET', url: '/health/ready' });
        expect(down.statusCode).toBe(503);
        expect(down.json()).toEqual({ status: 'unavailable', checks: { database: 'fail', sessions: 'skipped' } });
        await app.close();
    });

    it('reports an unreachable session store as degraded without failing readiness', async () => {
        process.env.DB_USER_TABLE = 'users'; // auth enabled
        process.env.AUTH_SESSION_STORAGE = 'redis';
        process.env.REDIS_URL = 'redis://127.0.0.1:1'; // nothing listens there
        const app = await build();
        const res = await app.inject({ method: 'GET', url: '/health/ready' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: 'ok', checks: { database: 'ok', sessions: 'degraded' } });
        await app.close();
    });

    it('can be disabled', async () => {
        const app = await build({ health: false });
        expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(404);
        await app.close();
    });

    it("keeps an app's own /health route", async () => {
        const app = await build({
            plugins: [async (fastify: any) => { fastify.get('/health', async () => ({ custom: true })); }],
        });
        expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ custom: true });
        await app.close();
    });
});

describe('request ids', () => {
    it('assigns a UUID and returns it', async () => {
        const app = await build();
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
        await app.close();
    });

    it('reuses a safe incoming id and replaces an unsafe one', async () => {
        const app = await build();
        const kept = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'lb-1234.abc' } });
        expect(kept.headers['x-request-id']).toBe('lb-1234.abc');

        const replaced = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'bad id\nInjected: yes' } });
        expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
        await app.close();
    });
});

describe('CORS in production', () => {
    beforeEach(() => {
        process.env.NODE_ENV = 'production';
        process.env.ALLOWED_ORIGINS = 'app.example.com';
        process.env.TRUST_PROXY = 'false';
        process.env.JWT_SECRET = 'x'.repeat(40);
    });

    it('allows listed origins (and their subdomains) and exposes correlation headers', async () => {
        const app = await build();
        const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://eu.app.example.com' } });
        expect(res.headers['access-control-allow-origin']).toBe('https://eu.app.example.com');
        expect(res.headers['access-control-expose-headers']).toContain('X-Request-Id');
        await app.close();
    });

    it('blocks other origins', async () => {
        const app = await build();
        const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } });
        expect(res.statusCode).toBe(403);
        expect(res.json().key).toBe('cors_blocked');
        await app.close();
    });

    it("allows the API's own origin (pages it serves posting back)", async () => {
        const app = await build();
        const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://api.internal', host: 'api.internal' } });
        expect(res.statusCode).toBe(200);
        await app.close();
    });

    it('accepts extra allowed headers from CORS_ALLOWED_HEADERS', async () => {
        process.env.CORS_ALLOWED_HEADERS = 'X-Tenant-Id';
        const app = await build();
        const res = await app.inject({
            method: 'OPTIONS', url: '/health',
            headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-tenant-id' },
        });
        expect(res.headers['access-control-allow-headers']).toContain('X-Tenant-Id');
        await app.close();
    });
});

describe('error reporting', () => {
    it('reports unexpected errors with the request, not client errors', async () => {
        const errorReporter = jest.fn();
        const app = await build({ errorReporter });

        const res = await app.inject({ method: 'GET', url: '/api/boom' });
        expect(res.statusCode).toBe(500);
        expect(errorReporter).toHaveBeenCalledTimes(1);
        expect(errorReporter.mock.calls[0][0]).toBeInstanceOf(Error);
        expect(errorReporter.mock.calls[0][1].id).toBe(res.headers['x-request-id']);

        await app.inject({ method: 'GET', url: '/api/boom/denied' });
        expect(errorReporter).toHaveBeenCalledTimes(1);
        await app.close();
    });

    it('a throwing reporter never breaks the response', async () => {
        const app = await build({ errorReporter: () => { throw new Error('sentry down'); } });
        expect((await app.inject({ method: 'GET', url: '/api/boom' })).statusCode).toBe(500);
        await app.close();
    });

    it('ErrorResponse exposes statusCode for Fastify and error trackers', () => {
        const err = new ErrorResponse(404, 'record_not_found');
        expect(err.statusCode).toBe(404);
        expect(err.name).toBe('ErrorResponse');
    });
});

describe('app plugins', () => {
    it('registers plugins (with options) before routes', async () => {
        const app = await build({
            plugins: [
                // Decorations must use fastify-plugin to be visible outside the plugin
                fp(async (fastify: any) => { fastify.decorate('greeting', 'hi'); }),
                [async (fastify: any, opts: any) => { fastify.get('/hello', async () => ({ msg: `${fastify.greeting} ${opts.name}` })); }, { name: 'rapidd' }],
            ],
        });
        expect((await app.inject({ method: 'GET', url: '/hello' })).json()).toEqual({ msg: 'hi rapidd' });
        await app.close();
    });
});

describe('404', () => {
    it('carries the machine-readable key', async () => {
        const app = await build();
        const res = await app.inject({ method: 'GET', url: '/nope' });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ status_code: 404, key: 'record_not_found' });
        await app.close();
    });
});

describe('graceful close', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('lets in-flight requests finish before onClose hooks (DB pools) run', async () => {
        const events: string[] = [];
        const app = await build({
            plugins: [async (fastify: any) => {
                fastify.get('/slow', async () => { await sleep(300); events.push('handler done'); return { done: true }; });
            }],
        });
        app.addHook('onClose', async () => { events.push('onClose'); });
        await app.listen({ port: 0, host: '127.0.0.1' });
        const { port } = app.server.address() as { port: number };

        const inflight = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.json());
        await sleep(50);
        await app.close();

        expect(await inflight).toEqual({ done: true });
        expect(events).toEqual(['handler done', 'onClose']);
    });

    it('readiness reports shutting_down once draining starts', async () => {
        const app = await build();
        markShuttingDown(app);
        const res = await app.inject({ method: 'GET', url: '/health/ready' });
        expect(res.statusCode).toBe(503);
        expect(res.json().status).toBe('shutting_down');
        await app.close();
    });
});

describe('rate limiting runs before authentication', () => {
    it('throttled requests never reach the credential check', async () => {
        process.env.NODE_ENV = 'production';
        process.env.TRUST_PROXY = 'false';
        process.env.JWT_SECRET = 'x'.repeat(40);
        process.env.JWT_REFRESH_SECRET = 'y'.repeat(40);
        process.env.RATE_LIMIT_MAX_REQUESTS = '1';
        process.env.AUTH_STRATEGIES = 'basic';
        const authenticate = jest.fn(async () => null);
        const app = await build({
            rateLimit: true,
            auth: { providers: [{ name: 'dir', type: 'custom', authenticate }] },
        });
        const basic = { authorization: 'Basic ' + Buffer.from('alice:guess').toString('base64') };
        const codes: number[] = [];
        for (let i = 0; i < 3; i++) {
            codes.push((await app.inject({ method: 'GET', url: '/nope', headers: basic })).statusCode);
        }
        expect(codes).toEqual([404, 429, 429]);
        expect(authenticate).toHaveBeenCalledTimes(1);
        await app.close();
    });
});

describe('TRUST_PROXY', () => {
    const ipWith = async (trustProxy: string, forwardedFor: string, remoteAddress = '127.0.0.1') => {
        process.env.TRUST_PROXY = trustProxy;
        const app = await build();
        const res = await app.inject({ method: 'GET', url: '/api/boom/ip', remoteAddress, headers: { 'x-forwarded-for': forwardedFor } });
        await app.close();
        return res.json().ip;
    };

    it('a hop count trusts that many proxies at private or loopback addresses', async () => {
        expect(await ipWith('1', '198.51.100.7, 203.0.113.9')).toBe('203.0.113.9');
        expect(await ipWith('1', '198.51.100.7, 203.0.113.9', '10.1.2.3')).toBe('203.0.113.9');
        expect(await ipWith('2', '198.51.100.7, 10.0.0.2')).toBe('198.51.100.7');
        // The second hop is a public address — not a proxy
        expect(await ipWith('2', '198.51.100.7, 203.0.113.9')).toBe('203.0.113.9');
    });

    it('a client that reaches the server directly cannot set its IP (what Fastify 5.12 guards against)', async () => {
        expect(await ipWith('1', '1.2.3.4', '203.0.113.50')).toBe('203.0.113.50');
        // ...unless its address is listed as a proxy
        expect(await ipWith('1,203.0.113.0/24', '1.2.3.4', '203.0.113.50')).toBe('1.2.3.4');
        expect(await ipWith('1,203.0.113.0/24', '1.2.3.4')).toBe('127.0.0.1');
    });

    it('addresses trust those proxies only; false trusts none, true every one', async () => {
        expect(await ipWith('127.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
        expect(await ipWith('loopback', '203.0.113.9')).toBe('203.0.113.9');
        expect(await ipWith('10.0.0.0/8', '203.0.113.9')).toBe('127.0.0.1');
        expect(await ipWith('false', '203.0.113.9')).toBe('127.0.0.1');
        expect(await ipWith('true', '1.2.3.4', '203.0.113.50')).toBe('1.2.3.4');
    });

    it('behind Cloudflare without trusting it: said once, with the fix', async () => {
        const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
        try {
            process.env.TRUST_PROXY = '1';
            const app = await build();
            for (let i = 0; i < 3; i++) {
                const res = await app.inject({ method: 'GET', url: '/api/boom/ip', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9, 172.68.1.10', 'cf-ray': 'x' } });
                expect(res.json().ip).toBe('172.68.1.10');
            }
            await app.close();
            const said = warn.mock.calls.filter(([m]) => String(m).startsWith('Requests come through Cloudflare'));
            expect(said).toHaveLength(1);
            expect(said[0][0]).toContain('Set TRUST_PROXY=private,cloudflare');

            warn.mockClear();
            process.env.TRUST_PROXY = 'private,cloudflare';
            const trusted = await build();
            const res = await trusted.inject({ method: 'GET', url: '/api/boom/ip', headers: { 'x-forwarded-for': '203.0.113.9, 172.68.1.10', 'cf-ray': 'x' } });
            expect(res.json().ip).toBe('203.0.113.9');
            await trusted.close();
            expect(warn.mock.calls.some(([m]) => String(m).startsWith('Requests come through Cloudflare'))).toBe(false);
        } finally {
            warn.mockRestore();
        }
    });

    it('a value that is no address stops the start with what is wrong', async () => {
        process.env.TRUST_PROXY = '1,nonsense';
        await expect(build()).rejects.toThrow('TRUST_PROXY: invalid IP address: nonsense');
    });
});

describe('parseTrustProxy', () => {
    it.each([
        [undefined, true, true],
        [undefined, false, true],
        ['', true, true],
        ['true', false, true],
        ['false', true, false],
        ['2', true, { hops: 2, addresses: ['private'] }],
        ['1, 10.0.0.0/8', true, { hops: 1, addresses: ['10.0.0.0/8'] }],
        ['10.0.0.0/8, 127.0.0.1', true, ['10.0.0.0/8', '127.0.0.1']],
    ])('%p (production=%p) → %p', (value, production, expected) => {
        expect(parseTrustProxy(value as string | undefined, production as boolean)).toEqual(expected);
    });

    it('takes one hop count', () => {
        expect(() => parseTrustProxy('1,2', true)).toThrow('TRUST_PROXY: one hop count, not 2 (1, 2)');
    });
});
