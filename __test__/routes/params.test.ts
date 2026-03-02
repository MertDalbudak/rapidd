/**
 * Comprehensive route-level integration tests for ALL query parameters.
 * Tests: q (filter), include, limit, offset, sortBy, sortOrder
 * through the full route → model → QueryBuilder → Prisma pipeline.
 *
 * (fields parameter is covered separately in fields.test.ts)
 */

const mockPrismaModel = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
};

jest.mock('../../src/core/prisma', () => ({
    prisma: new Proxy({}, {
        get: (_target, prop) => {
            if (prop === '$transaction') return jest.fn((fn: any) => fn(new Proxy({}, {
                get: () => mockPrismaModel,
            })));
            return mockPrismaModel;
        },
    }),
    prismaTransaction: jest.fn(async (arg: any) => {
        if (typeof arg === 'function') {
            const tx = new Proxy({}, { get: () => mockPrismaModel });
            return arg(tx);
        }
        if (Array.isArray(arg)) {
            const tx = new Proxy({}, { get: () => mockPrismaModel });
            const results = [];
            for (const fn of arg) {
                results.push(await fn(tx));
            }
            return results;
        }
        return arg;
    }),
    requestContext: { run: jest.fn((_store: any, fn: any) => fn()) },
    getAcl: jest.fn(() => ({
        model: {
            products: {
                getAccessFilter: (user: any) => user?.role === 'admin' ? {} : { ownerId: user?.id },
                getOmitFields: (user: any) => user?.role === 'admin' ? [] : ['internal_cost'],
            },
            categories: {
                getAccessFilter: () => ({}),
                getOmitFields: () => [],
            },
            tags: {
                getAccessFilter: () => ({}),
                getOmitFields: () => [],
            },
        },
    })),
    disconnectAll: jest.fn().mockResolvedValue(undefined),
    rlsEnabled: false,
}));

