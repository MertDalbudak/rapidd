/**
 * Model write paths against a REAL DMMF (built from the schema below by @prisma/internals) and a
 * simulated database: id coercion, compound key selectors, ACL on raw Prisma nested operations,
 * and upsertMany under PostgreSQL transaction semantics (a failed statement aborts the
 * transaction until ROLLBACK TO SAVEPOINT; committing an aborted transaction rolls it back).
 */

const SCHEMA = `
datasource db {
  provider = "postgresql"
}
model Item {
  id     Int     @id
  name   String  @unique
  qty    Int     @default(0)
  owner  Int?
  secret String?
  tags   Tag[]
}
model Tag {
  id     Int    @id @default(autoincrement())
  label  String
  itemId Int
  item   Item   @relation(fields: [itemId], references: [id])
  secret String @default("s")
}
model Member {
  orgId  Int
  userId Int
  role   String
  @@id([orgId, userId], name: "pk")
}
model Slot {
  id   Int @id
  day  Int
  room Int
  @@unique([room, day])
}
model Doc {
  id    String @id @default(uuid()) @db.Uuid
  title String
}
model Big {
  id BigInt @id
}
model Price {
  id Decimal @id
}
model Day {
  id DateTime @id
}
`;

jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        readFileSync: (file: any, ...rest: any[]) => String(file).endsWith('schema.prisma') ? SCHEMA : actual.readFileSync(file, ...rest),
    };
});

// Model delegates shared by the client and transactions; a transaction wraps them with
// the simulated database semantics
const mockDelegates: Record<string, Record<string, jest.Mock>> = {};
const mockDelegate = (model: string) => (mockDelegates[model] ??= {
    findUnique: jest.fn(), findMany: jest.fn(async () => []), create: jest.fn(async () => ({})),
    createMany: jest.fn(async ({ data }: any) => ({ count: data.length })), update: jest.fn(async () => ({})),
    upsert: jest.fn(async () => ({})), count: jest.fn(async () => 0), delete: jest.fn(async () => ({})),
});
const mockDb = { provider: 'postgresql', statements: [] as string[], commits: 0 };
const mockAcl: { model: Record<string, any> } = { model: {} };

jest.mock('../../src/core/prisma', () => {
    const transaction = () => {
        const state = { aborted: false };
        const aborted = () => Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' });
        const tx: any = {
            $executeRawUnsafe: async (sql: string) => {
                mockDb.statements.push(sql);
                if (sql.startsWith('ROLLBACK TO SAVEPOINT')) state.aborted = false;
                else if (state.aborted) throw aborted();
                return 0;
            },
        };
        return {
            state,
            tx: new Proxy(tx, {
                get: (target, model: string) => target[model] ?? new Proxy({}, {
                    get: (_d, op: string) => async (...args: any[]) => {
                        if (state.aborted) throw aborted();
                        try {
                            return await mockDelegate(model)[op](...args);
                        } catch (error) {
                            // PostgreSQL: any statement error aborts the transaction
                            if (mockDb.provider === 'postgresql') state.aborted = true;
                            throw error;
                        }
                    },
                }),
            }),
        };
    };
    return {
        rlsActive: () => false,
        get dbProvider() { return mockDb.provider; },
        prisma: new Proxy({}, { get: (_t, model: string) => mockDelegate(model) }),
        prismaTransaction: jest.fn(async (fn: any) => {
            const { state, tx } = transaction();
            const result = await fn(tx);
            if (state.aborted) throw new Error('COMMIT of an aborted transaction rolled back');
            mockDb.commits++;
            return result;
        }),
        getAcl: () => mockAcl,
    };
});

import { loadDMMF } from '../../src/core/dmmf';
import { Model } from '../../src/orm/Model';
import { QueryBuilder } from '../../src/orm/QueryBuilder';
import { Logger } from '../../src/utils/Logger';

const user = { id: 7, role: 'user' };
const conflict = () => Object.assign(new Error('Unique constraint failed on the fields: (`name`)'), { code: 'P2002' });

beforeAll(async () => {
    await loadDMMF();
});

beforeEach(() => {
    for (const delegate of Object.values(mockDelegates)) {
        for (const fn of Object.values(delegate)) fn.mockClear();
    }
    for (const key of Object.keys(mockDelegates)) delete mockDelegates[key];
    for (const key of Object.keys(mockAcl.model)) delete mockAcl.model[key];
    mockDb.provider = 'postgresql';
    mockDb.statements = [];
    mockDb.commits = 0;
});

