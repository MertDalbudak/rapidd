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
model Account {
  id       Int     @id @default(autoincrement())
  email    String  @unique
  password String
  logins   Login[]
}
model Login {
  id        Int      @id @default(autoincrement())
  at        DateTime @default(now())
  accountId Int
  account   Account  @relation(fields: [accountId], references: [id])
}
model Setting {
  key   String @unique
  value String
}
model Device {
  serial String? @unique
  vendor String
  model  String
  @@unique([vendor, model])
}
model Org {
  id      Int         @id
  members OrgMember[]
}
model OrgMember {
  orgId       Int
  userId      Int
  org         Org          @relation(fields: [orgId], references: [id])
  assignments Assignment[]
  @@id([orgId, userId])
}
model Assignment {
  id     Int        @id @default(autoincrement())
  orgId  Int?
  userId Int?
  note   String
  member OrgMember? @relation(fields: [orgId, userId], references: [orgId, userId])
}
model Customer {
  id     Int     @id
  orders Order[]
}
model Shop {
  id     Int     @id @default(autoincrement())
  orders Order[]
}
model Order {
  id          Int       @id @default(autoincrement())
  shop_id     Int
  customer_id Int?
  shop        Shop      @relation(fields: [shop_id], references: [id])
  customer    Customer? @relation(fields: [customer_id], references: [id])
  lines       Line[]
}
model Line {
  line_no  Int     @id
  order_id Int
  qty      Int
  note     String?
  order    Order   @relation(fields: [order_id], references: [id])
}
model Employee {
  id         Int        @id
  name       String
  manager_id Int?
  manager    Employee?  @relation("Reports", fields: [manager_id], references: [id])
  reports    Employee[] @relation("Reports")
}
model Batch {
  id       Int       @id
  readings Reading[]
}
model Reading {
  sensor   String
  day      DateTime @db.Date
  slot     Int
  value    Float
  batch_id Int?
  batch    Batch?   @relation(fields: [batch_id], references: [id])
  @@id([sensor, day, slot])
}
enum Status {
  ACTIVE
  RETIRED
}
model Product {
  sku    String  @id
  price  Decimal
  attrs  Json?
  status Status  @default(ACTIVE)
}
model TUser {
  tenant_id Int
  user_no   Int
  name      String
  projects  Project[]
  tasks     Task[]
  @@id([tenant_id, user_no])
}
model Project {
  tenant_id  Int
  project_no Int
  name       String
  owner_no   Int
  owner      TUser  @relation(fields: [tenant_id, owner_no], references: [tenant_id, user_no])
  tasks      Task[]
  @@id([tenant_id, project_no])
}
model Task {
  tenant_id   Int
  project_no  Int
  task_no     Int
  title       String
  assignee_no Int?
  project     Project     @relation(fields: [tenant_id, project_no], references: [tenant_id, project_no])
  assignee    TUser?      @relation(fields: [tenant_id, assignee_no], references: [tenant_id, user_no])
  labels      TaskLabel[]
  @@id([tenant_id, project_no, task_no])
}
model Label {
  tenant_id Int
  label_no  Int
  name      String
  tasks     TaskLabel[]
  @@id([tenant_id, label_no])
}
model TaskLabel {
  tenant_id  Int
  project_no Int
  task_no    Int
  label_no   Int
  task       Task  @relation(fields: [tenant_id, project_no, task_no], references: [tenant_id, project_no, task_no])
  label      Label @relation(fields: [tenant_id, label_no], references: [tenant_id, label_no])
  @@id([tenant_id, project_no, task_no, label_no])
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
    updateMany: jest.fn(async () => ({ count: 1 })),
    upsert: jest.fn(async () => ({})), count: jest.fn(async () => 0), delete: jest.fn(async () => ({})),
});
const mockDb = { provider: 'postgresql', statements: [] as string[], commits: 0 };
const mockAcl: { model: Record<string, any> } = { model: {} };
const mockAnyNull = { prismaNull: 'AnyNull' };

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
        Prisma: { AnyNull: mockAnyNull },
    };
});

