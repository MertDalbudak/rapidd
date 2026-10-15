/**
 * Tests for the Model ORM class.
 * Mocks Prisma client and DMMF to test Model methods in isolation.
 */

// Mock prisma and ACL
const mockPrismaModel = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    upsert: jest.fn(),
    createMany: jest.fn(),
    count: jest.fn(),
};

jest.mock('../../src/core/prisma', () => ({
    rlsActive: () => false,
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
    getAcl: jest.fn(() => ({ model: {} })),
    authPrisma: {},
}));

jest.mock('../../src/core/dmmf', () => ({
    getFields: jest.fn(() => ({
        id: { name: 'id', kind: 'scalar', type: 'Int', isId: true, isList: false, isRequired: true, isUnique: true },
        title: { name: 'title', kind: 'scalar', type: 'String', isId: false, isList: false, isRequired: true, isUnique: false },
        status: { name: 'status', kind: 'scalar', type: 'String', isId: false, isList: false, isRequired: false, isUnique: false },
        authorId: { name: 'authorId', kind: 'scalar', type: 'Int', isId: false, isList: false, isRequired: true, isUnique: false },
    })),
    getScalarFields: jest.fn(() => ({
        id: { name: 'id', kind: 'scalar', type: 'Int', isId: true },
        title: { name: 'title', kind: 'scalar', type: 'String', isId: false },
        status: { name: 'status', kind: 'scalar', type: 'String', isId: false },
        authorId: { name: 'authorId', kind: 'scalar', type: 'Int', isId: false },
    })),
    getPrimaryKey: jest.fn(() => 'id'),
    getRelations: jest.fn(() => []),
    getModel: jest.fn(() => ({ name: 'posts', fields: [] })),
    isListRelation: jest.fn(() => false),
    getRelationInfo: jest.fn(() => null),
    buildRelationships: jest.fn(() => []),
    compoundKeyName: jest.fn((_model: string, fields: string[]) => fields.join('_')),
}));

import { Model } from '../../src/orm/Model';
import { modelMiddleware } from '../../src/core/middleware';
import { getAcl } from '../../src/core/prisma';
import { ErrorResponse } from '../../src/core/errors';
import { createSystemUser, isSystemUser } from '../../src/core/user';