jest.mock('../../src/core/dmmf', () => ({
    getFields: jest.fn((modelName: string) => {
        if (modelName === 'categories') {
            return {
                id: { name: 'id', kind: 'scalar', type: 'Int', isId: true, isList: false, isRequired: true, isUnique: true },
                name: { name: 'name', kind: 'scalar', type: 'String', isId: false, isList: false, isRequired: true, isUnique: false },
                slug: { name: 'slug', kind: 'scalar', type: 'String', isId: false, isList: false, isRequired: false, isUnique: true },
            };
        }
        if (modelName === 'tags') {
            return {
                id: { name: 'id', kind: 'scalar', type: 'Int', isId: true, isList: false, isRequired: true, isUnique: true },
                label: { name: 'label', kind: 'scalar', type: 'String', isId: false, isList: false, isRequired: true, isUnique: false },
            };
        }
        // default: products
        return {
            id: { name: 'id', kind: 'scalar', type: 'Int', isId: true, isList: false, isRequired: true, isUnique: true },
            name: { name: 'name', kind: 'scalar', type: 'String', isId: false, isList: false, isRequired: true, isUnique: false },
            description: { name: 'description', kind: 'scalar', type: 'String', isId: false, isList: false, isRequired: false, isUnique: false },
            price: { name: 'price', kind: 'scalar', type: 'Float', isId: false, isList: false, isRequired: true, isUnique: false },
            stock: { name: 'stock', kind: 'scalar', type: 'Int', isId: false, isList: false, isRequired: true, isUnique: false },
            ownerId: { name: 'ownerId', kind: 'scalar', type: 'Int', isId: false, isList: false, isRequired: true, isUnique: false },
            internal_cost: { name: 'internal_cost', kind: 'scalar', type: 'Float', isId: false, isList: false, isRequired: false, isUnique: false },
            isActive: { name: 'isActive', kind: 'scalar', type: 'Boolean', isId: false, isList: false, isRequired: false, isUnique: false },
            createdAt: { name: 'createdAt', kind: 'scalar', type: 'DateTime', isId: false, isList: false, isRequired: true, isUnique: false },
            deletedAt: { name: 'deletedAt', kind: 'scalar', type: 'DateTime', isId: false, isList: false, isRequired: false, isUnique: false },
        };
    }),
    getScalarFields: jest.fn((modelName: string) => {
        if (modelName === 'categories') {
            return {
                id: { name: 'id', kind: 'scalar', type: 'Int', isId: true },
                name: { name: 'name', kind: 'scalar', type: 'String', isId: false },
                slug: { name: 'slug', kind: 'scalar', type: 'String', isId: false },
            };
        }
        if (modelName === 'tags') {
            return {
                id: { name: 'id', kind: 'scalar', type: 'Int', isId: true },
                label: { name: 'label', kind: 'scalar', type: 'String', isId: false },
            };
        }
        return {
            id: { name: 'id', kind: 'scalar', type: 'Int', isId: true },
            name: { name: 'name', kind: 'scalar', type: 'String', isId: false },
            description: { name: 'description', kind: 'scalar', type: 'String', isId: false },
            price: { name: 'price', kind: 'scalar', type: 'Float', isId: false },
            stock: { name: 'stock', kind: 'scalar', type: 'Int', isId: false },
            ownerId: { name: 'ownerId', kind: 'scalar', type: 'Int', isId: false },
            internal_cost: { name: 'internal_cost', kind: 'scalar', type: 'Float', isId: false },
            isActive: { name: 'isActive', kind: 'scalar', type: 'Boolean', isId: false },
            createdAt: { name: 'createdAt', kind: 'scalar', type: 'DateTime', isId: false },
            deletedAt: { name: 'deletedAt', kind: 'scalar', type: 'DateTime', isId: false },
        };
    }),
    getPrimaryKey: jest.fn((modelName: string) => {
        return 'id';
    }),
    getRelations: jest.fn((modelName: string) => {
        if (modelName === 'categories') return [];
        if (modelName === 'tags') return [];
        return [];
    }),
    getModel: jest.fn((modelName: string) => {
        if (modelName === 'categories') {
            return {
                name: 'categories',
                fields: [
                    { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
                    { name: 'name', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'slug', kind: 'scalar', type: 'String', isList: false, isRequired: false, isId: false, isUnique: true },
                ],
            };
        }
        if (modelName === 'tags') {
            return {
                name: 'tags',
                fields: [
                    { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
                    { name: 'label', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
                ],
            };
        }
        return {
            name: 'products',
            fields: [
                { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
                { name: 'name', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
                { name: 'description', kind: 'scalar', type: 'String', isList: false, isRequired: false, isId: false, isUnique: false },
                { name: 'price', kind: 'scalar', type: 'Float', isList: false, isRequired: true, isId: false, isUnique: false },
                { name: 'stock', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false, isUnique: false },
                { name: 'ownerId', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false, isUnique: false },
                { name: 'internal_cost', kind: 'scalar', type: 'Float', isList: false, isRequired: false, isId: false, isUnique: false },
                { name: 'isActive', kind: 'scalar', type: 'Boolean', isList: false, isRequired: false, isId: false, isUnique: false },
                { name: 'createdAt', kind: 'scalar', type: 'DateTime', isList: false, isRequired: true, isId: false, isUnique: false },
                { name: 'deletedAt', kind: 'scalar', type: 'DateTime', isList: false, isRequired: false, isId: false, isUnique: false },
                { name: 'category', kind: 'object', type: 'categories', isList: false, isRequired: false, isId: false, isUnique: false, relationFromFields: ['categoryId'], relationToFields: ['id'], relationName: 'ProductToCategory' },
                { name: 'tags', kind: 'object', type: 'tags', isList: true, isRequired: false, isId: false, isUnique: false, relationFromFields: [], relationToFields: [], relationName: 'ProductToTags' },
            ],
        };
    }),
    isListRelation: jest.fn((_parent: string, rel: string) => rel === 'tags'),
    getRelationInfo: jest.fn(() => null),
    buildRelationships: jest.fn(() => [
        { name: 'category', object: 'categories', isList: false, field: 'categoryId', foreignKey: 'id' },
        { name: 'tags', object: 'tags', isList: true, field: 'productId', foreignKey: 'id' },
    ]),
    loadDMMF: jest.fn().mockResolvedValue({}),
    getDMMFSync: jest.fn(() => ({ datamodel: { models: [] } })),
    findUserModel: jest.fn(() => null),
    findIdentifierFields: jest.fn(() => ['email']),
    findPasswordField: jest.fn(() => 'password'),
}));

jest.mock('../../src/core/i18n', () => ({
    LanguageDict: {
        initialize: jest.fn(),
        get: jest.fn((key: string) => key),
        getAvailableLanguages: jest.fn(() => ['en_US']),
        hasLanguage: jest.fn(() => true),
        getDictionary: jest.fn(() => ({})),
    },
}));

jest.mock('../../src/auth/Auth', () => ({
    Auth: class MockAuth {
        options = { methods: ['bearer'], cookieName: 'token', customHeaderName: 'X-Auth-Token' };
        initialize() { return Promise.resolve(); }
        isEnabled() { return false; }
        handleBasicAuth() { return null; }
        handleBearerAuth() { return null; }
        handleCookieAuth() { return null; }
        handleCustomHeaderAuth() { return null; }
    }
}));

jest.mock('../../src/auth/stores/index', () => ({
    createStore: jest.fn(() => ({
        create: jest.fn(),
        get: jest.fn(),
        delete: jest.fn(),
        refresh: jest.fn(),
        isHealthy: jest.fn().mockResolvedValue(true),
    })),
}));

import path from 'path';
import fs from 'fs';
import { buildApp } from '../../src/app';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Model } from '../../src/orm/Model';
import { QueryBuilder } from '../../src/orm/QueryBuilder';

const adminUser = { id: 1, role: 'admin' };
const normalUser = { id: 42, role: 'user' };

function registerProductRoutes(app: FastifyInstance, user: any) {
    app.addHook('preHandler', async (request) => {
        (request as any).user = user;
    });

    app.get('/api/v1/products', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { q = {}, include = '', limit = '25', offset = '0', sortBy = 'id', sortOrder = 'asc', fields = null } = request.query as Record<string, string>;
            const model = new Model('products', { user: (request as any).user });
            const results = await model.getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder as 'asc' | 'desc', fields);
            return reply.sendList(results.data, results.meta);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });

    app.get('/api/v1/products/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { id: rawId } = request.params as { id: string };
            const { include = '', fields = null } = request.query as Record<string, string>;
            const model = new Model('products', { user: (request as any).user });
            const response = await model.get(Number(rawId), include, {}, fields);
            return reply.send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });
}

const TEMP_ROUTES = path.join(__dirname, '__temp_params_empty__');
const TEMP_STRINGS = path.join(__dirname, '__temp_params_strings__');

beforeAll(() => {
    fs.mkdirSync(TEMP_ROUTES, { recursive: true });
    fs.mkdirSync(TEMP_STRINGS, { recursive: true });
    fs.writeFileSync(path.join(TEMP_STRINGS, 'en_US.json'), JSON.stringify({}));
    process.env.ROUTES_PATH = TEMP_ROUTES;
    process.env.STRINGS_PATH = TEMP_STRINGS;
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
});

afterAll(() => {
    fs.rmSync(TEMP_ROUTES, { recursive: true, force: true });
    fs.rmSync(TEMP_STRINGS, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────
// LIMIT PARAMETER
// ─────────────────────────────────────────────────────────

describe('limit parameter', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerProductRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    it('should default to 25 when not provided', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.take).toBe(25);
    });

    it('should use the provided limit value', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?limit=10' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.take).toBe(10);
    });

    it('should accept limit=1 (minimum)', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?limit=1' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.take).toBe(1);
    });

    it('should cap limit at API_RESULT_LIMIT (500)', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?limit=1000' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.take).toBe(500);
    });

    it('should cap limit=500 exactly at the limit', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?limit=500' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.take).toBe(500);
    });

    it('should return 400 for limit=0', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/products?limit=0' });
        expect(response.statusCode).toBe(400);
    });

    it('should return 400 for negative limit', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/products?limit=-5' });
        expect(response.statusCode).toBe(400);
    });

    it('should return 400 for non-integer limit', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/products?limit=2.5' });
        expect(response.statusCode).toBe(400);
    });

    it('should return 400 for non-numeric limit', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/products?limit=abc' });
        expect(response.statusCode).toBe(400);
    });

    it('should reflect limit in response meta', async () => {
        mockPrismaModel.findMany.mockResolvedValue([{ id: 1 }]);
        mockPrismaModel.count.mockResolvedValue(100);

        const response = await app.inject({ method: 'GET', url: '/api/v1/products?limit=15' });
        const body = JSON.parse(response.payload);
        expect(body.meta.limit).toBe(15);
    });
});

