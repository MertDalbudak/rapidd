import { isRawOperation, rawOperationPayloads, secureNestedOperations, NestedOperationContext } from '../../src/orm/nestedOperations';
import { ErrorResponse } from '../../src/core/errors';
import type { RelationConfig } from '../../src/types';

const list: RelationConfig = { name: 'tags', object: 'Tag', isList: true } as RelationConfig;
const single: RelationConfig = { name: 'author', object: 'User', isList: false } as RelationConfig;

const ctx = (overrides: Partial<NestedOperationContext> = {}): NestedOperationContext => ({
    accessFilter: null,
    updateFilter: null,
    deleteFilter: null,
    canCreate: () => true,
    cleanData: (data) => {
        const { secret, ...rest } = data;
        return rest;
    },
    ...overrides,
});

const rejects = (fn: () => unknown, key: string) => {
    try {
        fn();
    } catch (e) {
        expect(e).toBeInstanceOf(ErrorResponse);
        expect((e as ErrorResponse).status_code).toBe(403);
        expect((e as ErrorResponse).message).toBe(key);
        return;
    }
    throw new Error(`expected ${key}`);
};

describe('isRawOperation', () => {
    it('recognizes Prisma nested-write keys, including delete', () => {
        expect(isRawOperation({ connect: { id: 1 } })).toBe(true);
        expect(isRawOperation({ delete: true })).toBe(true);
        expect(isRawOperation({ deleteMany: {} })).toBe(true);
    });

    it('is false for plain data, arrays and scalars', () => {
        expect(isRawOperation({ id: 1, name: 'x' })).toBe(false);
        expect(isRawOperation([{ connect: { id: 1 } }])).toBe(false);
        expect(isRawOperation(null)).toBe(false);
        expect(isRawOperation('connect')).toBe(false);
    });
});

