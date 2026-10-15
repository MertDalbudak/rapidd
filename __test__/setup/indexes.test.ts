/**
 * The setup wizard's index analysis: the lookups the API makes (foreign keys, acl.ts filters,
 * sign-in), whether an index of the schema or the database serves them, and the schema edits
 * and SQL that add them — against a real DMMF.
 */
import { describeUserModel } from '../../src/setup/project';
import {
    accessFilterFields, covers, indexStatements, lookups, parseCreateIndex, sampleUser, schemaWithIndexes,
    schemaWithoutIndexes, signInLookups, suggestIndexes,
} from '../../src/setup/indexes';
import type { DbIndexes } from '../../src/setup/indexes';
import type { DMMF } from '../../src/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDMMF } = require('@prisma/internals');

const SCHEMA = (provider = 'postgresql', extra = '') => `datasource db {
  provider = "${provider}"${extra}
}

enum Status {
  DRAFT
  PUBLISHED
}

model users {
  id        Int       @id @default(autoincrement())
  email     String    @unique
  username  String
  is_admin  Boolean   @default(false)
  tenant_id Int
  posts     posts[]
  profile   profiles?

  @@map("app_users")
}

model profiles {
  id      Int   @id
  user_id Int   @unique
  user    users @relation(fields: [user_id], references: [id])
}

model posts {
  id        Int         @id @default(autoincrement())
  author_id Int         @map("author")
  title     String
  status    Status      @default(DRAFT)
  published Boolean     @default(false)
  tenant_id Int
  author    users       @relation(fields: [author_id], references: [id])
  tags      post_tags[]
  comments  comments[]
}

model comments {
  id      Int   @id
  post_id Int
  post    posts @relation(fields: [post_id], references: [id], onDelete: Cascade)

  @@index([post_id, id])
}

model tags {
  id    Int         @id
  posts post_tags[]
}

model post_tags {
  post_id Int
  tag_id  Int
  post    posts @relation(fields: [post_id], references: [id])
  tag     tags  @relation(fields: [tag_id], references: [id])

  @@id([post_id, tag_id])
}
`;

const dmmfOf = (source: string): Promise<DMMF> => getDMMF({ datamodel: source });
const ids = (list: { id: string }[]) => list.map((s) => s.id).sort();

describe('lookups', () => {
    it('PostgreSQL: every foreign key — a wider one serves the narrower', async () => {
        const found = lookups(await dmmfOf(SCHEMA()), { provider: 'postgresql', relationMode: 'foreignKeys' });
        expect(found.map((l) => `${l.model}:${l.fields.join(',')}`).sort())
            .toEqual(['comments:post_id', 'post_tags:post_id', 'post_tags:tag_id', 'posts:author_id', 'profiles:user_id']);
        expect(found.find((l) => l.model === 'posts')!.reasons[0]).toMatchObject({ kind: 'foreign-key', text: 'References users: includes and nested routes find rows by it, and so does each delete in users' });
    });

    it('MySQL indexes foreign keys by itself — unless relationMode = "prisma" leaves them out', async () => {
        const dmmf = await dmmfOf(SCHEMA('mysql'));
        expect(lookups(dmmf, { provider: 'mysql', relationMode: 'foreignKeys' })).toEqual([]);
        expect(lookups(dmmf, { provider: 'mysql', relationMode: 'prisma' })).toHaveLength(5);
    });

    it('acl.ts filter columns and sign-in join them — flags and enums are no index of their own', async () => {
        const dmmf = await dmmfOf(SCHEMA());
        const found = lookups(dmmf, {
            provider: 'postgresql', relationMode: 'foreignKeys',
            access: { posts: ['tenant_id', 'author_id', 'published', 'status'] },
            signIn: [{ model: 'users', field: 'username', text: 'Password sign-in finds users by it' }],
        });
        const posts = found.filter((l) => l.model === 'posts');
        expect(posts.map((l) => l.fields.join(','))).toEqual(['author_id', 'tenant_id']);
        expect(posts[0].reasons.map((r) => r.kind)).toEqual(['foreign-key', 'access']);
        expect(found.find((l) => l.model === 'users')).toMatchObject({ fields: ['username'], reasons: [{ kind: 'sign-in' }] });
    });

    it('an index serves the lookups by its first columns, in any order', () => {
        expect(covers([['a', 'b']], ['a'])).toBe(true);
        expect(covers([['a', 'b']], ['b', 'a'])).toBe(true);
        expect(covers([['a', 'b']], ['b'])).toBe(false);
        expect(covers([['a']], ['a', 'b'])).toBe(false);
        expect(covers([], ['a'])).toBe(false);
    });
});