// ─────────────────────────────────────────────────────────
// OFFSET PARAMETER
// ─────────────────────────────────────────────────────────

describe('offset parameter', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerProductRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    it('should default to 0 when not provided', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.skip).toBe(0);
    });

    it('should use the provided offset value', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?offset=50' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.skip).toBe(50);
    });

    it('should accept offset=0 explicitly', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?offset=0' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.skip).toBe(0);
    });

    it('should accept large offset values', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?offset=10000' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.skip).toBe(10000);
    });

    it('should default to 0 for negative offset', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?offset=-10' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.skip).toBe(0);
    });

    it('should default to 0 for non-numeric offset', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?offset=abc' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.skip).toBe(0);
    });

    it('should reflect offset in response meta', async () => {
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(100);

        const response = await app.inject({ method: 'GET', url: '/api/v1/products?offset=30' });
        const body = JSON.parse(response.payload);
        expect(body.meta.offset).toBe(30);
    });

    it('should work with limit + offset together for pagination', async () => {
        mockPrismaModel.findMany.mockResolvedValue([{ id: 11 }]);
        mockPrismaModel.count.mockResolvedValue(50);

        const response = await app.inject({ method: 'GET', url: '/api/v1/products?limit=10&offset=10' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.take).toBe(10);
        expect(call.skip).toBe(10);

        const body = JSON.parse(response.payload);
        expect(body.meta.limit).toBe(10);
        expect(body.meta.offset).toBe(10);
        expect(body.meta.total).toBe(50);
    });
});

