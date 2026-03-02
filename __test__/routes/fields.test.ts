/**
 * Route-level integration tests for the `fields` query parameter.
 * Tests that GET / (getMany) and GET /:id (get) correctly handle `fields`
 * through the full route → model → QueryBuilder → Prisma pipeline.
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
            items: {
                getAccessFilter: (user: any) => user?.role === 'admin' ? {} : { ownerId: user?.id },
                getOmitFields: (user: any) => user?.role === 'admin' ? [] : ['secret_field'],
            },
            categories: {
                getAccessFilter: () => ({}),
                getOmitFields: () => ['internal_code'],
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
    getFields: jest.fn(() => ({
        id: { name: 'id', kind: 'scalar', type: 'Int', isId: true, isList: false, isRequired: true, isUnique: true },
        name: { name: 'name', kind: 'scalar', type: 'String', isId: false, isList: false, isRequired: true, isUnique: false },
        description: { name: 'description', kind: 'scalar', type: 'String', isId: false, isList: false, isRequired: false, isUnique: false },
        price: { name: 'price', kind: 'scalar', type: 'Float', isId: false, isList: false, isRequired: false, isUnique: false },
        ownerId: { name: 'ownerId', kind: 'scalar', type: 'Int', isId: false, isList: false, isRequired: true, isUnique: false },
        secret_field: { name: 'secret_field', kind: 'scalar', type: 'String', isId: false, isList: false, isRequired: false, isUnique: false },
    })),
    getScalarFields: jest.fn(() => ({
        id: { name: 'id', kind: 'scalar', type: 'Int', isId: true },
        name: { name: 'name', kind: 'scalar', type: 'String', isId: false },
        description: { name: 'description', kind: 'scalar', type: 'String', isId: false },
        price: { name: 'price', kind: 'scalar', type: 'Float', isId: false },
        ownerId: { name: 'ownerId', kind: 'scalar', type: 'Int', isId: false },
        secret_field: { name: 'secret_field', kind: 'scalar', type: 'String', isId: false },
    })),
    getPrimaryKey: jest.fn(() => 'id'),
    getRelations: jest.fn(() => []),
    getModel: jest.fn(() => ({
        name: 'items',
        fields: [
            { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
            { name: 'name', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
            { name: 'description', kind: 'scalar', type: 'String', isList: false, isRequired: false, isId: false, isUnique: false },
            { name: 'price', kind: 'scalar', type: 'Float', isList: false, isRequired: false, isId: false, isUnique: false },
            { name: 'ownerId', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false, isUnique: false },
            { name: 'secret_field', kind: 'scalar', type: 'String', isList: false, isRequired: false, isId: false, isUnique: false },
            { name: 'category', kind: 'object', type: 'categories', isList: false, isRequired: false, isId: false, isUnique: false, relationFromFields: ['categoryId'], relationToFields: ['id'], relationName: 'ItemToCategory' },
            { name: 'tags', kind: 'object', type: 'tags', isList: true, isRequired: false, isId: false, isUnique: false, relationFromFields: [], relationToFields: [], relationName: 'ItemToTags' },
        ],
    })),
    isListRelation: jest.fn((_parent: string, rel: string) => rel === 'tags'),
    getRelationInfo: jest.fn(() => null),
    buildRelationships: jest.fn(() => [
        { name: 'category', object: 'categories', isList: false, field: 'categoryId', foreignKey: 'id' },
        { name: 'tags', object: 'tags', isList: true, field: 'itemId', foreignKey: 'id' },
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

function registerItemRoutes(app: FastifyInstance, user: any) {
    app.addHook('preHandler', async (request) => {
        (request as any).user = user;
    });

    app.get('/api/v1/items', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { q = {}, include = '', limit = '25', offset = '0', sortBy = 'id', sortOrder = 'asc', fields = null } = request.query as Record<string, string>;
            const model = new Model('items', { user: (request as any).user });
            const results = await model.getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder as 'asc' | 'desc', fields);
            return reply.sendList(results.data, results.meta);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });

    app.get('/api/v1/items/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { id: rawId } = request.params as { id: string };
            const { include = '', fields = null } = request.query as Record<string, string>;
            const model = new Model('items', { user: (request as any).user });
            const response = await model.get(Number(rawId), include, {}, fields);
            return reply.send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });
}

// Minimal temp dirs for buildApp (it requires ROUTES_PATH and STRINGS_PATH)
const TEMP_ROUTES = path.join(__dirname, '__temp_fields_empty__');
const TEMP_STRINGS = path.join(__dirname, '__temp_fields_strings__');

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

// ─── Positive Tests ─────────────────────────────────────

describe('Fields parameter - Positive tests', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerItemRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    describe('GET / (getMany)', () => {
        it('should return all fields when fields param is not provided', async () => {
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1, name: 'Item 1', description: 'Desc', price: 10 }]);
            mockPrismaModel.count.mockResolvedValue(1);

            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items',
            });

            expect(response.statusCode).toBe(200);
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall).not.toHaveProperty('select');
        });

        it('should select only specified scalar fields', async () => {
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1, name: 'Item 1' }]);
            mockPrismaModel.count.mockResolvedValue(1);

            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,name',
            });

            expect(response.statusCode).toBe(200);
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select).toEqual({ id: true, name: true });
            expect(findManyCall).not.toHaveProperty('include');
            expect(findManyCall).not.toHaveProperty('omit');
        });

        it('should select a single field', async () => {
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1 }]);
            mockPrismaModel.count.mockResolvedValue(1);

            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id',
            });

            expect(response.statusCode).toBe(200);
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select).toEqual({ id: true });
        });

        it('should select multiple scalar fields', async () => {
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1, name: 'Item', price: 9.99 }]);
            mockPrismaModel.count.mockResolvedValue(1);

            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,name,price',
            });

            expect(response.statusCode).toBe(200);
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select).toEqual({ id: true, name: true, price: true });
        });

        it('should select relation fields when include is provided', async () => {
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1, name: 'Item', category: { name: 'Cat1' } }]);
            mockPrismaModel.count.mockResolvedValue(1);

            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,name,category.name&include=category',
            });

            expect(response.statusCode).toBe(200);
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select.id).toBe(true);
            expect(findManyCall.select.name).toBe(true);
            expect(findManyCall.select.category).toBeDefined();
            expect(findManyCall.select.category.select.name).toBe(true);
        });

        it('should select multiple relation sub-fields', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,tags.name,tags.color&include=tags',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select.tags.select).toEqual({ name: true, color: true });
        });

        it('should handle deep nested relation fields (2 levels)', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,category.parent.name&include=category',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select.id).toBe(true);
            expect(findManyCall.select.category.select.parent).toEqual({
                select: { name: true },
            });
        });

        it('should handle deep nested relation fields (3 levels)', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,category.parent.grandparent.name&include=category',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select.category.select.parent).toEqual({
                select: {
                    grandparent: {
                        select: { name: true },
                    },
                },
            });
        });

        it('should handle mixed shallow and deep relation fields', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,category.name,category.parent.name&include=category',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select.category.select.name).toBe(true);
            expect(findManyCall.select.category.select.parent).toEqual({
                select: { name: true },
            });
        });

        it('should merge multiple deep fields into same nested relation', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,category.parent.name,category.parent.id&include=category',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select.category.select.parent).toEqual({
                select: { name: true, id: true },
            });
        });

        it('should work with fields + pagination', async () => {
            mockPrismaModel.findMany.mockResolvedValue([{ id: 3 }]);
            mockPrismaModel.count.mockResolvedValue(10);

            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id&limit=5&offset=2',
            });

            expect(response.statusCode).toBe(200);
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select).toEqual({ id: true });
            expect(findManyCall.take).toBe(5);
            expect(findManyCall.skip).toBe(2);
        });

        it('should work with fields + sorting', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,name&sortBy=name&sortOrder=desc',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select).toEqual({ id: true, name: true });
            expect(findManyCall.orderBy).toBeDefined();
        });

        it('should work with fields + filters (q param)', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,name&q[name]=Test',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select).toEqual({ id: true, name: true });
            expect(findManyCall.where).toBeDefined();
        });

        it('should return correct response shape with fields', async () => {
            mockPrismaModel.findMany.mockResolvedValue([
                { id: 1, name: 'Item 1' },
                { id: 2, name: 'Item 2' },
            ]);
            mockPrismaModel.count.mockResolvedValue(2);

            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,name&limit=10',
            });

            expect(response.statusCode).toBe(200);
            const body = JSON.parse(response.payload);
            expect(body.data).toEqual([
                { id: 1, name: 'Item 1' },
                { id: 2, name: 'Item 2' },
            ]);
            expect(body.meta.total).toBe(2);
            expect(body.meta.count).toBe(2);
            expect(body.meta.limit).toBe(10);
            expect(body.meta.offset).toBe(0);
        });

        it('should include relation with all fields when in include but not in fields', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,name&include=category',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select.id).toBe(true);
            expect(findManyCall.select.name).toBe(true);
            expect(findManyCall.select.category).toBeDefined();
        });

        it('should work with include=ALL and fields', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,category.name&include=ALL',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select.id).toBe(true);
            expect(findManyCall.select.category.select.name).toBe(true);
        });

        it('should handle fields combined with all query params', async () => {
            mockPrismaModel.findMany.mockResolvedValue([{ id: 5, name: 'Combined' }]);
            mockPrismaModel.count.mockResolvedValue(20);

            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,name&include=category&limit=5&offset=10&sortBy=name&sortOrder=desc',
            });

            expect(response.statusCode).toBe(200);
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select.id).toBe(true);
            expect(findManyCall.select.name).toBe(true);
            expect(findManyCall.select.category).toBeDefined();
            expect(findManyCall.take).toBe(5);
            expect(findManyCall.skip).toBe(10);
            expect(findManyCall.orderBy).toBeDefined();
        });
    });

    describe('GET /:id (get)', () => {
        it('should select only specified fields for single record', async () => {
            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, name: 'Item 1' })
                .mockResolvedValueOnce({ id: 1 });

            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items/1?fields=id,name',
            });

            expect(response.statusCode).toBe(200);
            const dataCall = mockPrismaModel.findUnique.mock.calls[0][0];
            expect(dataCall.select).toEqual({ id: true, name: true });
            expect(dataCall).not.toHaveProperty('include');
        });

        it('should select relation fields for single record', async () => {
            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, name: 'Item 1', category: { name: 'Cat' } })
                .mockResolvedValueOnce({ id: 1 });

            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items/1?fields=id,name,category.name&include=category',
            });

            expect(response.statusCode).toBe(200);
            const dataCall = mockPrismaModel.findUnique.mock.calls[0][0];
            expect(dataCall.select.category.select.name).toBe(true);
        });

        it('should handle deep nested relation fields for single record', async () => {
            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, category: { parent: { name: 'Root' } } })
                .mockResolvedValueOnce({ id: 1 });

            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items/1?fields=id,category.parent.name&include=category',
            });

            expect(response.statusCode).toBe(200);
            const dataCall = mockPrismaModel.findUnique.mock.calls[0][0];
            expect(dataCall.select.category.select.parent).toEqual({
                select: { name: true },
            });
        });

        it('should return all fields when fields param is not provided', async () => {
            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, name: 'Item', description: 'Desc' })
                .mockResolvedValueOnce({ id: 1 });

            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items/1',
            });

            expect(response.statusCode).toBe(200);
            const dataCall = mockPrismaModel.findUnique.mock.calls[0][0];
            expect(dataCall).not.toHaveProperty('select');
        });
    });

    describe('Edge cases', () => {
        it('should handle fields with extra whitespace', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields= id , name , price ',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select).toEqual({ id: true, name: true, price: true });
        });

        it('should deduplicate repeated fields', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,id,name,id',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select).toEqual({ id: true, name: true });
        });

        it('should handle trailing commas in fields', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,name,',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select).toEqual({ id: true, name: true });
        });

        it('should handle leading commas in fields', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=,id,name',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select).toEqual({ id: true, name: true });
        });

        it('should handle empty fields param (fallback to all fields)', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall).not.toHaveProperty('select');
        });

        it('should handle fields with only relation fields (no scalars)', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=category.name&include=category',
            });

            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            const selectKeys = Object.keys(findManyCall.select);
            expect(selectKeys).toContain('category');
        });
    });
});

// ─── Negative Tests ─────────────────────────────────────

describe('Fields parameter - Negative tests', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerItemRoutes(app, adminUser);
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    describe('relation not in include', () => {
        it('should return 400 when using relation fields without include', async () => {
            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,category.name',
            });

            expect(response.statusCode).toBe(400);
            const body = JSON.parse(response.payload);
            expect(body.message).toContain('relation_not_included');
        });

        it('should return 400 when relation is not in include list', async () => {
            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,tags.name&include=category',
            });

            expect(response.statusCode).toBe(400);
            const body = JSON.parse(response.payload);
            expect(body.message).toContain('relation_not_included');
        });

        it('should return 400 when one of multiple relations is missing from include', async () => {
            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,category.name,tags.name&include=category',
            });

            expect(response.statusCode).toBe(400);
        });

        it('should return 400 for relation fields on GET /:id without include', async () => {
            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items/1?fields=id,category.name',
            });

            expect(response.statusCode).toBe(400);
        });

        it('should return 400 for deep nested relation without include', async () => {
            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items?fields=id,category.parent.name',
            });

            expect(response.statusCode).toBe(400);
        });
    });

    describe('record not found', () => {
        it('should return 404 when record does not exist (with fields)', async () => {
            mockPrismaModel.findUnique.mockResolvedValue(null);

            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items/999?fields=id,name',
            });

            expect(response.statusCode).toBe(404);
        });
    });

    describe('permission denied', () => {
        it('should return 403 when permission check fails (with fields)', async () => {
            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, name: 'Item' })
                .mockResolvedValueOnce(null);

            const response = await app.inject({
                method: 'GET',
                url: '/api/v1/items/1?fields=id,name',
            });

            expect(response.statusCode).toBe(403);
        });
    });
});

// ─── ACL Field Exclusion Tests ──────────────────────────

describe('Fields parameter - ACL field exclusion', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ routesPath: TEMP_ROUTES, rateLimit: false });
        registerItemRoutes(app, normalUser);
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockPrismaModel.findMany.mockResolvedValue([]);
        mockPrismaModel.count.mockResolvedValue(0);
    });

    it('should exclude ACL-omitted fields from select for non-admin', async () => {
        await app.inject({
            method: 'GET',
            url: '/api/v1/items?fields=id,name,secret_field',
        });

        const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
        expect(findManyCall.select.id).toBe(true);
        expect(findManyCall.select.name).toBe(true);
        expect(findManyCall.select.secret_field).toBeUndefined();
    });

    it('should exclude ACL-omitted relation fields', async () => {
        await app.inject({
            method: 'GET',
            url: '/api/v1/items?fields=id,category.internal_code&include=category',
        });

        const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
        expect(findManyCall.select.id).toBe(true);
        expect(findManyCall.select.category.select.internal_code).toBeUndefined();
    });

    it('should apply access filter for non-admin on list query', async () => {
        await app.inject({
            method: 'GET',
            url: '/api/v1/items?fields=id,name',
        });

        const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
        expect(findManyCall.where).toBeDefined();
    });
});