describe('the filters src/config/acl.ts applies to every read', () => {
    it('getAccessFilter asked for a regular user — through AND and OR, not NOT; a hook that throws is skipped', async () => {
        const dmmf = await dmmfOf(SCHEMA());
        const user = sampleUser(dmmf, 'users');
        expect(user).toMatchObject({ id: 1, is_admin: false, tenant_id: 1, email: 'x', groups: [], roles: [] });
        const acl = {
            model: {
                posts: { getAccessFilter: (u: any) => (u.is_admin ? true : { tenant_id: u.tenant_id, AND: [{ OR: [{ author_id: u.id }, { published: true }] }], NOT: { title: 'x' }, author: { is_admin: false } }) },
                comments: { getAccessFilter: () => true },
                tags: { getAccessFilter: (u: any) => ({ id: u.group.id }) },
            },
        };
        expect(accessFilterFields(acl as any, dmmf, user)).toEqual({ posts: ['tenant_id', 'author_id', 'published'] });
    });
});

describe('sign-in lookups', () => {
    it('password sign-in by the identifier columns; external sign-in by the link column', async () => {
        const dmmf = await dmmfOf(SCHEMA());
        const configured = describeUserModel(dmmf, { DB_USER_TABLE: 'users', DB_USER_IDENTIFIER_FIELDS: 'username' });
        expect(signInLookups({}, configured, 'postgresql').lookups).toEqual([{ model: 'users', field: 'username', text: 'Password sign-in finds users by it' }]);

        const detected = describeUserModel(dmmf, { DB_USER_TABLE: 'users' });
        const both = signInLookups({ AUTH_PROVIDERS: 'local,oidc', AUTH_LINK: 'username' }, detected, 'postgresql');
        expect(both.lookups.map((l) => l.field)).toEqual(['email', 'username']);
        expect(both.lookups[1].text).toBe('Sign-in through oidc links accounts by it');
    });

    it('PostgreSQL links by email case-insensitively — no plain index serves that, so a note instead', async () => {
        const user = describeUserModel(await dmmfOf(SCHEMA()), { DB_USER_TABLE: 'users' });
        const pg = signInLookups({ AUTH_PROVIDERS: 'oidc' }, user, 'postgresql');
        expect(pg.lookups).toEqual([]);
        expect(pg.notes[0]).toMatch(/case-insensitively/);
        expect(signInLookups({ AUTH_PROVIDERS: 'oidc' }, user, 'mysql').lookups).toEqual([{ model: 'users', field: 'email', text: expect.any(String) }]);
        expect(signInLookups({ AUTH_PROVIDERS: 'oidc', AUTH_LINK: 'false' }, user, 'mysql').lookups).toEqual([]);
        expect(signInLookups({ AUTH_PROVIDERS: 'none' }, user, 'mysql').lookups).toEqual([]);
    });
});

describe('suggestions', () => {
    const fk = async (provider = 'postgresql') => {
        const dmmf = await dmmfOf(SCHEMA(provider));
        return { dmmf, found: lookups(dmmf, { provider, relationMode: 'foreignKeys', access: { posts: ['tenant_id'] } }) };
    };

    it('from the schema alone: what no @id, @unique or @@index starts with — under the table\'s column names', async () => {
        const { dmmf, found } = await fk();
        const suggested = suggestIndexes(dmmf, found, null);
        expect(ids(suggested)).toEqual(['post_tags:tag_id', 'posts:author_id', 'posts:tenant_id']);
        expect(suggested.find((s) => s.id === 'posts:author_id')).toMatchObject({ table: 'posts', columns: ['author'], source: 'missing', rows: null, impact: 'medium' });
    });

    it('the database decides what exists: its own indexes count, an index the schema lists but it lacks is suggested, sizes rank them', async () => {
        const { dmmf, found } = await fk();
        const db: DbIndexes = {
            tables: [
                { table: 'app_users', rows: 40, seqScans: 0 }, { table: 'profiles', rows: 10, seqScans: 0 },
                { table: 'posts', rows: 250_000, seqScans: 7 }, { table: 'comments', rows: 30_000, seqScans: 900 },
                { table: 'post_tags', rows: 500, seqScans: 3 },
                // no table "tags": not created yet
            ],
            indexes: [
                { table: 'posts', name: 'posts_pkey', columns: ['id'], usable: true },
                { table: 'posts', name: 'by_author', columns: ['author', 'title'], usable: true },
                // a partial or invalid index serves no lookup
                { table: 'posts', name: 'tenant_partial', columns: ['tenant_id'], usable: false },
                { table: 'post_tags', name: 'post_tags_pkey', columns: ['post_id', 'tag_id'], usable: true },
                { table: 'profiles', name: 'profiles_user_id_key', columns: ['user_id'], usable: true },
                { table: 'comments', name: 'comments_pkey', columns: ['id'], usable: true },
            ],
        };
        const suggested = suggestIndexes(dmmf, found, db);
        expect(suggested.map((s) => [s.id, s.source, s.impact])).toEqual([
            ['posts:tenant_id', 'missing', 'high'],
            ['comments:post_id,id', 'schema', 'high'],
            ['post_tags:tag_id', 'missing', 'low'],
        ]);
        expect(suggested[1].reasons.map((r) => r.kind)).toEqual(['schema', 'foreign-key']);
    });
});