// ─────────────────────────────────────────────────────────
// SORTBY PARAMETER
// ─────────────────────────────────────────────────────────

describe('sortBy parameter', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerProductRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    it('should default to id when not provided', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.orderBy).toEqual({ id: 'asc' });
    });

    it('should sort by a scalar field', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?sortBy=name' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.orderBy).toEqual({ name: 'asc' });
    });

    it('should sort by price field', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?sortBy=price' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.orderBy).toEqual({ price: 'asc' });
    });

    it('should sort by createdAt field', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?sortBy=createdAt' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.orderBy).toEqual({ createdAt: 'asc' });
    });

    it('should sort by relation field (dot notation)', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?sortBy=category.name' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.orderBy).toEqual({ category: { name: 'asc' } });
    });

    it('should return 400 for non-existent sortBy field', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/products?sortBy=nonexistent' });
        expect(response.statusCode).toBe(400);
    });

    it('should handle sortBy with whitespace', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?sortBy=%20name%20' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.orderBy).toEqual({ name: 'asc' });
    });
});

// ─────────────────────────────────────────────────────────
// SORTORDER PARAMETER
// ─────────────────────────────────────────────────────────

describe('sortOrder parameter', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerProductRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    it('should default to asc when not provided', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.orderBy).toEqual({ id: 'asc' });
    });

    it('should sort ascending when sortOrder=asc', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?sortOrder=asc' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.orderBy).toEqual({ id: 'asc' });
    });

    it('should sort descending when sortOrder=desc', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?sortOrder=desc' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.orderBy).toEqual({ id: 'desc' });
    });

    it('should work with sortBy + sortOrder=desc', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?sortBy=price&sortOrder=desc' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.orderBy).toEqual({ price: 'desc' });
    });

    it('should return 400 for invalid sortOrder value', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/products?sortOrder=random' });
        expect(response.statusCode).toBe(400);
    });

    it('should return 400 for uppercase ASC', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/products?sortOrder=ASC' });
        expect(response.statusCode).toBe(400);
    });

    it('should return 400 for uppercase DESC', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/products?sortOrder=DESC' });
        expect(response.statusCode).toBe(400);
    });

    it('should return 400 for empty sortOrder', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/products?sortOrder=' });
        expect(response.statusCode).toBe(400);
    });
});

