import fs from 'fs';
import os from 'os';
import path from 'path';
import { words, singular, plural, relationFields, renameRelations, typeJsonColumns, writeSchema, SchemaEditError } from '../../src/setup/schema';
import type { DMMF } from '../../src/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDMMF } = require('@prisma/internals');
const dmmfOf = async (source: string): Promise<DMMF> => getDMMF({ datamodel: source });

const HEAD = (provider: string) => `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "${provider}"
}
`;

// As `prisma db pull` names them: after the related model
const HR = `${HEAD('mysql')}
model departments {
  code      String      @id @db.Char(4)
  name      String
  employees employees[]
}

model employees {
  id              Int          @id @default(autoincrement())
  first_name      String
  department_code String       @db.Char(4)
  manager_id      Int?
  profile         String?      @db.LongText
  departments     departments  @relation(fields: [department_code], references: [code])
  employees       employees?   @relation("employeesToemployees", fields: [manager_id], references: [id])
  other_employees employees[]  @relation("employeesToemployees")
}
`;

const SOCIAL = `${HEAD('mysql')}
model User {
  id                             BigInt    @id @default(autoincrement())
  username                       String    @unique
  Post                           Post[]
  Comment                        Comment[]
  Follow_Follow_followerIdToUser Follow[]  @relation("Follow_followerIdToUser")
  Follow_Follow_followingIdToUser Follow[] @relation("Follow_followingIdToUser")
}

model Post {
  id       BigInt    @id @default(autoincrement())
  authorId BigInt
  title    String
  User     User      @relation(fields: [authorId], references: [id])
  Comment  Comment[]
  PostTag  PostTag[]
}

model Comment {
  id            BigInt    @id @default(autoincrement())
  postId        BigInt
  authorId      BigInt
  parentId      BigInt?
  Post          Post      @relation(fields: [postId], references: [id])
  User          User      @relation(fields: [authorId], references: [id])
  Comment       Comment?  @relation("CommentToComment", fields: [parentId], references: [id])
  other_Comment Comment[] @relation("CommentToComment")
}

model Follow {
  followerId                    BigInt
  followingId                   BigInt
  User_Follow_followerIdToUser  User @relation("Follow_followerIdToUser", fields: [followerId], references: [id])
  User_Follow_followingIdToUser User @relation("Follow_followingIdToUser", fields: [followingId], references: [id])

  @@id([followerId, followingId])
}

model Tag {
  id      Int       @id @default(autoincrement())
  name    String
  PostTag PostTag[]
}

model PostTag {
  postId BigInt
  tagId  Int
  Post   Post @relation(fields: [postId], references: [id])
  Tag    Tag  @relation(fields: [tagId], references: [id])

  @@id([postId, tagId])
}
`;

const suggestions = (dmmf: DMMF, model: string) =>
    Object.fromEntries(relationFields(dmmf, dmmf.datamodel.models.find((m) => m.name === model)!).map((r) => [r.name, r.suggestion]));

describe('words', () => {
    it('splits names in any style and makes the last word singular or plural', () => {
        expect(words('Follow_Follow_followerIdToUser')).toEqual(['follow', 'follow', 'follower', 'id', 'to', 'user']);
        expect(words('department_code')).toEqual(['department', 'code']);
        expect(words('PostTag')).toEqual(['post', 'tag']);
        expect(['employees', 'categories', 'addresses', 'boxes', 'courses', 'status', 'analysis', 'post'].map(singular))
            .toEqual(['employee', 'category', 'address', 'box', 'course', 'status', 'analysis', 'post']);
        expect(['employee', 'category', 'status', 'box', 'tag', 'employees'].map(plural))
            .toEqual(['employees', 'categories', 'statuses', 'boxes', 'tags', 'employees']);
    });
});

describe('relation names', () => {
    it('to-one: from the foreign key; back-relations: the related model, by the key when there are several', async () => {
        const dmmf = await dmmfOf(HR);
        expect(suggestions(dmmf, 'employees')).toEqual({
            departments: 'department',
            employees: 'manager',
            other_employees: 'employees_by_manager_id',
        });
        // Already what it means
        expect(suggestions(dmmf, 'departments')).toEqual({ employees: null });
    });

    it('in the naming style of the model (camelCase), parent_id → parent / children', async () => {
        const dmmf = await dmmfOf(SOCIAL);
        expect(suggestions(dmmf, 'Post')).toEqual({ User: 'author', Comment: 'comments', PostTag: 'postTags' });
        expect(suggestions(dmmf, 'Comment')).toEqual({ Post: 'post', User: 'author', Comment: 'parent', other_Comment: 'children' });
        expect(suggestions(dmmf, 'Follow')).toEqual({ User_Follow_followerIdToUser: 'follower', User_Follow_followingIdToUser: 'following' });
        expect(suggestions(dmmf, 'User')).toEqual({
            Post: 'posts', Comment: 'comments',
            Follow_Follow_followerIdToUser: 'followsByFollowerId', Follow_Follow_followingIdToUser: 'followsByFollowingId',
        });
        const post = relationFields(dmmf, dmmf.datamodel.models.find((m) => m.name === 'Post')!);
        expect(post.find((r) => r.name === 'User')).toMatchObject({ target: 'User', list: false, owner: true, foreignKey: ['authorId'] });
        expect(post.find((r) => r.name === 'Comment')).toMatchObject({ list: true, owner: false, foreignKey: ['postId'] });
    });

    it('never suggests a name the model already has', async () => {
        const dmmf = await dmmfOf(`${HEAD('postgresql')}
model users {
  id      Int     @id
  author  String
  posts   posts[]
}
model posts {
  id       Int   @id
  user_id  Int
  author   Int?
  users    users @relation(fields: [user_id], references: [id])
}
`);
        expect(suggestions(dmmf, 'posts')).toEqual({ users: 'user' });
        const clash = await dmmfOf(HR.replace('first_name      String', 'first_name      String\n  manager         String?'));
        expect(suggestions(clash, 'employees').employees).toBeNull();
    });
});

