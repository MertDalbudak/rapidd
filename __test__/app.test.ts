/**
 * Integration tests for the Fastify app factory.
 * Tests the app boots correctly, plugins register, decorators work,
 * and the route loader functions properly.
 */
import path from 'path';
import fs from 'fs';

// Mock prisma and heavy dependencies before importing app
jest.mock('../src/core/prisma', () => ({
    prisma: {},
    prismaTransaction: jest.fn(),
    requestContext: { run: jest.fn((store: any, fn: any) => fn()) },
    getAcl: () => ({ model: {} }),
    disconnectAll: jest.fn().mockResolvedValue(undefined),
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
}));

// Must mock LanguageDict before app imports it
jest.mock('../src/core/i18n', () => ({
    LanguageDict: {
        initialize: jest.fn(),
        get: jest.fn((key: string) => key),
        getAvailableLanguages: jest.fn(() => ['en-US']),
        hasLanguage: jest.fn(() => true),
        getDictionary: jest.fn(() => ({})),
    },
}));

// Mock auth to avoid Redis/JWT dependencies
jest.mock('../src/auth/Auth', () => {
    return {
        Auth: class MockAuth {
            handleBasicAuth() { return null; }
            handleBearerAuth() { return null; }
        }
    };
});

jest.mock('../src/auth/stores/index', () => ({
    createStore: jest.fn(() => ({
        create: jest.fn(),
        get: jest.fn(),
        delete: jest.fn(),
        refresh: jest.fn(),
        isHealthy: jest.fn().mockResolvedValue(true),
    })),
}));

import { buildApp } from '../src/app';

// Create temp routes directory for testing
const TEMP_ROUTES = path.join(__dirname, '__temp_routes__');

beforeAll(() => {
    // Create temp route files
    fs.mkdirSync(path.join(TEMP_ROUTES, 'api', 'v1'), { recursive: true });

    // Set env vars
    process.env.ROUTES_PATH = TEMP_ROUTES;
    process.env.STRINGS_PATH = path.join(__dirname, '__temp_strings_app__');
    process.env.NODE_ENV = 'test';

    // Create strings dir
    fs.mkdirSync(process.env.STRINGS_PATH, { recursive: true });
    fs.writeFileSync(
        path.join(process.env.STRINGS_PATH, 'en-US.json'),
        JSON.stringify({ hello: 'Hello' })
    );

    // Write a simple test route
    fs.writeFileSync(
        path.join(TEMP_ROUTES, 'api', 'v1', 'health.js'),
        `
        module.exports = async function (fastify) {
            fastify.get('/', async (request, reply) => {
                return { status: 'ok', timestamp: Date.now() };
            });
        };
        `
    );
});

afterAll(() => {
    fs.rmSync(TEMP_ROUTES, { recursive: true, force: true });
    if (process.env.STRINGS_PATH) {
        fs.rmSync(process.env.STRINGS_PATH, { recursive: true, force: true });
    }
});