// ─────────────────────────────────────────────────────────
// INCLUDE PARAMETER
// ─────────────────────────────────────────────────────────

describe('include parameter', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerProductRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    describe('GET / (getMany)', () => {
        it('should not include relations when include is empty', async () => {
            await app.inject({ method: 'GET', url: '/api/v1/products' });

            const call = mockPrismaModel.findMany.mock.calls[0][0];
            // When no include is specified, no deeply nested relations should be present
            // The include key may be undefined or an empty object
            if (call.include) {
                const deepRelations = Object.values(call.include).filter((v: any) => typeof v === 'object' && v !== null && v !== true);
                expect(deepRelations.length).toBe(0);
            }
        });

        it('should include a single relation', async () => {
            await app.inject({ method: 'GET', url: '/api/v1/products?include=category' });

            const call = mockPrismaModel.findMany.mock.calls[0][0];
            expect(call.include).toBeDefined();
            expect(call.include.category).toBeDefined();
        });

        it('should include multiple relations', async () => {
            await app.inject({ method: 'GET', url: '/api/v1/products?include=category,tags' });

            const call = mockPrismaModel.findMany.mock.calls[0][0];
            expect(call.include.category).toBeDefined();
            expect(call.include.tags).toBeDefined();
        });

        it('should include ALL first-level relations when include=ALL', async () => {
            await app.inject({ method: 'GET', url: '/api/v1/products?include=ALL' });

            const call = mockPrismaModel.findMany.mock.calls[0][0];
            expect(call.include).toBeDefined();
            expect(call.include.category).toBeDefined();
            expect(call.include.tags).toBeDefined();
        });

        it('should silently ignore non-existent relation in include', async () => {
            const response = await app.inject({ method: 'GET', url: '/api/v1/products?include=nonexistent' });
            // Unknown relations are silently ignored (not found in relatedObjects)
            expect(response.statusCode).toBe(200);
        });

        it('should handle include with whitespace', async () => {
            await app.inject({ method: 'GET', url: '/api/v1/products?include=%20category%20' });

            const call = mockPrismaModel.findMany.mock.calls[0][0];
            expect(call.include.category).toBeDefined();
        });

        it('should handle empty include value (no relations loaded)', async () => {
            const response = await app.inject({ method: 'GET', url: '/api/v1/products?include=' });
            expect(response.statusCode).toBe(200);
        });
    });

    describe('GET /:id (get)', () => {
        it('should include a relation on single record', async () => {
            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, name: 'Product', category: { id: 1, name: 'Cat' } })
                .mockResolvedValueOnce({ id: 1 });

            const response = await app.inject({ method: 'GET', url: '/api/v1/products/1?include=category' });
            expect(response.statusCode).toBe(200);

            const dataCall = mockPrismaModel.findUnique.mock.calls[0][0];
            expect(dataCall.include.category).toBeDefined();
        });

        it('should include multiple relations on single record', async () => {
            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, category: {}, tags: [] })
                .mockResolvedValueOnce({ id: 1 });

            await app.inject({ method: 'GET', url: '/api/v1/products/1?include=category,tags' });

            const dataCall = mockPrismaModel.findUnique.mock.calls[0][0];
            expect(dataCall.include.category).toBeDefined();
            expect(dataCall.include.tags).toBeDefined();
        });

        it('should silently ignore non-existent relation on single record', async () => {
            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, name: 'Product' })
                .mockResolvedValueOnce({ id: 1 });

            const response = await app.inject({ method: 'GET', url: '/api/v1/products/1?include=nonexistent' });
            // Unknown relations are silently ignored
            expect(response.statusCode).toBe(200);
        });
    });
});

// ─────────────────────────────────────────────────────────
// Q (FILTER) PARAMETER — STRING FILTERS
// ─────────────────────────────────────────────────────────