describe('lookups that start alike', () => {
    const TENANTS = `
datasource db {
  provider = "postgresql"
}
model users {
  tenant_id Int
  user_no   Int
  projects  projects[]
  @@id([tenant_id, user_no])
}
model projects {
  tenant_id  Int
  project_no Int
  owner_no   Int
  owner      users @relation(fields: [tenant_id, owner_no], references: [tenant_id, user_no])
  @@id([tenant_id, project_no])
}
`;

    it('one index for the unserved ones — a narrower one an index serves already lends it no reason', async () => {
        const dmmf = await dmmfOf(TENANTS);
        const found = lookups(dmmf, { provider: 'postgresql', relationMode: 'foreignKeys', access: { projects: ['tenant_id'], users: ['tenant_id'] } });
        // The key (tenant_id, project_no) serves the acl.ts lookup by tenant_id
        const [owner] = suggestIndexes(dmmf, found, null);
        expect(owner).toMatchObject({ id: 'projects:tenant_id,owner_no', reasons: [{ kind: 'foreign-key' }] });
        expect(owner.reasons).toHaveLength(1);

        // Not served: the wider index serves it too, and takes its reason
        const unkeyed = TENANTS.replace('@@id([tenant_id, project_no])', '@@id([project_no])');
        const dmmf2 = await dmmfOf(unkeyed);
        const suggested = suggestIndexes(dmmf2, lookups(dmmf2, { provider: 'postgresql', relationMode: 'foreignKeys', access: { projects: ['tenant_id'] } }), null);
        expect(suggested.map((s) => [s.id, s.reasons.map((r) => r.kind)])).toEqual([['projects:tenant_id,owner_no', ['foreign-key', 'access']]]);
    });
});

describe('the schema text', () => {
    it('@@index lines go before @@map, after an empty line — and the schema stays valid', async () => {
        const source = schemaWithIndexes(SCHEMA(), [
            { model: 'posts', fields: ['author_id'] },
            { model: 'users', fields: ['tenant_id', 'username'] },
            { model: 'post_tags', fields: ['tag_id'] },
        ]);
        expect(source).toContain('  comments  comments[]\n\n  @@index([author_id])\n}');
        expect(source).toContain('  profile   profiles?\n\n  @@index([tenant_id, username])\n  @@map("app_users")');
        expect(source).toContain('  @@id([post_id, tag_id])\n  @@index([tag_id])\n}');
        const indexes = ((await dmmfOf(source)).datamodel as any).indexes.filter((i: any) => i.type === 'normal');
        expect(indexes.map((i: any) => `${i.model}:${i.fields.map((f: any) => f.name).join(',')}`).sort())
            .toEqual(['comments:post_id,id', 'post_tags:tag_id', 'posts:author_id', 'users:tenant_id,username']);
    });

    it('an @@index line is removed by its fields and map name; one it cannot find is an error', () => {
        const source = SCHEMA().replace('@@index([post_id, id])', '@@index([post_id, id(sort: Desc)], map: "by_post")');
        expect(schemaWithoutIndexes(source, [{ model: 'comments', fields: ['post_id', 'id'], name: 'by_post' }])).not.toContain('@@index');
        expect(() => schemaWithoutIndexes(source, [{ model: 'comments', fields: ['post_id', 'id'] }])).toThrow(/not on a line of its own/);
        expect(() => schemaWithIndexes(source, [{ model: 'nope', fields: ['a'] }])).toThrow(/no model nope/);
    });
});

describe('Prisma\'s SQL', () => {
    it('only CREATE INDEX statements are taken — and read back as name, table and columns', () => {
        const script = '-- CreateIndex\nCREATE INDEX "posts_author_idx" ON "posts"("author");\n\n-- CreateIndex\nCREATE INDEX "x" ON "post_tags"("tag_id", "post_id" DESC);\n';
        expect(indexStatements(script)).toEqual(['CREATE INDEX "posts_author_idx" ON "posts"("author");', 'CREATE INDEX "x" ON "post_tags"("tag_id", "post_id" DESC);']);
        expect(indexStatements('-- This is an empty migration.')).toEqual([]);
        expect(() => indexStatements('CREATE INDEX "a" ON "t"("c");\nDROP TABLE "t";')).toThrow(/more than indexes: DROP TABLE/);

        expect(parseCreateIndex('CREATE INDEX "x" ON "post_tags"("tag_id", "post_id" DESC);')).toEqual({ name: 'x', table: 'post_tags', columns: ['tag_id', 'post_id'] });
        expect(parseCreateIndex('CREATE INDEX `t_name_idx` ON `t`(`name`(191), `b`);')).toEqual({ name: 't_name_idx', table: 't', columns: ['name', 'b'] });
        expect(parseCreateIndex('CREATE INDEX "i" ON "app"."t"("c");')).toEqual({ name: 'i', table: 't', columns: ['c'] });
    });
});