describe('buildApp()', () => {
    it('should create a Fastify instance', async () => {
        const app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        expect(app).toBeDefined();
        expect(typeof app.listen).toBe('function');
        expect(typeof app.register).toBe('function');
        await app.close();
    });

    it('should register reply decorators (sendList, sendError, sendResponse)', async () => {
        const app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        expect(app.hasReplyDecorator('sendList')).toBe(true);
        expect(app.hasReplyDecorator('sendError')).toBe(true);
        expect(app.hasReplyDecorator('sendResponse')).toBe(true);
        await app.close();
    });

    it('should register request decorators (user, language, remoteAddress)', async () => {
        const app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        expect(app.hasRequestDecorator('user')).toBe(true);
        expect(app.hasRequestDecorator('language')).toBe(true);
        expect(app.hasRequestDecorator('remoteAddress')).toBe(true);
        await app.close();
    });

    it('should load routes from filesystem', async () => {
        const app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        await app.ready();

        const response = await app.inject({
            method: 'GET',
            url: '/api/v1/health',
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        expect(body.status).toBe('ok');
        expect(body.timestamp).toBeDefined();
        await app.close();
    });

    it('should return 404 for unknown routes', async () => {
        const app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        await app.ready();

        const response = await app.inject({
            method: 'GET',
            url: '/nonexistent',
        });

        expect(response.statusCode).toBe(404);
        const body = JSON.parse(response.payload);
        expect(body.message).toBe('Not found');
        await app.close();
    });
});

describe('sendList decorator', () => {
    it('should format list responses correctly', async () => {
        const app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });

        // Register a test route that uses sendList
        app.get('/test-list', async (_request, reply) => {
            return reply.sendList(
                [{ id: 1 }, { id: 2 }],
                { take: 25, skip: 0, total: 2 }
            );
        });

        await app.ready();

        const response = await app.inject({
            method: 'GET',
            url: '/test-list',
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        expect(body.data).toEqual([{ id: 1 }, { id: 2 }]);
        expect(body.meta).toBeDefined();
        expect(body.meta.total).toBe(2);
        expect(body.meta.count).toBe(2);
        expect(body.meta.limit).toBe(25);
        expect(body.meta.offset).toBe(0);
        await app.close();
    });
});

describe('sendError decorator', () => {
    it('should format error responses correctly', async () => {
        const app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });

        app.get('/test-error', async (_request, reply) => {
            return reply.sendError(403, 'forbidden_action');
        });

        await app.ready();

        const response = await app.inject({
            method: 'GET',
            url: '/test-error',
        });

        expect(response.statusCode).toBe(403);
        const body = JSON.parse(response.payload);
        expect(body.status_code).toBe(403);
        expect(body.message).toBeDefined();
        await app.close();
    });
});

describe('sendResponse decorator', () => {
    it('should format success responses correctly', async () => {
        const app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });

        app.get('/test-response', async (_request, reply) => {
            return reply.sendResponse(200, 'operation_successful');
        });

        await app.ready();

        const response = await app.inject({
            method: 'GET',
            url: '/test-response',
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        expect(body.status_code).toBe(200);
        await app.close();
    });
});

describe('Security headers', () => {
    it('should set security headers on responses', async () => {
        const app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });

        app.get('/test-headers', async () => {
            return { ok: true };
        });

        await app.ready();

        const response = await app.inject({
            method: 'GET',
            url: '/test-headers',
        });

        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
        expect(response.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
        await app.close();
    });
});

describe('Language resolution', () => {
    it('should resolve language from Accept-Language header', async () => {
        const app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });

        let resolvedLanguage = '';
        app.get('/test-lang', async (request) => {
            resolvedLanguage = request.language;
            return { language: request.language };
        });

        await app.ready();

        const response = await app.inject({
            method: 'GET',
            url: '/test-lang',
            headers: {
                'accept-language': 'de-DE,de;q=0.9,en-US;q=0.8',
            },
        });

        expect(response.statusCode).toBe(200);
        // The language should be resolved (exact value depends on available languages)
        expect(resolvedLanguage).toBeDefined();
        expect(typeof resolvedLanguage).toBe('string');
        await app.close();
    });
});

describe('Error handler', () => {
    it('should handle ErrorResponse objects properly', async () => {
        // Import ErrorResponse after mocks are set up
        const { ErrorResponse } = require('../src/core/errors');

        const app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });

        app.get('/test-throw', async () => {
            throw new ErrorResponse(422, 'validation_error', { field: 'email' });
        });

        await app.ready();

        const response = await app.inject({
            method: 'GET',
            url: '/test-throw',
        });

        expect(response.statusCode).toBe(422);
        const body = JSON.parse(response.payload);
        expect(body.status_code).toBe(422);
        await app.close();
    });

    it('should handle generic errors with 500', async () => {
        const app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });

        app.get('/test-generic-error', async () => {
            throw new Error('something broke');
        });

        await app.ready();

        const response = await app.inject({
            method: 'GET',
            url: '/test-generic-error',
        });

        expect(response.statusCode).toBe(500);
        await app.close();
    });
});