describe('secureNestedOperations', () => {
    it('passes everything through when no filter restricts', () => {
        const ops = { connect: [{ id: 1 }], deleteMany: {}, update: [{ where: { id: 2 }, data: { label: 'x' } }] };
        expect(secureNestedOperations(ops, list, ctx())).toEqual(ops);
    });

    describe('connect / set / disconnect — access filter', () => {
        const scoped = ctx({ accessFilter: { ownerId: 7 } });

        it('scopes each unique target, keeping the unique key at the top level', () => {
            expect(secureNestedOperations({ connect: [{ id: 1 }, { id: 2 }] }, list, scoped)).toEqual({
                connect: [{ id: 1, AND: [{ ownerId: 7 }] }, { id: 2, AND: [{ ownerId: 7 }] }],
            });
            expect(secureNestedOperations({ set: { id: 1 } }, list, scoped)).toEqual({ set: { id: 1, AND: [{ ownerId: 7 }] } });
        });

        it('keeps a client AND next to the ACL condition instead of overwriting it', () => {
            expect(secureNestedOperations({ connect: { id: 1, AND: { label: 'a' } } }, list, scoped)).toEqual({
                connect: { id: 1, AND: [{ label: 'a' }, { ownerId: 7 }] },
            });
        });

        it('to-one disconnect: true passes, a where is scoped', () => {
            expect(secureNestedOperations({ disconnect: true }, single, scoped)).toEqual({ disconnect: true });
            expect(secureNestedOperations({ disconnect: { name: 'x' } }, single, scoped)).toEqual({
                disconnect: { AND: [{ name: 'x' }, { ownerId: 7 }] },
            });
        });

        it('a false access filter rejects', () => {
            rejects(() => secureNestedOperations({ connect: { id: 1 } }, list, ctx({ accessFilter: false })), 'no_permission');
            rejects(() => secureNestedOperations({ disconnect: [{ id: 1 }] }, list, ctx({ accessFilter: false })), 'no_permission');
        });
    });

    describe('create / createMany / connectOrCreate — canCreate + cleaning', () => {
        it('cleans created data and checks canCreate per item', () => {
            const seen: any[] = [];
            const out = secureNestedOperations(
                { create: [{ label: 'a', secret: 1 }, { label: 'b' }] },
                list,
                ctx({ canCreate: (d) => { seen.push(d); return true; } })
            );
            expect(out).toEqual({ create: [{ label: 'a' }, { label: 'b' }] });
            expect(seen).toHaveLength(2);
        });

        it('rejects when canCreate denies', () => {
            rejects(() => secureNestedOperations({ create: { label: 'a' } }, list, ctx({ canCreate: () => false })), 'no_permission_to_create');
            rejects(() => secureNestedOperations({ createMany: { data: [{ label: 'a' }] } }, list, ctx({ canCreate: () => false })), 'no_permission_to_create');
        });

        it('createMany keeps its options', () => {
            expect(secureNestedOperations({ createMany: { data: [{ label: 'a', secret: 1 }], skipDuplicates: true } }, list, ctx()))
                .toEqual({ createMany: { data: [{ label: 'a' }], skipDuplicates: true } });
        });

        it('connectOrCreate scopes the where and cleans the create', () => {
            expect(secureNestedOperations(
                { connectOrCreate: { where: { id: 1 }, create: { label: 'a', secret: 1 } } },
                list,
                ctx({ accessFilter: { ownerId: 7 } })
            )).toEqual({ connectOrCreate: { where: { id: 1, AND: [{ ownerId: 7 }] }, create: { label: 'a' } } });
        });
    });

    describe('update / updateMany / upsert — update filter', () => {
        const scoped = ctx({ updateFilter: { ownerId: 7 } });

        it('list update: scoped unique where, cleaned data', () => {
            expect(secureNestedOperations({ update: { where: { id: 1 }, data: { label: 'x', secret: 1 } } }, list, scoped))
                .toEqual({ update: { where: { id: 1, AND: [{ ownerId: 7 }] }, data: { label: 'x' } } });
        });

        it('to-one update: plain data gains a where only when a filter applies', () => {
            expect(secureNestedOperations({ update: { name: 'x', secret: 1 } }, single, ctx())).toEqual({ update: { name: 'x' } });
            expect(secureNestedOperations({ update: { name: 'x' } }, single, scoped))
                .toEqual({ update: { where: { ownerId: 7 }, data: { name: 'x' } } });
            expect(secureNestedOperations({ update: { where: { active: true }, data: { name: 'x' } } }, single, scoped))
                .toEqual({ update: { where: { AND: [{ active: true }, { ownerId: 7 }] }, data: { name: 'x' } } });
        });

        it('updateMany: AND-combined where', () => {
            expect(secureNestedOperations({ updateMany: { where: { label: 'a' }, data: { label: 'b' } } }, list, scoped))
                .toEqual({ updateMany: { where: { AND: [{ label: 'a' }, { ownerId: 7 }] }, data: { label: 'b' } } });
        });

        it('upsert: scoped target, checked create, cleaned update', () => {
            expect(secureNestedOperations(
                { upsert: { where: { id: 1 }, create: { label: 'n', secret: 1 }, update: { label: 'u', secret: 1 } } },
                list,
                scoped
            )).toEqual({ upsert: { where: { id: 1, AND: [{ ownerId: 7 }] }, create: { label: 'n' }, update: { label: 'u' } } });
            rejects(() => secureNestedOperations({ upsert: { where: { id: 1 }, create: {}, update: {} } }, list, ctx({ canCreate: () => false })), 'no_permission_to_create');
        });

        it('a false update filter rejects', () => {
            const denied = ctx({ updateFilter: false });
            rejects(() => secureNestedOperations({ update: { where: { id: 1 }, data: {} } }, list, denied), 'no_permission_to_update');
            rejects(() => secureNestedOperations({ updateMany: { where: {}, data: {} } }, list, denied), 'no_permission_to_update');
            rejects(() => secureNestedOperations({ upsert: { where: { id: 1 }, create: {}, update: {} } }, list, denied), 'no_permission_to_update');
        });
    });

    describe('delete / deleteMany — delete filter', () => {
        const scoped = ctx({ deleteFilter: { ownerId: 7 } });

        it('deleteMany {} is narrowed to the delete filter', () => {
            expect(secureNestedOperations({ deleteMany: {} }, list, scoped)).toEqual({ deleteMany: { ownerId: 7 } });
            expect(secureNestedOperations({ deleteMany: [{ label: 'a' }] }, list, scoped))
                .toEqual({ deleteMany: [{ AND: [{ label: 'a' }, { ownerId: 7 }] }] });
        });

        it('list delete scopes unique targets; to-one delete: true becomes a filter', () => {
            expect(secureNestedOperations({ delete: [{ id: 1 }] }, list, scoped)).toEqual({ delete: [{ id: 1, AND: [{ ownerId: 7 }] }] });
            expect(secureNestedOperations({ delete: true }, single, scoped)).toEqual({ delete: { ownerId: 7 } });
            expect(secureNestedOperations({ delete: true }, single, ctx())).toEqual({ delete: true });
        });

        it('a false delete filter rejects', () => {
            rejects(() => secureNestedOperations({ deleteMany: {} }, list, ctx({ deleteFilter: false })), 'no_permission_to_delete');
            rejects(() => secureNestedOperations({ delete: true }, single, ctx({ deleteFilter: false })), 'no_permission_to_delete');
        });
    });
});

describe('rawOperationPayloads', () => {
    it('returns what create / update / upsert would write', () => {
        const payloads = rawOperationPayloads({
            connect: { id: 1 },
            create: [{ a: 1 }],
            createMany: { data: [{ b: 1 }] },
            connectOrCreate: { where: { id: 2 }, create: { c: 1 } },
            update: [{ where: { id: 3 }, data: { d: 1 } }],
            updateMany: { where: {}, data: { e: 1 } },
            upsert: { where: { id: 4 }, create: { f: 1 }, update: { g: 1 } },
            deleteMany: {},
        }, true);
        expect(payloads).toEqual([{ a: 1 }, { b: 1 }, { c: 1 }, { d: 1 }, { e: 1 }, { f: 1 }, { g: 1 }]);
    });

    it('to-one update: plain data or the { where, data } form', () => {
        expect(rawOperationPayloads({ update: { name: 'x' } }, false)).toEqual([{ name: 'x' }]);
        expect(rawOperationPayloads({ update: { where: {}, data: { name: 'y' } } }, false)).toEqual([{ name: 'y' }]);
    });
});