describe('q (filter) parameter — String filters', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerProductRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    it('should filter by exact string match', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=name%3DWidget' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.name).toBeDefined();
    });

    it('should filter with contains wildcard (%value%)', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=name%3D%25Widget%25' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.name).toBeDefined();
        expect(call.where.name.contains).toBe('Widget');
    });

    it('should filter with startsWith wildcard (value%)', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=name%3DWidget%25' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.name.startsWith).toBe('Widget');
    });

    it('should filter with endsWith wildcard (%value)', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=name%3D%25Widget' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.name.endsWith).toBe('Widget');
    });

    it('should handle negated string filter (not:value)', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=name%3Dnot:Widget' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.name).toBeDefined();
        expect(call.where.name.not).toBeDefined();
    });

    it('should skip empty filter value', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=name%3D' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.name).toBeUndefined();
    });

    it('should return 400 for filter on non-existent field', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/products?q=nonexistent%3Dvalue' });
        expect(response.statusCode).toBe(400);
    });
});

// ─────────────────────────────────────────────────────────
// Q (FILTER) PARAMETER — NUMERIC FILTERS
// ─────────────────────────────────────────────────────────

describe('q (filter) parameter — Numeric filters', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerProductRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    it('should filter with gt: operator', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=price%3Dgt:100' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.price).toEqual({ gt: 100 });
    });

    it('should filter with gte: operator', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=price%3Dgte:50' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.price).toEqual({ gte: 50 });
    });

    it('should filter with lt: operator', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=price%3Dlt:200' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.price).toEqual({ lt: 200 });
    });

    it('should filter with lte: operator', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=price%3Dlte:99' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.price).toEqual({ lte: 99 });
    });

    it('should filter with eq: operator', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=stock%3Deq:10' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.stock).toEqual({ equals: 10 });
    });

    it('should filter with ne: operator', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=stock%3Dne:0' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.stock).toEqual({ not: 0 });
    });

    it('should filter with between: operator', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=price%3Dbetween:10;100' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.price).toEqual({ gte: 10, lte: 100 });
    });

    it('should filter with negated numeric (not:gt:)', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=price%3Dnot:gt:100' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.price).toBeDefined();
        expect(call.where.price.not).toBeDefined();
    });

    it('should filter with plain numeric value', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=stock%3D42' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.stock).toBeDefined();
    });
});

// ─────────────────────────────────────────────────────────
// Q (FILTER) PARAMETER — DATE FILTERS
// ─────────────────────────────────────────────────────────

describe('q (filter) parameter — Date filters', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerProductRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    it('should filter with after: date operator', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=createdAt%3Dafter:2024-01-01' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.createdAt).toBeDefined();
        expect(call.where.createdAt.gt).toBeDefined();
    });

    it('should filter with before: date operator', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=createdAt%3Dbefore:2024-12-31' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.createdAt.lt).toBeDefined();
    });

    it('should filter with from: date operator', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=createdAt%3Dfrom:2024-06-01' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.createdAt.gte).toBeDefined();
    });

    it('should filter with to: date operator', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=createdAt%3Dto:2024-06-30' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.createdAt.lte).toBeDefined();
    });

    it('should filter with on: date operator (full day match)', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=createdAt%3Don:2024-03-15' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.createdAt.gte).toBeDefined();
        expect(call.where.createdAt.lt).toBeDefined();
    });

    it('should filter with between: date operator', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=createdAt%3Dbetween:2024-01-01;2024-12-31' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.createdAt.gte).toBeDefined();
        expect(call.where.createdAt.lte).toBeDefined();
    });

    it('should handle ISO datetime format', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=createdAt%3Dafter:2024-01-01T12:00:00' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.createdAt.gt).toBeDefined();
    });
});

// ─────────────────────────────────────────────────────────
// Q (FILTER) PARAMETER — ARRAY FILTERS
// ─────────────────────────────────────────────────────────

describe('q (filter) parameter — Array filters', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerProductRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    it('should filter with array IN operator [1,2,3]', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=id%3D[1,2,3]' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.id.in).toBeDefined();
        expect(call.where.id.in).toEqual([1, 2, 3]);
    });

    it('should filter with negated array NOT IN', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=id%3Dnot:[1,2,3]' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.id.notIn).toBeDefined();
        expect(call.where.id.notIn).toEqual([1, 2, 3]);
    });
});