import { getFields, getPrimaryKey, loadDMMF } from '../../src/core/dmmf';
import { modelMiddleware } from '../../src/core/middleware';
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
        mockDelegate('Item').updateMany.mockImplementation(async ({ where }: any) => {
            if (where.id === 2) throw conflict();
            return { count: 1 };
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
        mockDelegate('Item').updateMany.mockImplementation(async ({ where }: any) => {
            if (where.id === 1) throw conflict();
            return { count: 1 };
        });
        const result = await new Model('Item').upsertMany(items([1, 'x'], [2, 'y']));
        expect(result).toMatchObject({ updated: 1, totalFailed: 1 });
        expect(mockDb.statements).toEqual([]);
    });

    it('deadlocks and write conflicts fail the batch instead of being reported as one record', async () => {
        mockDelegate('Item').findMany.mockResolvedValue([{ id: 1 }]);
        mockDelegate('Item').updateMany.mockRejectedValue(Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { code: 'P2034' }));
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
        expect(mockDelegates.Item.updateMany.mock.calls[0][0]).toEqual({ where: { id: 1 }, data: { name: 'second' } });
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

    it('composite keys: plain-field lookup and updates, the PK as default key, the named selector for update', async () => {
        mockDelegate('Member').findMany.mockResolvedValue([{ orgId: 1, userId: 1 }, { orgId: 1, userId: 3 }]);
        mockDelegate('Member').updateMany.mockImplementation(async ({ where }: any) => ({ count: where.userId === 3 ? 0 : 1 }));
        const result = await new Model('Member').upsertMany([
            { orgId: 1, userId: 1, role: 'admin' }, { orgId: 1, userId: 2, role: 'member' }, { orgId: 1, userId: 3, role: 'gone' },
        ]);
        expect(mockDelegates.Member.findMany.mock.calls[0][0].where).toEqual({ OR: [{ orgId: 1, userId: 1 }, { orgId: 1, userId: 2 }, { orgId: 1, userId: 3 }] });
        expect(mockDelegates.Member.updateMany.mock.calls[0][0].where).toEqual({ orgId: 1, userId: 1 });
        // A row updateMany doesn't find goes to update, addressed by the schema's selector name
        expect(mockDelegates.Member.update.mock.calls.map(([args]: any) => args.where)).toEqual([{ pk: { orgId: 1, userId: 3 } }]);
        expect(result).toMatchObject({ created: 1, updated: 2 });
    });

    it('PostgreSQL: a row updateMany doesn\'t find is reported by update, as before', async () => {
        mockDelegate('Item').findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
        mockDelegate('Item').updateMany.mockImplementation(async ({ where }: any) => ({ count: where.id === 2 ? 0 : 1 }));
        mockDelegate('Item').update.mockRejectedValue(Object.assign(new Error('No record was found for an update.'), { code: 'P2025' }));
        const result = await new Model('Item').upsertMany(items([1, 'a'], [2, 'b']));
        expect(result).toMatchObject({ updated: 1, totalFailed: 1, failed: [{ record: { name: 'b' }, error: { code: 'P2025' } }] });
        expect(mockDelegates.Item.update.mock.calls[0][0]).toEqual({ where: { id: 2 }, data: { name: 'b' } });
        expect(mockDb.commits).toBe(1);
    });

    it('foreign keys stay on update: the connect is held to the related model\'s access rules', async () => {
        mockAcl.model.Item = { getAccessFilter: (u: any) => ({ owner: u.id }) };
        mockDelegate('Tag').findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
        const result = await new Model('Tag', { user }).upsertMany([{ id: 1, label: 'x', itemId: 5 }, { id: 2, label: 'y' }]);
        expect(mockDelegates.Tag.update.mock.calls[0][0]).toEqual({ where: { id: 1 }, data: { label: 'x', item: { connect: { id: 5, AND: [{ owner: 7 }] } } } });
        expect(mockDelegates.Tag.updateMany.mock.calls).toEqual([[{ where: { id: 2 }, data: { label: 'y' } }]]);
        expect(result).toMatchObject({ updated: 2 });
    });

    it('a @@unique key updates by its plain fields; a key that isn\'t unique, or Prisma options, keep update', async () => {
        mockDelegate('Slot').findMany.mockResolvedValue([{ day: 1, room: 2 }]);
        await new Model('Slot').upsertMany([{ id: 9, day: 1, room: 2 }], ['day', 'room']);
        expect(mockDelegates.Slot.updateMany.mock.calls[0][0].where).toEqual({ day: 1, room: 2 });
        expect(mockDelegates.Slot.update).not.toHaveBeenCalled();

        mockDelegate('Item').findMany.mockResolvedValue([{ id: 1, qty: 5 }]);
        await new Model('Item').upsertMany([{ qty: 5, owner: 1 }], 'qty');
        await new Model('Item').upsertMany([{ id: 1, name: 'a' }], 'id', { select: { id: true } });
        expect(mockDelegates.Item.update.mock.calls.map(([args]: any) => args)).toEqual([
            { where: { qty: 5 }, data: { qty: 5, owner: 1 } },
            { where: { id: 1 }, data: { name: 'a' }, select: { id: true } },
        ]);
        expect(mockDelegates.Item.updateMany).not.toHaveBeenCalled();
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

describe('access control on includes and links', () => {
    const lastFindMany = () => mockDelegates.Item.findMany.mock.calls.at(-1)![0];

    it('an include applies the related model\'s rule as it is — conditions through the parent relation too', async () => {
        mockAcl.model.Tag = { getAccessFilter: (u: any) => ({ item: { owner: u.id } }) };
        await new Model('Item', { user }).getMany({ include: 'tags' });
        expect(lastFindMany().include.tags.where).toEqual({ item: { owner: 7 } });
    });

    it('a foreign key never links to a model the user may not access', async () => {
        mockAcl.model.Item = { getAccessFilter: () => false };
        await expect(new Model('Tag', { user }).create({ label: 'x', itemId: 5 }))
            .rejects.toMatchObject({ status_code: 403, message: 'no_permission', data: { model: 'Item' } });
        await expect(new Model('Tag', { user }).update(1, { itemId: 5 }))
            .rejects.toMatchObject({ status_code: 403, message: 'no_permission', data: { model: 'Item' } });
        expect(mockDelegate('Tag').create).not.toHaveBeenCalled();
        expect(mockDelegate('Tag').update).not.toHaveBeenCalled();
    });

    it('nested updates of rows the user may not update are refused', async () => {
        mockAcl.model.Tag = { getUpdateFilter: () => false };
        await expect(new Model('Item', { user }).update(1, { tags: [{ id: 3, label: 'y' }] }))
            .rejects.toMatchObject({ status_code: 403, message: 'no_permission_to_update', data: { model: 'Tag' } });
    });

    it('a rule with an undefined value — a missing user attribute — denies instead of matching every row', async () => {
        const error = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
        try {
            mockAcl.model.Item = { getAccessFilter: (u: any) => ({ owner: u.uid }) };
            await expect(new Model('Item', { user }).getMany({})).rejects.toMatchObject({ status_code: 403 });
            delete mockAcl.model.Item;
            mockAcl.model.Tag = { getAccessFilter: (u: any) => ({ item: { owner: u.uid } }) };
            await new Model('Item', { user }).getMany({ include: 'tags' });
            expect(lastFindMany().include?.tags).toBeUndefined();
            expect(error).toHaveBeenCalledWith(expect.stringMatching(/^ACL: Item\.getAccessFilter returned a filter with an undefined value — denied/));
        } finally {
            error.mockRestore();
        }
    });
});

describe('keys and foreign keys', () => {
    it('upsertMany matches DateTime keys however they are written', async () => {
        mockDelegate('Day').findMany.mockResolvedValue([{ id: new Date('2024-03-15T10:00:00Z') }]);
        const result = await new Model('Day').upsertMany([{ id: '2024-03-15T10:00:00.000Z' }, { id: '2024-03-16T10:00:00Z' }]);
        expect(result).toMatchObject({ created: 1, updated: 1, skipped: 0 });
    });

    it('a foreign key of 0 links to the row with key 0', () => {
        expect(new QueryBuilder('Tag').create({ label: 'x', itemId: 0 })).toMatchObject({ item: { connect: { id: 0 } } });
        // An empty form field is no link — and this one is required: named by its column
        expect(() => new QueryBuilder('Tag').create({ label: 'x', itemId: '' })).toThrow(expect.objectContaining({ status_code: 400, message: 'foreign_key_required' }));
        expect(() => new QueryBuilder('Tag').create({ label: 'x' })).toThrow(expect.objectContaining({ message: 'foreign_key_required', data: { relation: 'item', fields: ['itemId'] } }));
        expect(() => new QueryBuilder('Tag').update(1, { itemId: null })).toThrow('foreign_key_required');
    });
});

describe('the user table entry rapidd build generates', () => {
    // As @rapidd/build writes it for a user table with a password column
    const generated = () => ({
        canCreate: () => true,
        getAccessFilter: () => true,
        getUpdateFilter: () => true,
        getDeleteFilter: () => true,
        getOmitFields: () => ['password'],
        getWritableFields: () => Object.keys(getFields('Account')).filter((field) => field !== 'password'),
    });

    it('the password is neither returned nor written through the API — the rest stays writable, relations too', async () => {
        mockAcl.model.Account = generated();
        const api = new Model('Account', { user, strictWrites: true });
        await expect(api.update(1, { password: '$2b$10$chosen' }))
            .rejects.toMatchObject({ status_code: 403, message: 'fields_not_writable', data: { fields: ['password'] } });
        await expect(api.create({ email: 'a@example.com', password: '$2b$10$chosen' }))
            .rejects.toMatchObject({ status_code: 403, message: 'fields_not_writable', data: { fields: ['password'] } });

        await api.update(1, { email: 'b@example.com', logins: { create: [{ at: new Date(0) }] } });
        expect(mockDelegates.Account.update.mock.calls[0][0].data).toMatchObject({ email: 'b@example.com', logins: { create: [{ at: new Date(0) }] } });

        await api.getMany({});
        expect(mockDelegates.Account.findMany.mock.calls[0][0].omit).toEqual({ password: true });
    });

    it('hiding it alone would leave a required password writable — by any user, for any user', async () => {
        mockAcl.model.Account = { getOmitFields: () => ['password'] };
        await new Model('Account', { user, strictWrites: true }).update(2, { password: '$2b$10$chosen' });
        expect(mockDelegates.Account.update.mock.calls[0][0].data).toEqual({ password: '$2b$10$chosen' });
    });

    it('trusted code sets it as the system user', async () => {
        mockAcl.model.Account = generated();
        await new Model('Account').update(1, { password: '$2b$10$hashed' });
        expect(mockDelegates.Account.update.mock.calls[0][0].data).toEqual({ password: '$2b$10$hashed' });
    });
});

describe('keys beyond the id convention', () => {
    it('a model without @id is keyed by its unique of required fields — a @unique, else a @@unique (Device: its nullable serial is passed over)', () => {
        expect(getPrimaryKey('Setting')).toBe('key');
        expect(getPrimaryKey('Device')).toEqual(['vendor', 'model']);
        expect(getPrimaryKey('Reading')).toEqual(['sensor', 'day', 'slot']);
    });

    it('it is read and written by that key; rows come in key order without a sort', async () => {
        mockDelegate('Setting').findUnique.mockResolvedValue({ key: 'theme', value: 'light' });
        mockDelegate('Device').findUnique.mockResolvedValue({ vendor: 'acme', model: 'x1' });
        await new Model('Setting').get('theme');
        expect(mockDelegates.Setting.findUnique.mock.calls[0][0].where).toEqual({ key: 'theme' });
        await new Model('Setting').update('theme', { value: 'dark' });
        expect(mockDelegates.Setting.update.mock.calls[0][0].where).toMatchObject({ key: 'theme' });
        await new Model('Device').getMany({});
        expect(mockDelegates.Device.findMany.mock.calls[0][0].orderBy).toEqual([{ vendor: 'asc' }, { model: 'asc' }]);
        await new Model('Device').get('acme~x1');
        expect(mockDelegates.Device.findUnique.mock.calls[0][0].where).toEqual({ vendor_model: { vendor: 'acme', model: 'x1' } });
        await new Model('Item').getMany({ sortBy: 'name' });
        // A requested sort, the key breaking its ties
        expect(mockDelegates.Item.findMany.mock.calls[0][0].orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }]);
    });

    it('a key of three columns: "a~b~c", each part read as its type', async () => {
        mockDelegate('Reading').findUnique.mockResolvedValue({ sensor: 's1', slot: 3 });
        await new Model('Reading').get('s1~2026-10-15~3');
        expect(mockDelegates.Reading.findUnique.mock.calls[0][0].where).toEqual({ sensor_day_slot: { sensor: 's1', day: new Date('2026-10-15T00:00:00.000Z'), slot: 3 } });
    });
});

describe('composite foreign keys', () => {
    it('link through the compound selector — all columns together, or none', () => {
        const qb = new QueryBuilder('Assignment');
        expect(qb.create({ orgId: 1, userId: 2, note: 'n' })).toEqual({ note: 'n', member: { connect: { orgId_userId: { orgId: 1, userId: 2 } } } });
        expect(qb.update(7, { orgId: 1, userId: 3 })).toEqual({ member: { connect: { orgId_userId: { orgId: 1, userId: 3 } } } });
        expect(qb.update(7, { orgId: null, userId: null })).toEqual({ member: { disconnect: true } });
        expect(qb.create({ orgId: null, userId: null, note: 'n' })).toEqual({ note: 'n' });
        expect(() => qb.create({ orgId: 1, note: 'n' })).toThrow('incomplete_foreign_key');
        expect(() => qb.update(7, { orgId: 1, userId: null })).toThrow('incomplete_foreign_key');
    });

    it('the related model\'s access rule holds for the link', () => {
        mockAcl.model.OrgMember = { getAccessFilter: () => false };
        expect(() => new QueryBuilder('Assignment').create({ orgId: 1, userId: 2, note: 'n' }, user)).toThrow('no_permission');
    });
});

describe('nested writes at every level', () => {
    it('creates convert every level; deep items are addressed by their own key', () => {
        // Rows of a new parent are created — with the key they carry (taken: 409, not a silent move)
        expect(new QueryBuilder('Shop').create({ orders: [{ lines: [{ line_no: 1, qty: 2 }] }] })).toEqual({
            orders: { create: [{ lines: { create: [{ line_no: 1, qty: 2 }] } }] },
        });
        expect(new QueryBuilder('Shop').update(1, { orders: [{ id: 5, lines: [{ line_no: 9 }] }] })).toEqual({
            orders: { upsert: [{ where: { id: 5 }, create: { id: 5, lines: { connect: [{ line_no: 9 }] } }, update: { lines: { connect: [{ line_no: 9 }] } } }] },
        });
    });

    it('foreign keys inside nested items link under the related model\'s access rule', () => {
        mockAcl.model.Customer = { getAccessFilter: () => ({ id: 7 }) };
        expect(new QueryBuilder('Shop').create({ orders: [{ customer_id: 7 }] }, user)).toEqual({
            orders: { create: [{ customer: { connect: { id: 7, AND: [{ id: 7 }] } } }] },
        });
        mockAcl.model.Customer = { getAccessFilter: () => false };
        expect(() => new QueryBuilder('Shop').create({ orders: [{ customer_id: 5 }] }, user)).toThrow('no_permission');
        expect(() => new QueryBuilder('Shop').update(1, { orders: [{ id: 2, customer_id: 5 }] }, user)).toThrow('no_permission');
    });

    it('the foreign key back to the parent is the nesting\'s — a client\'s copy is dropped, also on a model related to itself', () => {
        expect(new QueryBuilder('Shop').create({ orders: [{ shop_id: 99, customer_id: 5 }] })).toEqual({ orders: { create: [{ customer: { connect: { id: 5 } } }] } });
        expect(new QueryBuilder('Employee').update(1, { reports: [{ id: 2, name: 'b', manager_id: 9 }] })).toEqual({
            reports: { upsert: [{ where: { id: 2 }, create: { id: 2, name: 'b' }, update: { name: 'b' } }] },
        });
    });

    it('an upsert creates with create operations; a linked create leaves the autoincrement key to the database', () => {
        expect(new QueryBuilder('Shop').update(1, { orders: [{ id: 5, customer_id: 3, lines: [{ line_no: 1, qty: 1 }] }] })).toEqual({
            orders: { upsert: [{
                where: { id: 5 },
                create: { customer: { connect: { id: 3 } }, lines: { create: [{ line_no: 1, qty: 1 }] } },
                update: { customer: { connect: { id: 3 } }, lines: { upsert: [{ where: { line_no: 1 }, create: { line_no: 1, qty: 1 }, update: { qty: 1 } }] } },
            }] },
        });
    });

    it('rows with a composite key are addressed through its compound selector', () => {
        const reading = { sensor: 's1', day: '2026-10-15T00:00:00.000Z', slot: 3 };
        expect(new QueryBuilder('Batch').update(1, { readings: [reading] })).toEqual({
            readings: { connect: [{ sensor_day_slot: reading }] },
        });
        expect(new QueryBuilder('Batch').update(1, { readings: [{ ...reading, value: 2.5 }] })).toEqual({
            readings: { upsert: [{ where: { sensor_day_slot: reading }, create: { ...reading, value: 2.5 }, update: { value: 2.5 } }] },
        });
    });

    it('a row whose key includes the parent\'s is addressed with the parent\'s part: linked when there, created when not', () => {
        expect(new QueryBuilder('Org').update(1, { members: [{ orgId: 1, userId: 2 }] })).toEqual({
            members: { connectOrCreate: [{ where: { orgId_userId: { orgId: 1, userId: 2 } }, create: { userId: 2 } }] },
        });
    });
});


describe('foreign keys that share a column (tenant-first composite keys)', () => {
    const task = { tenant_id: 1, project_no: 2, task_no: 3 };
    const tenantUser = (user_no: number) => ({ connect: { tenant_id_user_no: { tenant_id: 1, user_no } } });

    it('a relation is named by a column of its own — the shared one alone names none', () => {
        const project = { connect: { tenant_id_project_no: { tenant_id: 1, project_no: 2 } } };
        expect(new QueryBuilder('Task').create({ ...task, title: 't' })).toEqual({ task_no: 3, title: 't', project });
        expect(new QueryBuilder('Task').create({ ...task, title: 't', assignee_no: null })).toEqual({ task_no: 3, title: 't', project });
        expect(new QueryBuilder('Task').create({ ...task, title: 't', assignee_no: 5 })).toEqual({ task_no: 3, title: 't', project, assignee: tenantUser(5) });
    });

    it('an update completes a foreign key from the row\'s key; an unchanged key is no write', () => {
        expect(new QueryBuilder('Task').update(task, { assignee_no: 5 })).toEqual({ assignee: tenantUser(5) });
        // A fetched row sent back: only what it changes
        expect(new QueryBuilder('Task').update(task, { ...task, title: 'x', assignee_no: null })).toEqual({ title: 'x', assignee_no: null });
        // Into another project of the tenant: the key changes through the link
        expect(new QueryBuilder('Task').update(task, { project_no: 4 })).toEqual({ project: { connect: { tenant_id_project_no: { tenant_id: 1, project_no: 4 } } } });
    });

    it('unlinking nulls the columns of its own — disconnect would null the shared tenant_id too', () => {
        expect(new QueryBuilder('Task').update(task, { assignee_no: null })).toEqual({ assignee_no: null });
        // Prisma takes such a column only without relation writes next to it
        expect(() => new QueryBuilder('Task').update(task, { project_no: 4, assignee_no: null }))
            .toThrow(expect.objectContaining({ status_code: 400, message: 'foreign_key_unlink_conflict', data: { relation: 'assignee', fields: ['assignee_no'] } }));
        // A foreign key of its own columns only still unlinks by disconnect
        expect(new QueryBuilder('Order').update(1, { customer_id: null })).toEqual({ customer: { disconnect: true } });
    });

    it('the shared column written alone moves every link through it — each must be complete', () => {
        expect(() => new QueryBuilder('Task').update(task, { tenant_id: 9 }))
            .toThrow(expect.objectContaining({ message: 'incomplete_foreign_key', data: { relation: 'assignee', fields: ['tenant_id', 'assignee_no'] } }));
        expect(new QueryBuilder('Task').update(task, { tenant_id: 9, assignee_no: 5 })).toEqual({
            project: { connect: { tenant_id_project_no: { tenant_id: 9, project_no: 2 } } },
            assignee: { connect: { tenant_id_user_no: { tenant_id: 9, user_no: 5 } } },
        });
    });

    it('nested items take the parent\'s part of their keys and links — at every level', () => {
        expect(new QueryBuilder('Project').create({ tenant_id: 1, project_no: 2, name: 'p', owner_no: 1, tasks: [
            { task_no: 1, title: 'a', assignee_no: 5, tenant_id: 8, labels: [{ label_no: 3 }] },
        ] })).toEqual({
            project_no: 2, name: 'p', owner: tenantUser(1),
            tasks: { create: [{ task_no: 1, title: 'a', assignee: tenantUser(5), labels: { create: [{ label: { connect: { tenant_id_label_no: { tenant_id: 1, label_no: 3 } } } }] } }] },
        });

        // Updates address the rows by the whole key: upsert what can be created, link what is named only
        expect(new QueryBuilder('Project').update({ tenant_id: 1, project_no: 2 }, { tasks: [{ task_no: 1, title: 'renamed' }, { task_no: 2 }] })).toEqual({
            tasks: {
                upsert: [{ where: { tenant_id_project_no_task_no: { tenant_id: 1, project_no: 2, task_no: 1 } }, create: { task_no: 1, title: 'renamed' }, update: { title: 'renamed' } }],
                connect: [{ tenant_id_project_no_task_no: { tenant_id: 1, project_no: 2, task_no: 2 } }],
            },
        });
        expect(new QueryBuilder('Task').update(task, { labels: [{ label_no: 3 }] })).toEqual({
            labels: { connectOrCreate: [{
                where: { tenant_id_project_no_task_no_label_no: { tenant_id: 1, project_no: 2, task_no: 3, label_no: 3 } },
                create: { label: { connect: { tenant_id_label_no: { tenant_id: 1, label_no: 3 } } } },
            }] },
        });
    });
});

describe('nested writes under the related model\'s rules', () => {
    it('linking a row moves it — the related model\'s update rule applies too, also to raw operations', () => {
        mockAcl.model.Order = { getUpdateFilter: () => false };
        expect(() => new QueryBuilder('Shop').create({ orders: [{ id: 5 }] }, user)).toThrow('no_permission_to_update');
        expect(() => new QueryBuilder('Shop').update(1, { orders: [{ id: 5 }] }, user)).toThrow('no_permission_to_update');
        expect(() => new QueryBuilder('Shop').update(1, { orders: { connect: [{ id: 5 }] } }, user)).toThrow('no_permission_to_update');

        mockAcl.model.Order = { getAccessFilter: () => ({ shop_id: 1 }), getUpdateFilter: () => ({ customer_id: 7 }) };
        expect(new QueryBuilder('Shop').update(1, { orders: [{ id: 5 }] }, user)).toEqual({
            orders: { connect: [{ id: 5, AND: [{ shop_id: 1 }, { customer_id: 7 }] }] },
        });
        expect(new QueryBuilder('Shop').update(1, { orders: { connect: [{ id: 5 }] } }, user)).toEqual({
            orders: { connect: [{ id: 5, AND: [{ shop_id: 1 }, { customer_id: 7 }] }] },
        });
    });

    it('a plain object for a to-one relation updates the linked row under its update rule', () => {
        mockAcl.model.Project = { getUpdateFilter: () => false };
        expect(() => new QueryBuilder('Task').update({ tenant_id: 1, project_no: 2, task_no: 3 }, { project: { name: 'x' } }, user)).toThrow('no_permission_to_update');
        mockAcl.model.Project = { getUpdateFilter: () => ({ owner_no: 7 }) };
        expect(new QueryBuilder('Task').update({ tenant_id: 1, project_no: 2, task_no: 3 }, { project: { name: 'x' } }, user)).toEqual({
            project: { update: { where: { owner_no: 7 }, data: { name: 'x' } } },
        });
    });

    it('an item a new row couldn\'t be made of only updates — Prisma checks the create half of an upsert too', () => {
        expect(new QueryBuilder('Item').update(1, { tags: [{ id: 3, secret: 'z' }] })).toEqual({
            tags: { update: [{ where: { id: 3 }, data: { secret: 'z' } }] },
        });
        expect(new QueryBuilder('Item').update(1, { tags: [{ id: 3, label: 'l' }] })).toEqual({
            tags: { upsert: [{ where: { id: 3 }, create: { id: 3, label: 'l' }, update: { label: 'l' } }] },
        });
    });

    it('integers past 2^53 sent as JSON numbers have lost digits — refused', () => {
        expect(() => new QueryBuilder('Big').create({ id: 2 ** 53 + 2 })).toThrow(expect.objectContaining({ status_code: 400, message: 'unsafe_integer' }));
        expect(new QueryBuilder('Big').create({ id: '9007199254740995' })).toEqual({ id: '9007199254740995' });
    });
});

describe('reads through relations under the related model\'s rule', () => {
    it('filters see only related rows the user can read; a denied model can\'t be queried through', () => {
        mockAcl.model.Tag = { getAccessFilter: () => ({ secret: 's' }) };
        expect(new QueryBuilder('Item').filter('tags.label=x', user)).toEqual({ tags: { some: { AND: [{ secret: 's' }], label: expect.anything() } } });
        expect(new QueryBuilder('Item').filter('tags=#NULL', user)).toEqual({ tags: { none: { secret: 's' } } });
        mockAcl.model.Item = { getAccessFilter: () => false };
        expect(() => new QueryBuilder('Tag').filter('item.name=x', user)).toThrow(expect.objectContaining({ status_code: 403, message: 'field_not_filterable' }));
        expect(() => new QueryBuilder('Tag').sort('item.name', 'asc', user)).toThrow('field_not_filterable');
    });

    it('the same field twice: both conditions apply', () => {
        expect(new QueryBuilder('Item').filter('id=gt:3,id=lt:6')).toEqual({ id: { gt: 3 }, AND: [{ id: { lt: 6 } }] });
        expect(new QueryBuilder('Item').filter(['qty=gt:1', 'qty=lt:9'])).toEqual({ qty: { gt: 1 }, AND: [{ qty: { lt: 9 } }] });
    });

    it('a relation named alone in fields= comes under its model\'s rule, as include= does', () => {
        mockAcl.model.Tag = { getAccessFilter: () => ({ secret: 's' }), getOmitFields: () => ['secret'] };
        expect(new QueryBuilder('Item').buildFieldSelection('id,tags', '', user)).toEqual({
            select: { id: true, tags: expect.objectContaining({ where: { secret: 's' }, omit: { secret: true } }) },
        });
        mockAcl.model.Tag = { getAccessFilter: () => false };
        expect(new QueryBuilder('Item').buildFieldSelection('id,tags', '', user)).toEqual({ select: { id: true } });
    });
});

describe('middleware sets what the user may not write', () => {
    afterEach(() => modelMiddleware.clear());

    it('a before-hook\'s fields stay — what the client may not write is gone before the hook runs', async () => {
        mockAcl.model.Item = { getWritableFields: () => ['id', 'name'] };
        let seen: Record<string, any> | null = null;
        const stamp = async (ctx: any) => {
            seen = { ...ctx.data };
            ctx.data = { ...ctx.data, owner: 42 };
            return ctx;
        };
        modelMiddleware.use('before', 'create', stamp, 'Item');
        modelMiddleware.use('before', 'update', stamp, 'Item');

        await new Model('Item', { user }).create({ id: 1, name: 'n', owner: 7, secret: 'x' });
        expect(seen).toEqual({ id: 1, name: 'n' });
        expect(mockDelegates.Item.create.mock.calls[0][0].data).toEqual({ id: 1, name: 'n', owner: 42 });

        await new Model('Item', { user }).update(1, { name: 'm', owner: 7 });
        expect(seen).toEqual({ name: 'm' });
        expect(mockDelegates.Item.update.mock.calls[0][0].data).toEqual({ name: 'm', owner: 42 });
    });
});

describe('filters by the column type', () => {
    const qb = () => new QueryBuilder('Product');

    it('a Decimal keeps its digits — a float would round them', () => {
        expect(qb().filter('price=12345678901234.5678')).toEqual({ price: { equals: '12345678901234.5678' } });
        expect(qb().filter('price=gte:0.10')).toEqual({ price: { gte: '0.10' } });
        expect(qb().filter('price=[1.10,2.5]')).toEqual({ price: { in: ['1.10', '2.5'] } });
        expect(() => qb().filter('price=1.2.3')).toThrow('invalid_filter_value');
    });

    it('an enum takes its values only', () => {
        expect(qb().filter('status=RETIRED')).toEqual({ status: { equals: 'RETIRED' } });
        expect(() => qb().filter('status=GONE')).toThrow(expect.objectContaining({ status_code: 400, message: 'invalid_filter_value', data: expect.objectContaining({ expected: 'ACTIVE, RETIRED' }) }));
        expect(() => qb().filter('status=[ACTIVE,GONE]')).toThrow('invalid_filter_value');
        expect(() => qb().filter('status=not:GONE')).toThrow('invalid_filter_value');
    });

    it('a Json column\'s null is the database\'s or JSON\'s — and it takes no wildcards', () => {
        expect(qb().filter('attrs=#NULL')).toEqual({ attrs: { equals: mockAnyNull } });
        expect(qb().filter('attrs=not:#NULL')).toEqual({ attrs: { not: mockAnyNull } });
        expect(() => qb().filter('attrs=%red%')).toThrow('invalid_filter_value');
    });

    it('a group without its closing parenthesis is unbalanced', () => {
        expect(() => qb().filter('OR(sku=a')).toThrow(expect.objectContaining({ status_code: 400, message: 'unbalanced_filter_group' }));
    });
});

describe('a duplicate key names its fields — from the database\'s index name too', () => {
    const duplicate = (modelName: string, constraint: Record<string, unknown>) =>
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { modelName, driverAdapterError: { cause: { constraint } } } });

    it.each([
        ['Member', { index: 'Member_pkey' }, 'orgId, userId'],
        ['Slot', { index: 'Slot_room_day_key' }, 'room, day'],
        ['Setting', { index: 'Setting_key_key' }, 'key'],
        // MySQL: the key of the table MySQL names
        ['Shop', { index: 'Line.PRIMARY' }, 'line_no'],
        ['Member', { fields: ['orgId', 'userId'] }, 'orgId, userId'],
    ])('%s %j → %s', (model, constraint, field) => {
        expect(QueryBuilder.errorHandler(duplicate(model, constraint)).data).toMatchObject({ field });
    });

    it('MariaDB\'s bare PRIMARY: the model written when the body carries its key — else the nested one whose items do', () => {
        const primary = (model: string, body: Record<string, unknown>) => QueryBuilder.errorHandler(duplicate(model, { index: 'PRIMARY' }), body).data;
        expect(primary('Slot', { id: 3, day: 1, room: 2 })).toMatchObject({ model: 'Slot', field: 'id', value: '3' });
        expect(primary('Shop', { orders: [{ id: 5 }] })).toMatchObject({ model: 'Order', field: 'id' });
        expect(primary('Shop', { orders: [{ lines: [{ line_no: 2, qty: 1 }] }] })).toMatchObject({ model: 'Line', field: 'line_no' });
        // Nothing to tell which — no name at all, rather than a wrong one
        expect(QueryBuilder.errorHandler(duplicate('Shop', { index: 'PRIMARY' }), { orders: [{ id: 4, lines: [{ line_no: 4, qty: 1 }] }] }))
            .toMatchObject({ status_code: 409, key: 'duplicate_entry_unknown', data: {} });
    });

    it('with the values when the data has them', () => {
        const response = QueryBuilder.errorHandler(duplicate('Member', { index: 'Member_pkey' }), { orgId: 1, userId: 2 });
        expect(response).toMatchObject({ status_code: 409, key: 'duplicate_entry', data: { model: 'Member', field: 'orgId, userId', value: '1, 2' } });
    });
});