describe('buildWhereId — coercion by key type', () => {
    it.each([
        ['Item', '42', { id: 42 }],
        ['Big', '9007199254740993', { id: 9007199254740993n }],
        ['Price', '19.990', { id: '19.990' }],
        ['Doc', 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11', { id: 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11' }],
    ])('%s %p', (model, id, where) => {
        expect(new Model(model).buildWhereId(id)).toEqual(where);
    });

    it('DateTime keys become Dates', () => {
        expect(new Model('Day').buildWhereId('2024-03-15T10:00:00Z')).toEqual({ id: new Date('2024-03-15T10:00:00Z') });
    });

    it.each([
        ['Item', '4.2'], ['Item', 'NaN'], ['Big', '1e3'], ['Price', 'abc'], ['Doc', 'not-a-uuid'], ['Day', 'yesterday'],
    ])('%s %p → 400 invalid_id', (model, id) => {
        expect(() => new Model(model).buildWhereId(id)).toThrow(expect.objectContaining({ status_code: 400, message: 'invalid_id' }));
    });

    it('numbers: BigInt keys refuse unsafe integers instead of rounding them', () => {
        expect(new Model('Big').buildWhereId(5)).toEqual({ id: 5n });
        expect(() => new Model('Big').buildWhereId(2 ** 53 + 2)).toThrow(expect.objectContaining({ message: 'invalid_id' }));
    });

    it('composite keys use the schema\'s selector name and coerce every part', () => {
        expect(new Model('Member').buildWhereId('1~2')).toEqual({ pk: { orgId: 1, userId: 2 } });
        expect(new Model('Member').buildWhereId({ orgId: '3', userId: 4, extra: 'ignored' })).toEqual({ pk: { orgId: 3, userId: 4 } });
        expect(() => new Model('Member').buildWhereId('1~x')).toThrow(expect.objectContaining({ message: 'invalid_id' }));
    });

    it('buildWhereUniqueKey follows the @@unique field order', () => {
        expect(new Model('Slot').buildWhereUniqueKey(['day', 'room'], { day: 1, room: 2 })).toEqual({ room_day: { day: 1, room: 2 } });
    });
});

describe('raw Prisma nested operations follow the related model ACL', () => {
    const updateData = () => mockDelegates.Item.update.mock.calls[0][0].data;

    it('connect is scoped by the access filter', async () => {
        mockAcl.model.Tag = { getAccessFilter: () => ({ label: 'mine' }) };
        await new Model('Item', { user }).update(1, { tags: { connect: [{ id: 5 }] } });
        expect(updateData().tags).toEqual({ connect: [{ id: 5, AND: [{ label: 'mine' }] }] });
    });

    it('deleteMany under a false delete filter is refused before any query', async () => {
        mockAcl.model.Tag = { getDeleteFilter: () => false };
        await expect(new Model('Item', { user }).update(1, { tags: { deleteMany: {} } }))
            .rejects.toMatchObject({ status_code: 403, message: 'no_permission_to_delete' });
        expect(mockDelegate('Item').update).not.toHaveBeenCalled();
    });

    it('nested creates are checked and cleaned, recursively', async () => {
        mockAcl.model.Tag = { getOmitFields: () => ['secret'], canCreate: (_u: any, data: any) => data.label !== 'forbidden' };
        await new Model('Item', { user }).create({ id: 1, name: 'a', tags: { create: [{ label: 'x', secret: 'leak' }] } });
        expect(mockDelegates.Item.create.mock.calls[0][0].data.tags).toEqual({ create: [{ label: 'x' }] });

        await expect(new Model('Item', { user }).create({ id: 2, name: 'b', tags: { create: { label: 'forbidden' } } }))
            .rejects.toMatchObject({ status_code: 403, message: 'no_permission_to_create' });
    });

    it('strictWrites rejects non-writable fields inside raw payloads', async () => {
        mockAcl.model.Tag = { getWritableFields: () => ['label'] };
        await expect(new Model('Item', { user, strictWrites: true }).update(1, { tags: { update: { where: { id: 3 }, data: { secret: 'x' } } } }))
            .rejects.toMatchObject({ status_code: 403, message: 'fields_not_writable' });
    });

    it('the system user bypasses it', async () => {
        mockAcl.model.Tag = { getDeleteFilter: () => false, getAccessFilter: () => false };
        await new Model('Item').update(1, { tags: { deleteMany: {}, connect: { id: 5 } } });
        expect(updateData().tags).toEqual({ deleteMany: {}, connect: { id: 5 } });
    });
});