// ─────────────────────────────────────────────────────────
// Q (FILTER) PARAMETER — NULL FILTERS
// ─────────────────────────────────────────────────────────

describe('q (filter) parameter — Null filters', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerProductRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    it('should filter with #NULL on nullable field', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=deletedAt%3D%23NULL' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.deletedAt).toEqual({ equals: null });
    });

    it('should filter with not:#NULL on nullable field', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=deletedAt%3Dnot:%23NULL' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.deletedAt).toEqual({ not: { equals: null } });
    });

    it('should return 400 for #NULL on non-nullable field', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/products?q=name%3D%23NULL' });
        expect(response.statusCode).toBe(400);
    });

    it('should skip not:#NULL on non-nullable field (always true)', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=name%3Dnot:%23NULL' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        // not:#NULL on non-nullable field should be skipped (always true)
        expect(call.where.name).toBeUndefined();
    });

    it('should filter with #NULL on optional description field', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=description%3D%23NULL' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.description).toEqual({ equals: null });
    });
});

// ─────────────────────────────────────────────────────────
// Q (FILTER) PARAMETER — MULTIPLE FILTERS
// ─────────────────────────────────────────────────────────

describe('q (filter) parameter — Multiple filters', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerProductRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    it('should handle multiple filters joined by comma', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=name%3D%25Widget%25,price%3Dgt:50' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.name).toBeDefined();
        expect(call.where.price).toBeDefined();
    });

    it('should handle filter on relation path (dot notation)', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=category.name%3DElectronics' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.category).toBeDefined();
    });

    it('should return 200 for empty q value', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/products?q=' });
        expect(response.statusCode).toBe(200);
    });

    it('should return 200 when q is not provided', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/v1/products' });
        expect(response.statusCode).toBe(200);
    });
});

// ─────────────────────────────────────────────────────────
// COMBINED PARAMETERS
// ─────────────────────────────────────────────────────────

describe('Combined query parameters', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerProductRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    it('should handle all parameters together', async () => {
        mockPrismaModel.findMany.mockResolvedValue([{ id: 1, name: 'Widget' }]);
        mockPrismaModel.count.mockResolvedValue(50);

        const response = await app.inject({
            method: 'GET',
            url: '/api/v1/products?q=name%3D%25Widget%25&include=category&fields=id,name,category.name&limit=10&offset=5&sortBy=price&sortOrder=desc',
        });

        expect(response.statusCode).toBe(200);

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        // Filter
        expect(call.where.name).toBeDefined();
        // Select (from fields)
        expect(call.select).toBeDefined();
        expect(call.select.id).toBe(true);
        expect(call.select.name).toBe(true);
        expect(call.select.category).toBeDefined();
        // Pagination
        expect(call.take).toBe(10);
        expect(call.skip).toBe(5);
        // Sorting
        expect(call.orderBy).toEqual({ price: 'desc' });

        // Response meta
        const body = JSON.parse(response.payload);
        expect(body.meta.total).toBe(50);
        expect(body.meta.limit).toBe(10);
        expect(body.meta.offset).toBe(5);
    });

    it('should handle filter + include + sorting without fields', async () => {
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);

        await app.inject({
            method: 'GET',
            url: '/api/v1/products?q=price%3Dgt:10&include=tags&sortBy=name&sortOrder=asc',
        });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.price).toBeDefined();
        expect(call.include.tags).toBeDefined();
        expect(call.orderBy).toEqual({ name: 'asc' });
        expect(call).not.toHaveProperty('select');
    });

    it('should handle pagination + sorting only', async () => {
        await app.inject({
            method: 'GET',
            url: '/api/v1/products?limit=3&offset=9&sortBy=createdAt&sortOrder=desc',
        });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.take).toBe(3);
        expect(call.skip).toBe(9);
        expect(call.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('should handle filter + fields without include', async () => {
        await app.inject({
            method: 'GET',
            url: '/api/v1/products?q=price%3Dlt:50&fields=id,name,price',
        });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where.price).toBeDefined();
        expect(call.select).toEqual({ id: true, name: true, price: true });
    });
});

