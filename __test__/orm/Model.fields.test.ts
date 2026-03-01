/**
 * Integration tests for Model field selection (fields parameter).
 * Tests that getMany() and get() correctly pass fields through to Prisma.
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
    prismaTransaction: jest.fn(async (arg: any, _opts?: any) => {
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
    getAcl: jest.fn(() => ({
        model: {
            posts: {
                getAccessFilter: (user: any) => user?.role === 'admin' ? {} : { authorId: user?.id },
                getOmitFields: (user: any) => user?.role === 'admin' ? [] : ['draft_notes'],
            },
            users: {
                getAccessFilter: () => ({}),
                getOmitFields: () => ['password'],
            },
            comments: {
                getAccessFilter: (user: any) => user?.role === 'admin' ? {} : { visible: true },
                getOmitFields: () => [],
            },
        },
    })),
}));

jest.mock('../../src/core/dmmf', () => ({
    getFields: jest.fn(() => ({
        id: { name: 'id', kind: 'scalar', type: 'Int', isId: true, isList: false, isRequired: true, isUnique: true },
        title: { name: 'title', kind: 'scalar', type: 'String', isId: false, isList: false, isRequired: true, isUnique: false },
        content: { name: 'content', kind: 'scalar', type: 'String', isId: false, isList: false, isRequired: false, isUnique: false },
        status: { name: 'status', kind: 'scalar', type: 'String', isId: false, isList: false, isRequired: false, isUnique: false },
        authorId: { name: 'authorId', kind: 'scalar', type: 'Int', isId: false, isList: false, isRequired: true, isUnique: false },
        draft_notes: { name: 'draft_notes', kind: 'scalar', type: 'String', isId: false, isList: false, isRequired: false, isUnique: false },
    })),
    getScalarFields: jest.fn(() => ({
        id: { name: 'id', kind: 'scalar', type: 'Int', isId: true },
        title: { name: 'title', kind: 'scalar', type: 'String', isId: false },
        content: { name: 'content', kind: 'scalar', type: 'String', isId: false },
        status: { name: 'status', kind: 'scalar', type: 'String', isId: false },
        authorId: { name: 'authorId', kind: 'scalar', type: 'Int', isId: false },
        draft_notes: { name: 'draft_notes', kind: 'scalar', type: 'String', isId: false },
    })),
    getPrimaryKey: jest.fn(() => 'id'),
    getRelations: jest.fn(() => []),
    getModel: jest.fn(() => ({
        name: 'posts',
        fields: [
            { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
            { name: 'title', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
            { name: 'content', kind: 'scalar', type: 'String', isList: false, isRequired: false, isId: false, isUnique: false },
            { name: 'status', kind: 'scalar', type: 'String', isList: false, isRequired: false, isId: false, isUnique: false },
            { name: 'authorId', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false, isUnique: false },
            { name: 'draft_notes', kind: 'scalar', type: 'String', isList: false, isRequired: false, isId: false, isUnique: false },
            { name: 'author', kind: 'object', type: 'users', isList: false, isRequired: false, isId: false, isUnique: false, relationFromFields: ['authorId'], relationToFields: ['id'], relationName: 'PostToUser' },
            { name: 'comments', kind: 'object', type: 'comments', isList: true, isRequired: false, isId: false, isUnique: false, relationFromFields: [], relationToFields: [], relationName: 'PostToComments' },
        ],
    })),
    isListRelation: jest.fn((_parent: string, rel: string) => {
        return rel === 'comments';
    }),
    getRelationInfo: jest.fn(() => null),
    buildRelationships: jest.fn(() => [
        { name: 'author', object: 'users', isList: false, field: 'authorId', foreignKey: 'id' },
        { name: 'comments', object: 'comments', isList: true, field: 'postId', foreignKey: 'id' },
    ]),
}));

import { Model } from '../../src/orm/Model';
import { modelMiddleware } from '../../src/core/middleware';

describe('Model - Field Selection', () => {
    let model: Model;
    const adminUser = { id: 1, role: 'admin' };
    const normalUser = { id: 42, role: 'user' };

    beforeEach(() => {
        jest.clearAllMocks();
        modelMiddleware.clear();
    });

    // ── getMany() with fields ────────────────────────────

    describe('getMany() with fields parameter', () => {
        beforeEach(() => {
            model = new Model('posts', { user: adminUser });
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1, title: 'Test' }]);
            mockPrismaModel.count.mockResolvedValue(1);
        });

        it('should pass fields=null by default (current behavior)', async () => {
            await model.getMany({}, '', 10, 0, 'id', 'asc');
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            // Should NOT have a select key (uses include+omit instead)
            expect(findManyCall).not.toHaveProperty('select');
        });

        it('should use select when fields is specified', async () => {
            await model.getMany({}, '', 10, 0, 'id', 'asc', 'id,title');
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall).toHaveProperty('select');
            expect(findManyCall.select.id).toBe(true);
            expect(findManyCall.select.title).toBe(true);
            expect(findManyCall).not.toHaveProperty('include');
            expect(findManyCall).not.toHaveProperty('omit');
        });

        it('should handle fields with relation', async () => {
            await model.getMany({}, 'author', 10, 0, 'id', 'asc', 'id,title,author.name');
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select.id).toBe(true);
            expect(findManyCall.select.title).toBe(true);
            expect(findManyCall.select.author).toBeDefined();
            expect(findManyCall.select.author.select.name).toBe(true);
        });

        it('should still apply filters when fields is specified', async () => {
            await model.getMany({ title: 'test' }, '', 10, 0, 'id', 'asc', 'id,title');
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.where).toBeDefined();
        });

        it('should still apply pagination when fields is specified', async () => {
            await model.getMany({}, '', 5, 10, 'id', 'asc', 'id');
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.take).toBe(5);
            expect(findManyCall.skip).toBe(10);
        });

        it('should still apply sorting when fields is specified', async () => {
            await model.getMany({}, '', 10, 0, 'title', 'desc', 'id,title');
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.orderBy).toBeDefined();
        });

        it('should return correct result shape', async () => {
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1, title: 'Test' }]);
            mockPrismaModel.count.mockResolvedValue(1);

            const result = await model.getMany({}, '', 10, 0, 'id', 'asc', 'id,title');
            expect(result.data).toEqual([{ id: 1, title: 'Test' }]);
            expect(result.meta).toEqual({ take: 10, skip: 0, total: 1 });
        });

        it('should throw for relation not in include', async () => {
            await expect(
                model.getMany({}, '', 10, 0, 'id', 'asc', 'id,author.name')
            ).rejects.toThrow('relation_not_included');
        });

        it('should exclude ACL-omitted fields from select for non-admin', async () => {
            model = new Model('posts', { user: normalUser });
            await model.getMany({}, '', 10, 0, 'id', 'asc', 'id,title,draft_notes');
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select.id).toBe(true);
            expect(findManyCall.select.title).toBe(true);
            expect(findManyCall.select.draft_notes).toBeUndefined();
        });
    });

    // ── get() with fields ────────────────────────────────

    describe('get() with fields parameter', () => {
        beforeEach(() => {
            model = new Model('posts', { user: adminUser });
        });

        it('should pass fields=null by default (current behavior)', async () => {
            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, title: 'Test' })
                .mockResolvedValueOnce({ id: 1 });

            await model.get(1);
            const findUniqueCall = mockPrismaModel.findUnique.mock.calls[0][0];
            expect(findUniqueCall).not.toHaveProperty('select');
            expect(findUniqueCall).toHaveProperty('include');
        });

        it('should use select when fields is specified', async () => {
            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, title: 'Test' })
                .mockResolvedValueOnce({ id: 1 });

            await model.get(1, '', {}, 'id,title');
            const dataCall = mockPrismaModel.findUnique.mock.calls[0][0];
            expect(dataCall).toHaveProperty('select');
            expect(dataCall.select.id).toBe(true);
            expect(dataCall.select.title).toBe(true);
            expect(dataCall).not.toHaveProperty('include');
            expect(dataCall).not.toHaveProperty('omit');
        });

        it('should still perform permission check query', async () => {
            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, title: 'Test' })
                .mockResolvedValueOnce({ id: 1 });

            await model.get(1, '', {}, 'id,title');
            // Two findUnique calls: data + permission
            expect(mockPrismaModel.findUnique).toHaveBeenCalledTimes(2);
        });

        it('should handle fields with relations', async () => {
            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, title: 'Test', author: { name: 'Alice' } })
                .mockResolvedValueOnce({ id: 1 });

            await model.get(1, 'author', {}, 'id,title,author.name');
            const dataCall = mockPrismaModel.findUnique.mock.calls[0][0];
            expect(dataCall.select.id).toBe(true);
            expect(dataCall.select.title).toBe(true);
            expect(dataCall.select.author.select.name).toBe(true);
        });

        it('should throw for relation not in include', async () => {
            await expect(
                model.get(1, '', {}, 'id,author.name')
            ).rejects.toThrow('relation_not_included');
        });

        it('should throw 404 when record not found', async () => {
            mockPrismaModel.findUnique.mockResolvedValue(null);

            await expect(
                model.get(999, '', {}, 'id,title')
            ).rejects.toThrow('record_not_found');
        });

        it('should throw 403 when permission check fails', async () => {
            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, title: 'Test' })
                .mockResolvedValueOnce(null); // permission denied

            await expect(
                model.get(1, '', {}, 'id,title')
            ).rejects.toThrow('no_permission');
        });
    });

    // ── Middleware integration ────────────────────────────

    describe('middleware integration', () => {
        beforeEach(() => {
            model = new Model('posts', { user: adminUser });
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);
        });

        it('should pass fields in middleware context for getMany', async () => {
            let capturedCtx: any = null;
            modelMiddleware.use('before', 'getMany', async (ctx: any) => {
                capturedCtx = ctx;
                return ctx;
            });

            await model.getMany({}, '', 10, 0, 'id', 'asc', 'id,title');
            expect(capturedCtx.fields).toBe('id,title');
        });

        it('should pass fields=null in context when not specified', async () => {
            let capturedCtx: any = null;
            modelMiddleware.use('before', 'getMany', async (ctx: any) => {
                capturedCtx = ctx;
                return ctx;
            });

            await model.getMany({}, '', 10, 0, 'id', 'asc');
            expect(capturedCtx.fields).toBeNull();
        });

        it('should allow middleware to modify fields', async () => {
            modelMiddleware.use('before', 'getMany', async (ctx: any) => {
                // Middleware adds authorId to fields
                ctx.fields = 'id,title,authorId';
                return ctx;
            });

            await model.getMany({}, '', 10, 0, 'id', 'asc', 'id,title');
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select.authorId).toBe(true);
        });

        it('should allow middleware to clear fields (fall back to include+omit)', async () => {
            modelMiddleware.use('before', 'getMany', async (ctx: any) => {
                ctx.fields = null;
                return ctx;
            });

            await model.getMany({}, '', 10, 0, 'id', 'asc', 'id,title');
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            // Should fallback to include+omit mode
            expect(findManyCall).not.toHaveProperty('select');
        });

        it('should pass fields in middleware context for get', async () => {
            let capturedCtx: any = null;
            modelMiddleware.use('before', 'get', async (ctx: any) => {
                capturedCtx = ctx;
                return ctx;
            });

            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, title: 'Test' })
                .mockResolvedValueOnce({ id: 1 });

            await model.get(1, '', {}, 'id,title');
            expect(capturedCtx.fields).toBe('id,title');
        });

        it('should allow middleware to modify fields in get', async () => {
            modelMiddleware.use('before', 'get', async (ctx: any) => {
                ctx.fields = 'id,title,content';
                return ctx;
            });

            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, title: 'Test', content: 'Body' })
                .mockResolvedValueOnce({ id: 1 });

            await model.get(1, '', {}, 'id,title');
            const dataCall = mockPrismaModel.findUnique.mock.calls[0][0];
            expect(dataCall.select.content).toBe(true);
        });
    });

    // ── No fields preserves existing behavior ────────────

    describe('backward compatibility (no fields)', () => {
        beforeEach(() => {
            model = new Model('posts', { user: adminUser });
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);
        });

        it('getMany with no fields uses include+omit', async () => {
            await model.getMany({}, 'author', 10, 0, 'id', 'asc');
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall).not.toHaveProperty('select');
            // Should have include because we passed 'author'
            expect(findManyCall).toHaveProperty('include');
        });

        it('getMany with null fields uses include+omit', async () => {
            await model.getMany({}, 'author', 10, 0, 'id', 'asc', null);
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall).not.toHaveProperty('select');
        });

        it('get with no fields uses include+omit', async () => {
            mockPrismaModel.findUnique
                .mockResolvedValueOnce({ id: 1, title: 'Test' })
                .mockResolvedValueOnce({ id: 1 });

            await model.get(1, 'author');
            const dataCall = mockPrismaModel.findUnique.mock.calls[0][0];
            expect(dataCall).toHaveProperty('include');
            expect(dataCall).toHaveProperty('omit');
            expect(dataCall).not.toHaveProperty('select');
        });
    });

    // ── include=ALL with fields ──────────────────────────

    describe('include=ALL with fields', () => {
        beforeEach(() => {
            model = new Model('posts', { user: adminUser });
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);
        });

        it('should allow any relation when include is ALL', async () => {
            await model.getMany({}, 'ALL', 10, 0, 'id', 'asc', 'id,author.name,comments.text');
            const findManyCall = mockPrismaModel.findMany.mock.calls[0][0];
            expect(findManyCall.select.id).toBe(true);
            expect(findManyCall.select.author).toBeDefined();
            expect(findManyCall.select.comments).toBeDefined();
        });
    });
});