describe('QueryBuilder.update', () => {
    it('drops the record\'s own unchanged key (invalid in Prisma\'s checked input) but keeps a changed one', () => {
        const qb = new QueryBuilder('Tag');
        expect(qb.update(5, { id: 5, label: 'x', itemId: 1 })).toEqual({ label: 'x', item: { connect: { id: 1 } } });
        expect(qb.update(5, { id: '5', label: 'x' })).toEqual({ label: 'x' });
        expect(qb.update(5, { id: 6, label: 'x' })).toEqual({ id: 6, label: 'x' });
    });
});

describe('upsertMany', () => {
    const items = (...rows: [number, string][]) => rows.map(([id, name]) => ({ id, name }));

    it('PostgreSQL: a failing record is contained by a savepoint; the report matches what commits', async () => {
        mockDelegate('Item').findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
        mockDelegate('Item').update.mockImplementation(async ({ where }: any) => {
            if (where.id === 2) throw conflict();
            return {};
        });

        const result = await new Model('Item').upsertMany(items([1, 'a'], [2, 'a'], [3, 'c']));
        expect(result).toMatchObject({ created: 0, updated: 2, totalFailed: 1, totalSuccess: 2 });
        expect(mockDb.commits).toBe(1);
        // One savepoint for the chunk; it failed → rolled back and replayed record by record
        expect(mockDb.statements.filter((s) => s.startsWith('ROLLBACK TO SAVEPOINT'))).toHaveLength(2);
    });

    it('PostgreSQL: a happy batch costs one savepoint per chunk, not per record', async () => {
        mockDelegate('Item').findMany.mockResolvedValue(Array.from({ length: 250 }, (_, i) => ({ id: i + 1 })));
        await new Model('Item').upsertMany(Array.from({ length: 250 }, (_, i) => ({ id: i + 1, name: `n${i}` })));
        expect(mockDb.statements.filter((s) => s.startsWith('SAVEPOINT'))).toHaveLength(3); // chunks of 100
    });

    it('MySQL rolls back only the failed statement: no savepoints', async () => {
        mockDb.provider = 'mysql';
        mockDelegate('Item').findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
        mockDelegate('Item').update.mockImplementation(async ({ where }: any) => {
            if (where.id === 1) throw conflict();
            return {};
        });
        const result = await new Model('Item').upsertMany(items([1, 'x'], [2, 'y']));
        expect(result).toMatchObject({ updated: 1, totalFailed: 1 });
        expect(mockDb.statements).toEqual([]);
    });

    it('deadlocks and write conflicts fail the batch instead of being reported as one record', async () => {
        mockDelegate('Item').findMany.mockResolvedValue([{ id: 1 }]);
        mockDelegate('Item').update.mockRejectedValue(Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { code: 'P2034' }));
        await expect(new Model('Item').upsertMany(items([1, 'a']))).rejects.toMatchObject({ code: 'P2034' });
    });

    it('a failed createMany is contained and counts all of its records', async () => {
        mockDelegate('Item').findMany.mockResolvedValue([{ id: 1 }]);
        mockDelegate('Item').createMany.mockRejectedValue(Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' }));
        const result = await new Model('Item').upsertMany(items([1, 'a'], [2, 'b'], [3, 'c']));
        expect(result).toMatchObject({ created: 0, updated: 1, totalFailed: 2 });
        expect(mockDb.commits).toBe(1);
    });

    it('rows createMany skips on a unique conflict are counted', async () => {
        mockDelegate('Item').createMany.mockResolvedValue({ count: 1 });
        const result = await new Model('Item').upsertMany(items([1, 'a'], [2, 'a']));
        expect(result).toMatchObject({ created: 1, skipped: 1 });
    });

    it('a key repeated within the batch updates the row the batch creates', async () => {
        const result = await new Model('Item').upsertMany([{ id: 1, name: 'first' }, { id: 1, name: 'second' }]);
        expect(mockDelegates.Item.createMany.mock.calls[0][0].data).toEqual([{ id: 1, name: 'first' }]);
        expect(mockDelegates.Item.update.mock.calls[0][0]).toMatchObject({ where: { id: 1 }, data: { name: 'second' } });
        expect(result).toMatchObject({ created: 1, updated: 1 });
    });

    it('existence is looked up in chunks of 1000 keys', async () => {
        await new Model('Item').upsertMany(Array.from({ length: 2500 }, (_, i) => ({ id: i + 1, name: `n${i}` })));
        expect(mockDelegates.Item.findMany.mock.calls.map(([args]: any) => args.where.id.in.length)).toEqual([1000, 1000, 500]);
    });

    it('createMany rows are stripped of fields the user may not write', async () => {
        mockAcl.model.Item = { getOmitFields: () => ['secret'], getWritableFields: () => ['id', 'name', 'secret'] };
        await new Model('Item', { user }).upsertMany([{ id: 1, name: 'a', secret: 'x', qty: 5 }]);
        expect(mockDelegates.Item.createMany.mock.calls[0][0].data).toEqual([{ id: 1, name: 'a' }]);
    });

    it('composite keys: plain-field lookup, the named selector for updates, and the PK as default key', async () => {
        mockDelegate('Member').findMany.mockResolvedValue([{ orgId: 1, userId: 1 }]);
        const result = await new Model('Member').upsertMany([{ orgId: 1, userId: 1, role: 'admin' }, { orgId: 1, userId: 2, role: 'member' }]);
        expect(mockDelegates.Member.findMany.mock.calls[0][0].where).toEqual({ OR: [{ orgId: 1, userId: 1 }, { orgId: 1, userId: 2 }] });
        expect(mockDelegates.Member.update.mock.calls[0][0].where).toEqual({ pk: { orgId: 1, userId: 1 } });
        expect(result).toMatchObject({ created: 1, updated: 1 });
    });
});