describe('a write the rule leaves out: 403, a missing row: 404 — composite keys too', () => {
    const notFound = () => Object.assign(new Error('No record was found for an update.'), { code: 'P2025' });

    it('looks the row up by its key, with and without the rule', async () => {
        mockAcl.model.Member = { getUpdateFilter: () => ({ role: 'owner' }), getDeleteFilter: () => ({ role: 'owner' }) };
        mockDelegate('Member').update.mockRejectedValue(notFound());
        mockDelegate('Member').delete.mockRejectedValue(notFound());
        const lookups = mockDelegate('Member').findUnique;

        lookups.mockResolvedValue(null);
        await expect(new Model('Member', { user }).update('1~2', { role: 'x' })).rejects.toMatchObject({ status_code: 404, message: 'record_not_found' });
        expect(lookups.mock.calls[0][0].where).toEqual({ pk: { orgId: 1, userId: 2 } });

        lookups.mockReset();
        lookups.mockResolvedValueOnce({ orgId: 1, userId: 2 }).mockResolvedValueOnce(null);
        await expect(new Model('Member', { user }).update('1~2', { role: 'x' })).rejects.toMatchObject({ status_code: 403, message: 'no_permission_to_update' });
        expect(lookups.mock.calls[1][0].where).toEqual({ pk: { orgId: 1, userId: 2 }, AND: [{ role: 'owner' }] });

        lookups.mockReset();
        lookups.mockResolvedValueOnce({ orgId: 1, userId: 2 }).mockResolvedValueOnce(null);
        await expect(new Model('Member', { user }).delete('1~2')).rejects.toMatchObject({ status_code: 403, message: 'no_permission_to_delete' });

        // Within the rule: the miss is another one's (a nested link) — its own error
        lookups.mockReset();
        lookups.mockResolvedValue({ orgId: 1, userId: 2 });
        await expect(new Model('Member', { user }).update('1~2', { role: 'x' })).rejects.toMatchObject({ code: 'P2025' });
    });

    it('without a rule a missing row is 404 record_not_found as well', async () => {
        mockDelegate('Item').update.mockRejectedValue(notFound());
        mockDelegate('Item').findUnique.mockResolvedValue(null);
        await expect(new Model('Item', { user }).update(99, { qty: 1 })).rejects.toMatchObject({ status_code: 404, message: 'record_not_found' });
    });
});

describe('an upsert\'s nested creates must be new rows too', () => {
    it('an item whose nested items can\'t be created is an update, two levels down', () => {
        expect(new QueryBuilder('Shop').update(1, { orders: [{ id: 5, lines: [{ line_no: 1, note: 'x' }] }] })).toEqual({
            orders: { update: [{ where: { id: 5 }, data: { lines: { update: [{ where: { line_no: 1 }, data: { note: 'x' } }] } } }] },
        });
    });
});