// ─────────────────────────────────────────────────────────
// RESPONSE FORMAT / META
// ─────────────────────────────────────────────────────────

describe('Response format and meta', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerProductRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should return correct response structure with data and meta', async () => {
        mockPrismaModel.findMany.mockResolvedValue([
            { id: 1, name: 'A' },
            { id: 2, name: 'B' },
        ]);
        mockPrismaModel.count.mockResolvedValue(2);

        const response = await app.inject({ method: 'GET', url: '/api/v1/products' });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        expect(body.data).toBeDefined();
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBe(2);
        expect(body.meta).toBeDefined();
        expect(body.meta.total).toBe(2);
        expect(body.meta.count).toBe(2);
        expect(body.meta.limit).toBe(25);
        expect(body.meta.offset).toBe(0);
    });

    it('should return empty data array when no results', async () => {
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);

        const response = await app.inject({ method: 'GET', url: '/api/v1/products' });
        const body = JSON.parse(response.payload);
        expect(body.data).toEqual([]);
        expect(body.meta.total).toBe(0);
        expect(body.meta.count).toBe(0);
    });

    it('should reflect actual count vs total correctly', async () => {
        mockPrismaModel.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
        mockPrismaModel.count.mockResolvedValue(100);

        const response = await app.inject({ method: 'GET', url: '/api/v1/products?limit=3' });
        const body = JSON.parse(response.payload);
        expect(body.meta.count).toBe(3);
        expect(body.meta.total).toBe(100);
        expect(body.meta.limit).toBe(3);
    });

    it('should return 404 for single record not found', async () => {
        mockPrismaModel.findUnique.mockResolvedValue(null);

        const response = await app.inject({ method: 'GET', url: '/api/v1/products/999' });
        expect(response.statusCode).toBe(404);
    });

    it('should return 403 when record exists but permission denied', async () => {
        mockPrismaModel.findUnique
            .mockResolvedValueOnce({ id: 1, name: 'Product' })
            .mockResolvedValueOnce(null);

        const response = await app.inject({ method: 'GET', url: '/api/v1/products/1' });
        expect(response.statusCode).toBe(403);
    });

    it('should return 200 with data for single record', async () => {
        mockPrismaModel.findUnique
            .mockResolvedValueOnce({ id: 1, name: 'Product', price: 9.99 })
            .mockResolvedValueOnce({ id: 1 });

        const response = await app.inject({ method: 'GET', url: '/api/v1/products/1' });
        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        expect(body.id).toBe(1);
        expect(body.name).toBe('Product');
    });
});

// ─────────────────────────────────────────────────────────
// ACL INTEGRATION
// ─────────────────────────────────────────────────────────

describe('ACL integration with query parameters', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerProductRoutes(app, normalUser);
        await app.ready();
    });

    afterAll(async () => { await app.close(); });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    it('should apply access filter for non-admin on list query', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        expect(call.where).toBeDefined();
        // Access filter should add ownerId: normalUser.id
        expect(call.where.ownerId).toBe(42);
    });

    it('should combine access filter with user filter', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products?q=name%3D%25Widget%25' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        // Should have both user filter and ACL filter
        expect(call.where.name).toBeDefined();
        expect(call.where.ownerId).toBe(42);
    });

    it('should omit internal_cost field for non-admin', async () => {
        await app.inject({ method: 'GET', url: '/api/v1/products' });

        const call = mockPrismaModel.findMany.mock.calls[0][0];
        // Should have omit for internal_cost
        expect(call.omit?.internal_cost).toBe(true);
    });

    it('should apply access filter on single record permission check', async () => {
        mockPrismaModel.findUnique
            .mockResolvedValueOnce({ id: 1, name: 'Product' })
            .mockResolvedValueOnce({ id: 1 });

        await app.inject({ method: 'GET', url: '/api/v1/products/1' });

        // Second findUnique call is the permission check
        const permCall = mockPrismaModel.findUnique.mock.calls[1][0];
        expect(permCall.where.ownerId).toBe(42);
    });
});