describe('getMany scoping', () => {
    const where = () => mockDelegates.Item.findMany.mock.calls[0][0].where;

    it('an object q is field equality, parsed by type', async () => {
        await new Model('Item').getMany({ q: { id: '5', owner: null } });
        expect(where()).toEqual({ id: 5, owner: null });
    });

    it('object q values are literal — operator syntax and objects are rejected, hidden fields refused', async () => {
        await expect(new Model('Item').getMany({ q: { id: 'gt:0' } })).rejects.toMatchObject({ status_code: 400, message: 'invalid_filter_value' });
        await expect(new Model('Item').getMany({ q: { name: { startsWith: 'a' } } })).rejects.toMatchObject({ status_code: 400 });
        await expect(new Model('Item').getMany({ q: { tags: 1 } })).rejects.toMatchObject({ status_code: 400, message: 'invalid_filter_field' });
        mockAcl.model.Item = { getOmitFields: () => ['secret'] };
        await expect(new Model('Item', { user }).getMany({ q: { secret: 'x' } })).rejects.toMatchObject({ status_code: 403 });
    });

    it('repeated ?q= parameters are AND-ed instead of dropped', async () => {
        await new Model('Item').getMany({ q: ['qty=5', 'owner=7'] });
        expect(where()).toEqual({ qty: { equals: 5 }, owner: { equals: 7 } });
    });

    it('where is a server-side scope AND-ed with the client filter and the ACL', async () => {
        mockAcl.model.Item = { getAccessFilter: (u: any) => ({ owner: u.id }) };
        const m = new Model('Item', { user });
        await m.getMany({ q: 'qty=5', where: { name: 'a' } });
        expect(where()).toEqual({ AND: [{ AND: [{ qty: { equals: 5 } }, { owner: 7 }] }, { name: 'a' }] });
        expect(mockDelegates.Item.count.mock.calls[0][0].where).toEqual(where());
    });

    it('parseKey parses a URL segment by the field type', () => {
        expect(new Model('Member').parseKey('orgId', '12')).toBe(12);
        expect(() => new Model('Member').parseKey('orgId', 'gt:0')).toThrow(expect.objectContaining({ status_code: 400, message: 'invalid_id' }));
    });
});

describe('error logging', () => {
    it('client errors log at warn, server errors at error', () => {
        const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
        const error = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
        try {
            QueryBuilder.errorHandler(Object.assign(new Error('not found'), { code: 'P2025' }));
            expect(warn).toHaveBeenCalledTimes(1);
            expect(error).not.toHaveBeenCalled();

            QueryBuilder.errorHandler(new TypeError('boom'));
            expect(error).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
            error.mockRestore();
        }
    });
});