describe('renameRelations', () => {
    it('renames the fields of the model block; the relation and its columns stay', async () => {
        const dmmf = await dmmfOf(HR);
        const out = renameRelations(HR, dmmf, { employees: { employees: 'manager', other_employees: 'reports', departments: 'department' } });
        expect(out).toContain('  manager       employees?   @relation("employeesToemployees", fields: [manager_id], references: [id])');
        expect(out).toContain('  reports employees[]  @relation("employeesToemployees")');
        expect(out).toContain('  department     departments  @relation(fields: [department_code], references: [code])');
        // departments.employees is another model's field — untouched
        expect(out).toContain('  employees employees[]\n}');
        const renamed = await dmmfOf(out);
        expect(renamed.datamodel.models.find((m) => m.name === 'employees')!.fields.map((f) => f.name))
            .toEqual(['id', 'first_name', 'department_code', 'manager_id', 'profile', 'department', 'manager', 'reports']);
    });

    it('swaps work; clashes, scalars and bad names are refused', async () => {
        const dmmf = await dmmfOf(HR);
        expect(() => renameRelations(HR, dmmf, { employees: { employees: 'other_employees', other_employees: 'employees' } })).not.toThrow();
        expect(() => renameRelations(HR, dmmf, { employees: { employees: 'first_name' } })).toThrow('employees would have two fields named first_name');
        expect(() => renameRelations(HR, dmmf, { employees: { manager_id: 'manager' } })).toThrow('employees.manager_id is not a relation');
        expect(() => renameRelations(HR, dmmf, { employees: { employees: '1st' } })).toThrow('"1st" is not a field name');
        expect(() => renameRelations(HR, dmmf, { nope: { a: 'b' } })).toThrow(SchemaEditError);
    });
});

describe('MariaDB JSON columns', () => {
    it('types String columns with a json_valid() check Json — @map/@@map respected, other columns left', async () => {
        const source = `${HEAD('mysql')}
model staff {
  id         Int     @id
  first_name String
  bio        String? @map("profile") @db.LongText
  notes      String? @db.LongText

  @@map("employees")
}

model departments {
  code     String @id
  settings String @default("{}") @db.LongText
}
`;
        const dmmf = await dmmfOf(source);
        const columns = [{ table: 'employees', column: 'profile' }, { table: 'departments', column: 'settings' }, { table: 'employees', column: 'missing' }];
        const { source: typed, fields } = typeJsonColumns(source, dmmf, columns);
        expect(fields).toEqual(['staff.bio', 'departments.settings']);
        expect(typed).toContain('  bio        Json? @map("profile")\n');
        expect(typed).toContain('  settings Json @default("{}")\n');
        const types = (await dmmfOf(typed)).datamodel.models.flatMap((m) => m.fields.map((f) => `${m.name}.${f.name}:${f.type}`));
        expect(types).toEqual(expect.arrayContaining(['staff.bio:Json', 'staff.notes:String', 'staff.first_name:String', 'departments.settings:Json']));
        // Nothing to do
        expect(typeJsonColumns(source, dmmf, []).fields).toEqual([]);
    });
});

describe('writeSchema', () => {
    let root: string;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-schema-'));
        fs.mkdirSync(path.join(root, 'prisma'));
        fs.writeFileSync(path.join(root, 'prisma', 'schema.prisma'), HR);
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('formats, validates and keeps the previous version', async () => {
        const dmmf = await dmmfOf(HR);
        await writeSchema(root, renameRelations(HR, dmmf, { employees: { other_employees: 'reports' } }));
        const written = fs.readFileSync(path.join(root, 'prisma', 'schema.prisma'), 'utf8');
        // Aligned again by prisma format
        expect(written).toMatch(/\n {2}reports {9}employees\[\] +@relation\("employeesToemployees"\)/);
        expect(fs.readFileSync(path.join(root, 'prisma', 'schema.prisma.bak'), 'utf8')).toBe(HR);
    });

    it('an invalid schema is not written', async () => {
        await expect(writeSchema(root, HR.replace('Int?', 'Nope?'))).rejects.toThrow(SchemaEditError);
        expect(fs.readFileSync(path.join(root, 'prisma', 'schema.prisma'), 'utf8')).toBe(HR);
    });
});