describe('Model', () => {
    let model: Model;

    beforeEach(() => {
        jest.clearAllMocks();
        // Drop queued mockResolvedValueOnce values so they can't leak into the next test
        Object.values(mockPrismaModel).forEach((fn) => fn.mockReset());
        modelMiddleware.clear();
        (getAcl as jest.Mock).mockReturnValue({ model: {} });
        model = new Model('posts', { user: { id: 1, role: 'admin' } });
    });

    // ── Constructor ──────────────────────────────────────────

    describe('constructor', () => {
        it('should set model name', () => {
            expect(model.name).toBe('posts');
        });

        it('should set user from options', () => {
            expect(model.user).toEqual({ id: 1, role: 'admin' });
            expect(model.user_id).toBe(1);
        });

        it('should default to a (non-forgeable) identity-less system user when no options', () => {
            const m = new Model('posts');
            expect(isSystemUser(m.user)).toBe(true);
            // No fabricated PK, and no attributes beyond it
            expect(m.user.id).toBeNull();
            expect(Object.keys(m.user)).toEqual(['id']);
        });

        it('should NOT treat role="application" as a system bypass anymore', () => {
            const m = new Model('posts', { user: { id: 1, role: 'application' } });
            expect(isSystemUser(m.user)).toBe(false);
        });

        it('should load ACL for model', () => {
            (getAcl as jest.Mock).mockReturnValue({ model: { posts: { canCreate: () => true } } });
            const m = new Model('posts');
            expect(m.acl.canCreate).toBeDefined();
        });

        it('should use empty ACL for unknown model', () => {
            const m = new Model('unknown');
            expect(m.acl).toEqual({});
        });
    });

    // ── Primary Key ──────────────────────────────────────────

    describe('primaryKey', () => {
        it('should return simple PK', () => {
            expect(model.primaryKey).toBe('id');
        });

        it('should return isCompositePK=false for simple PK', () => {
            expect(model.isCompositePK).toBe(false);
        });

        it('should return defaultSortField', () => {
            expect(model.defaultSortField).toBe('id');
        });
    });

    // ── buildWhereId ─────────────────────────────────────────

    describe('buildWhereId()', () => {
        it('should build simple where clause', () => {
            expect(model.buildWhereId(1)).toEqual({ id: 1 });
        });

        it('coerces URL string ids to the key type', () => {
            expect(model.buildWhereId('5')).toEqual({ id: 5 });
            expect(model.buildWhereId(' -7 ')).toEqual({ id: -7 });
        });

        it.each(['abc', '12abc', '1.5', '', '9007199254740993', '0x10'])('rejects %p for an Int key with 400 invalid_id', (id) => {
            expect(() => model.buildWhereId(id)).toThrow(expect.objectContaining({ status_code: 400, message: 'invalid_id' }));
        });
    });

    // ── buildWhereUniqueKey ──────────────────────────────────

    describe('buildWhereUniqueKey()', () => {
        it('should build simple unique key where clause', () => {
            const result = model.buildWhereUniqueKey('title', { title: 'Hello' });
            expect(result).toEqual({ title: 'Hello' });
        });

        it('should build composite unique key where clause', () => {
            const result = model.buildWhereUniqueKey(['authorId', 'title'], { authorId: 1, title: 'Hello' });
            expect(result).toEqual({ authorId_title: { authorId: 1, title: 'Hello' } });
        });
    });

    // ── skip / take ──────────────────────────────────────────

    describe('skip()', () => {
        it('should return 0 for negative values', () => {
            expect(model.skip(-1)).toBe(0);
        });

        it('should return 0 for NaN', () => {
            expect(model.skip('abc')).toBe(0);
        });

        it('should return parsed integer', () => {
            expect(model.skip(10)).toBe(10);
            expect(model.skip('25')).toBe(25);
        });

        it('should return 0 for zero', () => {
            expect(model.skip(0)).toBe(0);
        });
    });

    // ── ACL Methods ──────────────────────────────────────────

    describe('canCreate()', () => {
        it('should return true when no ACL defined', () => {
            expect(model.canCreate()).toBe(true);
        });

        it('should return true for a system user', () => {
            const m = new Model('posts', { user: createSystemUser({ id: 'sys' }) });
            expect(m.canCreate()).toBe(true);
        });

        it('should pass data to ACL canCreate', () => {
            const canCreateFn = jest.fn(() => true);
            (getAcl as jest.Mock).mockReturnValue({ model: { posts: { canCreate: canCreateFn } } });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            m.canCreate({ title: 'Test' });
            expect(canCreateFn).toHaveBeenCalledWith({ id: 1, role: 'user' }, { title: 'Test' });
        });

        it('should return false when ACL denies', () => {
            (getAcl as jest.Mock).mockReturnValue({ model: { posts: { canCreate: () => false } } });
            const m = new Model('posts', { user: { id: 1, role: 'guest' } });
            expect(m.canCreate()).toBe(false);
        });
    });

    describe('getAccessFilter()', () => {
        it('should return empty object when no ACL defined', () => {
            expect(model.getAccessFilter()).toEqual({});
        });

        it('should return empty object for a system user', () => {
            const m = new Model('posts', { user: createSystemUser({ id: 'sys' }) });
            expect(m.getAccessFilter()).toEqual({});
        });

        it('should NOT invoke the ACL callback for a system user (null-id safe)', () => {
            const getAccessFilter = jest.fn((u: any) => ({ ownerId: u.id.toUpperCase() })); // would throw on null id
            (getAcl as jest.Mock).mockReturnValue({ model: { posts: { getAccessFilter } } });
            const m = new Model('posts', { user: createSystemUser() });
            expect(() => m.getAccessFilter()).not.toThrow();
            expect(m.getAccessFilter()).toEqual({});
            expect(getAccessFilter).not.toHaveBeenCalled();
        });

        it('should return empty when filter is true', () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getAccessFilter: () => true } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'admin' } });
            expect(m.getAccessFilter()).toEqual({});
        });

        it('should throw 403 when filter is false', () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getAccessFilter: () => false } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            expect(() => m.getAccessFilter()).toThrow(ErrorResponse);
        });

        it('should return filter object', () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getAccessFilter: (user: any) => ({ authorId: user.id }) } }
            });
            const m = new Model('posts', { user: { id: 5, role: 'user' } });
            expect(m.getAccessFilter()).toEqual({ authorId: 5 });
        });
    });

    describe('getUpdateFilter()', () => {
        it('should return undefined when no ACL filter defined', () => {
            // When no getUpdateFilter ACL function exists, _getUpdateFilter returns undefined
            // and getUpdateFilter passes it through (not application role)
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            expect(m.getUpdateFilter()).toBeUndefined();
        });

        it('should return empty object for a system user', () => {
            const m = new Model('posts', { user: createSystemUser({ id: 'sys' }) });
            expect(m.getUpdateFilter()).toEqual({});
        });

        it('should return false when denied', () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getUpdateFilter: () => false } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            expect(m.getUpdateFilter()).toBe(false);
        });
    });

    describe('getDeleteFilter()', () => {
        it('should return undefined when no ACL filter defined', () => {
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            expect(m.getDeleteFilter()).toBeUndefined();
        });

        it('should return false when denied', () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getDeleteFilter: () => false } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            expect(m.getDeleteFilter()).toBe(false);
        });
    });

    // ── filter() AND combination ────────────────────────────

    describe('filter()', () => {
        it('should return only ACL filter when no API filter', () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getAccessFilter: (user: any) => ({ authorId: user.id }) } }
            });
            const m = new Model('posts', { user: { id: 5, role: 'user' } });
            const result = m.filter('');
            expect(result).toEqual({ authorId: 5 });
            expect(result.AND).toBeUndefined();
        });

        it('should return only API filter when no ACL filter', () => {
            const m = new Model('posts', { user: { id: 1, role: 'admin' } });
            // Mock _filter to return an API filter
            m._filter = jest.fn(() => ({ status: 'active' }));
            const result = m.filter('status=active');
            expect(result).toEqual({ status: 'active' });
            expect(result.AND).toBeUndefined();
        });

        it('should combine API and ACL filters with AND', () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getAccessFilter: (user: any) => ({ authorId: user.id }) } }
            });
            const m = new Model('posts', { user: { id: 5, role: 'user' } });
            m._filter = jest.fn(() => ({ status: 'active' }));
            const result = m.filter('status=active');
            expect(result.AND).toBeDefined();
            expect(result.AND).toHaveLength(2);
            expect(result.AND[0]).toEqual({ status: 'active' });
            expect(result.AND[1]).toEqual({ authorId: 5 });
        });

        it('should combine when ACL uses OR filter', () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getAccessFilter: () => ({ OR: [{ status: 'published' }, { status: 'draft' }] }) } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'editor' } });
            m._filter = jest.fn(() => ({ title: { contains: 'Hello' } }));
            const result = m.filter('title=%Hello%');
            expect(result.AND).toBeDefined();
            expect(result.AND).toHaveLength(2);
            expect(result.AND[0]).toEqual({ title: { contains: 'Hello' } });
            expect(result.AND[1]).toEqual({ OR: [{ status: 'published' }, { status: 'draft' }] });
        });

        it('should combine when ACL has nested relation filter', () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getAccessFilter: () => ({ author: { department: { id: 3 } } }) } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            m._filter = jest.fn(() => ({ status: 'active' }));
            const result = m.filter('status=active');
            expect(result.AND).toBeDefined();
            expect(result.AND[1]).toEqual({ author: { department: { id: 3 } } });
        });

        it('should not overwrite overlapping keys between API and ACL filters', () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getAccessFilter: () => ({ status: { not: 'super_admin' } }) } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'admin' } });
            m._filter = jest.fn(() => ({ status: 'active' }));
            const result = m.filter('status=active');
            expect(result.AND).toBeDefined();
            expect(result.AND).toHaveLength(2);
            // Both status conditions preserved independently
            expect(result.AND[0]).toEqual({ status: 'active' });
            expect(result.AND[1]).toEqual({ status: { not: 'super_admin' } });
        });

        it('should combine when ACL has AND filter', () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getAccessFilter: () => ({ AND: [{ role: { not: 'super_admin' } }, { active: true }] }) } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'admin' } });
            m._filter = jest.fn(() => ({ role: { not: 'guest' } }));
            const result = m.filter('role=not:guest');
            expect(result.AND).toBeDefined();
            expect(result.AND).toHaveLength(2);
            expect(result.AND[0]).toEqual({ role: { not: 'guest' } });
            expect(result.AND[1]).toEqual({ AND: [{ role: { not: 'super_admin' } }, { active: true }] });
        });
    });

    // ── CRUD Operations ──────────────────────────────────────

    describe('_getMany()', () => {
        it('should call prismaTransaction with findMany and count', async () => {
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1, title: 'Test' }]);
            mockPrismaModel.count.mockResolvedValue(1);

            const result = await model.getMany({ limit: 10, sortBy: 'id' });
            expect(result.data).toEqual([{ id: 1, title: 'Test' }]);
            expect(result.meta.total).toBe(1);
            expect(result.meta.take).toBe(10);
            expect(result.meta.skip).toBe(0);
        });

        it('should use default parameters', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            const result = await model.getMany();
            expect(result.data).toEqual([]);
            expect(result.meta.total).toBe(0);
        });

        it('should throw for invalid sort field', async () => {
            await expect(model.getMany({ limit: 10, sortBy: 'nonexistent' }))
                .rejects.toThrow(ErrorResponse);
        });

        it('should execute before/after middleware', async () => {
            const order: string[] = [];
            modelMiddleware.use('before', 'getMany', async (ctx) => {
                order.push('before');
                return ctx;
            });
            modelMiddleware.use('after', 'getMany', async (ctx) => {
                order.push('after');
                return ctx;
            });

            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.count.mockResolvedValue(0);

            await model.getMany();
            expect(order).toEqual(['before', 'after']);
        });

        it('should abort if before middleware sets abort', async () => {
            modelMiddleware.use('before', 'getMany', async (ctx) => {
                return { ...ctx, abort: true, result: { data: [{ id: 99 }], meta: { take: 10, skip: 0, total: 1 } } };
            });

            const result = await model.getMany();
            expect(result.data).toEqual([{ id: 99 }]);
            expect(mockPrismaModel.findMany).not.toHaveBeenCalled();
        });
    });

    describe('_get()', () => {
        const restrict = () => (getAcl as jest.Mock).mockReturnValue({
            model: { posts: { getAccessFilter: (user: any) => ({ authorId: user.id }) } },
        });

        it('should return record when found and authorized — one query', async () => {
            const record = { id: 1, title: 'Test' };
            mockPrismaModel.findUnique.mockResolvedValueOnce(record);
            const result = await model.get(1);
            expect(result).toEqual(record);
            expect(mockPrismaModel.findUnique).toHaveBeenCalledTimes(1);
        });

        it('should throw 404 when record not found', async () => {
            mockPrismaModel.findUnique.mockResolvedValueOnce(null);
            await expect(model.get(999)).rejects.toMatchObject({ status_code: 404 });
            expect(mockPrismaModel.findUnique).toHaveBeenCalledTimes(1);
        });

        it('scopes the lookup by the access filter', async () => {
            restrict();
            mockPrismaModel.findUnique.mockResolvedValueOnce({ id: 1 });
            await new Model('posts', { user: { id: 7, role: 'user' } }).get('1');
            expect(mockPrismaModel.findUnique).toHaveBeenCalledTimes(1);
            expect(mockPrismaModel.findUnique.mock.calls[0][0].where).toEqual({ id: 1, AND: [{ authorId: 7 }] });
        });

        it('should throw 403 when the record exists outside the access filter', async () => {
            restrict();
            mockPrismaModel.findUnique
                .mockResolvedValueOnce(null)        // scoped lookup
                .mockResolvedValueOnce({ id: 1 });  // existence check
            await expect(new Model('posts', { user: { id: 7, role: 'user' } }).get(1)).rejects.toMatchObject({ status_code: 403 });
        });

        it('should throw 404 when a restricted user asks for a missing record', async () => {
            restrict();
            mockPrismaModel.findUnique.mockResolvedValue(null);
            await expect(new Model('posts', { user: { id: 7, role: 'user' } }).get(1)).rejects.toMatchObject({ status_code: 404 });
        });

        it('options.where narrows the lookup but cannot replace the id or the ACL', async () => {
            restrict();
            mockPrismaModel.findUnique.mockResolvedValueOnce({ id: 1 });
            await new Model('posts', { user: { id: 7, role: 'user' } }).get(1, '', { where: { id: 2, status: 'live' } });
            expect(mockPrismaModel.findUnique.mock.calls[0][0].where).toEqual({ id: 1, AND: [{ authorId: 7 }, { id: 2, status: 'live' }] });
        });

        it('should execute middleware', async () => {
            const spy = jest.fn(async (ctx: any) => ctx);
            modelMiddleware.use('before', 'get', spy);

            mockPrismaModel.findUnique.mockResolvedValueOnce({ id: 1 });
            await model.get(1);
            expect(spy).toHaveBeenCalled();
        });

        it('should abort if before middleware aborts', async () => {
            modelMiddleware.use('before', 'get', async (ctx) => {
                return { ...ctx, abort: true, result: { id: 42, cached: true } };
            });

            const result = await model.get(1);
            expect(result).toEqual({ id: 42, cached: true });
            expect(mockPrismaModel.findUnique).not.toHaveBeenCalled();
        });
    });

    describe('_create()', () => {
        it('should create a record', async () => {
            const created = { id: 1, title: 'New Post' };
            mockPrismaModel.create.mockResolvedValue(created);
            const result = await model.create({ title: 'New Post' });
            expect(result).toEqual(created);
        });

        it('should apply the ACL omit clause to the create response (no field leak)', async () => {
            (getAcl as jest.Mock).mockReturnValue({ model: { posts: { getOmitFields: () => ['status'] } } });
            mockPrismaModel.create.mockResolvedValue({ id: 1 });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            await m.create({ title: 'X' });
            const call = mockPrismaModel.create.mock.calls[0][0];
            expect(call.omit).toEqual({ status: true });
        });

        it('should throw 403 when canCreate returns false', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { canCreate: () => false } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'guest' } });
            await expect(m.create({ title: 'Test' }))
                .rejects.toMatchObject({ status_code: 403 });
        });

        it('should execute before/after middleware', async () => {
            const order: string[] = [];
            modelMiddleware.use('before', 'create', async (ctx) => {
                order.push('before');
                return ctx;
            });
            modelMiddleware.use('after', 'create', async (ctx) => {
                order.push('after');
                return ctx;
            });

            mockPrismaModel.create.mockResolvedValue({ id: 1 });
            await model.create({ title: 'Test' });
            expect(order).toEqual(['before', 'after']);
        });

        it('should allow middleware to modify data', async () => {
            modelMiddleware.use('before', 'create', async (ctx) => {
                return { ...ctx, data: { ...ctx.data, status: 'draft' } };
            });

            mockPrismaModel.create.mockResolvedValue({ id: 1, title: 'Test', status: 'draft' });
            const result = await model.create({ title: 'Test' });
            expect(mockPrismaModel.create).toHaveBeenCalled();
            expect(result.status).toBe('draft');
        });
    });

    describe('_update()', () => {
        it('should update a record', async () => {
            const updated = { id: 1, title: 'Updated' };
            mockPrismaModel.update.mockResolvedValue(updated);
            const result = await model.update(1, { title: 'Updated' });
            expect(result).toEqual(updated);
        });

        it('should reject unknown fields like createdAt (no longer silently stripped)', async () => {
            // The hardcoded createdAt/createdBy stripping was removed — protected fields
            // are now governed by ACL (getOmitFields / getWritableFields) instead
            await expect(model.update(1, { title: 'Updated', createdAt: '2024-01-01' }))
                .rejects.toMatchObject({ status_code: 400 });
        });

        it('should strip protected fields via ACL omit (replaces createdAt/createdBy hack)', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getOmitFields: () => ['createdAt', 'createdBy'] } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            mockPrismaModel.update.mockResolvedValue({ id: 1, title: 'Updated' });
            await m.update(1, { title: 'Updated', createdAt: '2024-01-01', createdBy: 99 });
            const callArgs = mockPrismaModel.update.mock.calls[0][0];
            expect(callArgs.data.createdAt).toBeUndefined();
            expect(callArgs.data.createdBy).toBeUndefined();
        });

        it('should throw 403 when update filter is false', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getUpdateFilter: () => false } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            await expect(m.update(1, { title: 'Hacked' }))
                .rejects.toMatchObject({ status_code: 403 });
        });

        it('should execute middleware', async () => {
            const spy = jest.fn(async (ctx: any) => ctx);
            modelMiddleware.use('before', 'update', spy);
            mockPrismaModel.update.mockResolvedValue({ id: 1 });
            await model.update(1, { title: 'Test' });
            expect(spy).toHaveBeenCalled();
        });
    });

    describe('_delete()', () => {
        it('should delete a record', async () => {
            mockPrismaModel.delete.mockResolvedValue({ id: 1 });
            const result = await model.delete(1);
            expect(result).toEqual({ id: 1 });
        });

        it('selects scalar columns only — so a delete a row-level security policy refuses is noticed', async () => {
            mockPrismaModel.delete.mockResolvedValue({ id: 1 });
            const fields = jest.spyOn(model, 'fields', 'get').mockReturnValue({
                id: { name: 'id', kind: 'scalar', type: 'Int', isId: true },
                title: { name: 'title', kind: 'scalar', type: 'String' },
                author: { name: 'author', kind: 'object', type: 'users' },
            });
            try {
                await model.delete(1);
                expect(mockPrismaModel.delete).toHaveBeenLastCalledWith(expect.objectContaining({ select: { id: true, title: true } }));
            } finally {
                fields.mockRestore();
            }
        });

        it('should throw 403 when delete filter is false', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getDeleteFilter: () => false } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            await expect(m.delete(1))
                .rejects.toMatchObject({ status_code: 403 });
        });

        it('should handle soft delete via middleware', async () => {
            modelMiddleware.use('before', 'delete', async (ctx) => {
                return { ...ctx, softDelete: true, data: { deletedAt: new Date() } };
            });

            mockPrismaModel.update.mockResolvedValue({ id: 1, deletedAt: new Date() });
            const result = await model.delete(1);
            expect(result).toBeDefined();
            expect(mockPrismaModel.update).toHaveBeenCalled();
            expect(mockPrismaModel.delete).not.toHaveBeenCalled();
        });

        it('should execute before/after middleware', async () => {
            const order: string[] = [];
            modelMiddleware.use('before', 'delete', async (ctx) => { order.push('before'); return ctx; });
            modelMiddleware.use('after', 'delete', async (ctx) => { order.push('after'); return ctx; });
            mockPrismaModel.delete.mockResolvedValue({ id: 1 });
            await model.delete(1);
            expect(order).toEqual(['before', 'after']);
        });
    });

    describe('_count()', () => {
        it('should return count', async () => {
            mockPrismaModel.count.mockResolvedValue(42);
            const result = await model.count({ status: 'active' });
            expect(result).toBe(42);
        });

        it('should return 0 for empty result', async () => {
            mockPrismaModel.count.mockResolvedValue(0);
            expect(await model.count()).toBe(0);
        });

        it('should execute middleware', async () => {
            const spy = jest.fn(async (ctx: any) => ctx);
            modelMiddleware.use('before', 'count', spy);
            mockPrismaModel.count.mockResolvedValue(5);
            await model.count();
            expect(spy).toHaveBeenCalled();
        });

        it('should abort if middleware sets abort', async () => {
            modelMiddleware.use('before', 'count', async (ctx) => {
                return { ...ctx, abort: true, result: 99 };
            });
            const result = await model.count();
            expect(result).toBe(99);
            expect(mockPrismaModel.count).not.toHaveBeenCalled();
        });
    });

    describe('_upsert()', () => {
        it('should call prisma upsert', async () => {
            mockPrismaModel.upsert.mockResolvedValue({ id: 1, title: 'Upserted' });
            const result = await model.upsert({ id: 1, title: 'Upserted' });
            expect(result).toEqual({ id: 1, title: 'Upserted' });
        });

        it('should execute middleware', async () => {
            const spy = jest.fn(async (ctx: any) => ctx);
            modelMiddleware.use('before', 'upsert', spy);
            mockPrismaModel.upsert.mockResolvedValue({ id: 1 });
            await model.upsert({ id: 1, title: 'Test' });
            expect(spy).toHaveBeenCalled();
        });

        it('should throw 403 when canCreate denies', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { canCreate: () => false } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            await expect(m.upsert({ id: 1, title: 'Test' }))
                .rejects.toMatchObject({ status_code: 403 });
            expect(mockPrismaModel.upsert).not.toHaveBeenCalled();
        });

        it('should throw 403 when getUpdateFilter returns false', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getUpdateFilter: () => false } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            await expect(m.upsert({ id: 1, title: 'Test' }))
                .rejects.toMatchObject({ status_code: 403 });
            expect(mockPrismaModel.upsert).not.toHaveBeenCalled();
        });

        it('should merge update filter into where clause with unique key at top level', async () => {
            // Prisma WhereUniqueInput requires a unique field at the TOP level;
            // the ACL filter is nested under AND
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getUpdateFilter: (user: any) => ({ authorId: user.id }) } }
            });
            const m = new Model('posts', { user: { id: 5, role: 'user' } });
            mockPrismaModel.upsert.mockResolvedValue({ id: 1, title: 'Test' });
            await m.upsert({ id: 1, title: 'Test' });
            const callArgs = mockPrismaModel.upsert.mock.calls[0][0];
            expect(callArgs.where.id).toBe(1);
            expect(callArgs.where.AND).toEqual([{ authorId: 5 }]);
        });

        it('should merge update filter with OR condition using nested AND', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getUpdateFilter: () => ({ OR: [{ role: 'editor' }, { role: 'admin' }] }) } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'editor' } });
            mockPrismaModel.upsert.mockResolvedValue({ id: 1, title: 'Test' });
            await m.upsert({ id: 1, title: 'Test' });
            const callArgs = mockPrismaModel.upsert.mock.calls[0][0];
            expect(callArgs.where.id).toBe(1);
            expect(callArgs.where.AND).toEqual([{ OR: [{ role: 'editor' }, { role: 'admin' }] }]);
        });

        it('should not wrap where in AND when update filter is empty', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getUpdateFilter: () => ({}) } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'admin' } });
            mockPrismaModel.upsert.mockResolvedValue({ id: 1, title: 'Test' });
            await m.upsert({ id: 1, title: 'Test' });
            const callArgs = mockPrismaModel.upsert.mock.calls[0][0];
            expect(callArgs.where.AND).toBeUndefined();
            expect(callArgs.where.id).toBe(1);
        });

        it('should allow upsert for application role regardless of ACL', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { canCreate: () => false, getUpdateFilter: () => false } }
            });
            const m = new Model('posts', { user: createSystemUser({ id: 'sys' }) });
            mockPrismaModel.upsert.mockResolvedValue({ id: 1 });
            const result = await m.upsert({ id: 1, title: 'Test' });
            expect(result).toEqual({ id: 1 });
        });
    });

    describe('_upsertMany()', () => {
        it('should return empty result for empty array', async () => {
            const result = await model.upsertMany([]);
            expect(result).toEqual({
                created: 0, updated: 0, skipped: 0, failed: [], totalSuccess: 0, totalFailed: 0
            });
        });

        it('should create new records', async () => {
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.createMany.mockResolvedValue({ count: 2 });

            const result = await model.upsertMany([
                { id: 1, title: 'Post 1' },
                { id: 2, title: 'Post 2' },
            ]);
            expect(result.created).toBe(2);
            expect(result.updated).toBe(0);
        });

        it('should update existing records', async () => {
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1 }]);
            mockPrismaModel.updateMany.mockResolvedValue({ count: 1 });

            const result = await model.upsertMany([
                { id: 1, title: 'Updated' },
            ]);
            expect(result.updated).toBe(1);
            expect(result.created).toBe(0);
            // Plain columns: one updateMany, no update (which would read the row back)
            expect(mockPrismaModel.updateMany).toHaveBeenCalledWith({ where: { id: 1 }, data: { title: 'Updated' } });
            expect(mockPrismaModel.update).not.toHaveBeenCalled();
        });

        it('should accept null prismaOptions as no options', async () => {
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1 }]);
            mockPrismaModel.updateMany.mockResolvedValue({ count: 1 });

            const result = await model.upsertMany([{ id: 1, title: 'Updated' }], 'id', null as any);
            expect(result.updated).toBe(1);
            expect(mockPrismaModel.updateMany).toHaveBeenCalledWith({ where: { id: 1 }, data: { title: 'Updated' } });
        });

        it('should fall back to update when updateMany matches no row, reporting it as before', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getUpdateFilter: (user: any) => ({ authorId: user.id }) } }
            });
            const m = new Model('posts', { user: { id: 7, role: 'user' } });
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1 }]);
            mockPrismaModel.updateMany.mockResolvedValue({ count: 0 });
            const notFound = Object.assign(new Error('No record was found for an update.'), { code: 'P2025' });
            mockPrismaModel.update.mockRejectedValue(notFound);

            const result = await m.upsertMany([{ id: 1, title: 'Updated' }]);
            expect(mockPrismaModel.update).toHaveBeenCalledWith({ where: { id: 1, AND: [{ authorId: 7 }] }, data: { title: 'Updated' } });
            expect(result).toMatchObject({ updated: 0, totalFailed: 1 });
            expect(result.failed[0]).toEqual({ record: { title: 'Updated' }, error: notFound });
        });

        it('should handle mixed create and update', async () => {
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1 }]);
            mockPrismaModel.createMany.mockResolvedValue({ count: 1 });
            mockPrismaModel.updateMany.mockResolvedValue({ count: 1 });

            const result = await model.upsertMany([
                { id: 1, title: 'Updated' },
                { id: 2, title: 'New' },
            ]);
            expect(result.created).toBe(1);
            expect(result.updated).toBe(1);
        });

        it('should execute middleware', async () => {
            const spy = jest.fn(async (ctx: any) => ctx);
            modelMiddleware.use('before', 'upsertMany', spy);
            const result = await model.upsertMany([]);
            expect(result.totalSuccess).toBe(0);
        });

        it('should throw 403 when canCreate denies and a record would be created', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { canCreate: () => false } }
            });
            // Record does not exist -> upsertMany would create it -> 403
            mockPrismaModel.findMany.mockResolvedValue([]);
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            await expect(m.upsertMany([{ id: 99, title: 'Test' }]))
                .rejects.toMatchObject({ status_code: 403 });
        });

        it('should allow update-only upsertMany when canCreate denies but records exist', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { canCreate: () => false } }
            });
            // Record exists -> upsertMany only updates -> no create permission needed
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1 }]);
            mockPrismaModel.updateMany.mockResolvedValue({ count: 1 });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            const result = await m.upsertMany([{ id: 1, title: 'Test' }]);
            expect(result.updated).toBe(1);
            expect(result.created).toBe(0);
        });

        it('should throw 403 when getUpdateFilter returns false', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getUpdateFilter: () => false } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            await expect(m.upsertMany([{ id: 1, title: 'Test' }]))
                .rejects.toMatchObject({ status_code: 403 });
            expect(mockPrismaModel.findMany).not.toHaveBeenCalled();
        });

        it('should merge update filter into batch update where clause with AND', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getUpdateFilter: (user: any) => ({ authorId: user.id }) } }
            });
            const m = new Model('posts', { user: { id: 7, role: 'user' } });
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1 }]);
            mockPrismaModel.updateMany.mockResolvedValue({ count: 1 });

            await m.upsertMany([{ id: 1, title: 'Updated' }]);
            const updateCall = mockPrismaModel.updateMany.mock.calls[0][0];
            // Unique key stays at top level; ACL filter nested under AND (the shape update's WhereUniqueInput requires)
            expect(updateCall.where.id).toBe(1);
            expect(updateCall.where.AND).toEqual([{ authorId: 7 }]);
        });

        it('should merge update filter with OR into batch update using nested AND', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getUpdateFilter: () => ({ OR: [{ status: 'draft' }, { status: 'review' }] }) } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'editor' } });
            mockPrismaModel.findMany.mockResolvedValue([{ id: 3 }]);
            mockPrismaModel.updateMany.mockResolvedValue({ count: 1 });

            await m.upsertMany([{ id: 3, title: 'Updated' }]);
            const updateCall = mockPrismaModel.updateMany.mock.calls[0][0];
            expect(updateCall.where.id).toBe(3);
            expect(updateCall.where.AND).toEqual([{ OR: [{ status: 'draft' }, { status: 'review' }] }]);
        });

        it('should not wrap where in AND when update filter is empty', async () => {
            mockPrismaModel.findMany.mockResolvedValue([{ id: 1 }]);
            mockPrismaModel.updateMany.mockResolvedValue({ count: 1 });

            await model.upsertMany([{ id: 1, title: 'Updated' }]);
            const updateCall = mockPrismaModel.updateMany.mock.calls[0][0];
            expect(updateCall.where.AND).toBeUndefined();
            expect(updateCall.where.id).toBe(1);
        });

        it('should allow upsertMany for application role regardless of ACL', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { canCreate: () => false, getUpdateFilter: () => false } }
            });
            const m = new Model('posts', { user: createSystemUser({ id: 'sys' }) });
            mockPrismaModel.findMany.mockResolvedValue([]);
            mockPrismaModel.createMany.mockResolvedValue({ count: 1 });
            const result = await m.upsertMany([{ id: 1, title: 'Test' }]);
            expect(result.created).toBe(1);
        });

        it('should skip ACL on empty array (no permission check needed)', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { canCreate: () => false, getUpdateFilter: () => false } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            const result = await m.upsertMany([]);
            // Empty array returns early before ACL checks
            expect(result.totalSuccess).toBe(0);
        });
    });

    // ── Model Name Setter ────────────────────────────────────

    describe('strictWrites / assertWritable', () => {
        it('should reject non-writable fields on create when strictWrites is on', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getWritableFields: () => ['title'] } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'user' }, strictWrites: true });
            await expect(m.create({ title: 'a', status: 'x' }))
                .rejects.toMatchObject({ status_code: 403, data: { fields: ['status'] } });
        });

        it('should reject omitted fields on update when strictWrites is on', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getOmitFields: () => ['status'] } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'user' }, strictWrites: true });
            await expect(m.update(1, { title: 'a', status: 'x' }))
                .rejects.toMatchObject({ status_code: 403, data: { fields: ['status'] } });
        });

        it('should silently strip non-writable fields when strictWrites is off', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getWritableFields: () => ['title'] } }
            });
            mockPrismaModel.create.mockResolvedValue({ id: 1, title: 'a' });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            await m.create({ title: 'a', status: 'x' });
            const callArgs = mockPrismaModel.create.mock.calls[0][0];
            expect(callArgs.data.title).toBe('a');
            expect(callArgs.data.status).toBeUndefined();
        });

        it('should bypass strict checks and stripping for the application role', async () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getWritableFields: () => ['title'] } }
            });
            mockPrismaModel.create.mockResolvedValue({ id: 1 });
            const m = new Model('posts', { strictWrites: true }); // no user -> application role
            await expect(m.create({ title: 'a', status: 'x' })).resolves.toBeDefined();
            const callArgs = mockPrismaModel.create.mock.calls[0][0];
            expect(callArgs.data.status).toBe('x');
        });

        it('assertWritable should list all offending fields', () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getWritableFields: () => ['title'], getOmitFields: () => ['authorId'] } }
            });
            const m = new Model('posts', { user: { id: 1, role: 'user' } });
            let err: any;
            try {
                m.assertWritable({ title: 'ok', status: 'x', authorId: 9 });
            } catch (e) {
                err = e;
            }
            expect(err).toBeDefined();
            expect(err.status_code).toBe(403);
            expect(err.data.fields).toEqual(['status', 'authorId']);
        });

        it('getWritableFields should return null for the application role', () => {
            (getAcl as jest.Mock).mockReturnValue({
                model: { posts: { getWritableFields: () => ['title'] } }
            });
            const m = new Model('posts', {});
            expect(m.getWritableFields()).toBeNull();
        });
    });

    describe('modelName setter', () => {
        it('should update model name and prisma delegate', () => {
            model.modelName = 'users';
            expect(model.name).toBe('users');
        });
    });

    // ── Static Properties ────────────────────────────────────

    describe('static properties', () => {
        it('should expose ErrorResponse', () => {
            expect(Model.Error).toBe(ErrorResponse);
        });

        it('should expose middleware', () => {
            expect(Model.middleware).toBe(modelMiddleware);
        });

        it('should expose prismaTransaction', () => {
            expect(Model.prismaTransaction).toBeDefined();
        });
    });
});
