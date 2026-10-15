/**
 * The setup wizard's index analysis against real databases: the lookups no index serves,
 * built (PostgreSQL: CONCURRENTLY) and added to the schema; an index the schema lists but the
 * database lacks; the migration path. Afterwards Prisma finds no difference between the
 * database and the schema.
 * Opt-in: `bash __test__/integration/setup.sh && RAPIDD_IT=1 npx jest __test__/integration/indexes --forceExit`
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { analyzeIndexes, applyIndexes } from '../../src/setup/indexes';
import { runPrisma } from '../../src/setup/actions';
import { withPostgres, withMySQL } from '../../src/setup/checks';

const run = process.env.RAPIDD_IT === '1' ? describe : describe.skip;
jest.setTimeout(240_000);

const PG = 'postgresql://postgres:pw@127.0.0.1:56543';
const MARIADB = 'mysql://root:pw@127.0.0.1:53306';

const MODELS = `
model users {
  id    Int     @id @default(autoincrement())
  email String  @unique
  posts posts[]
}

model posts {
  id        Int         @id @default(autoincrement())
  author_id Int         @map("author")
  title     String
  author    users       @relation(fields: [author_id], references: [id])
  tags      post_tags[]
}

model tags {
  id    Int         @id @default(autoincrement())
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

const roots: string[] = [];
const databases: { provider: 'postgresql' | 'mysql'; name: string }[] = [];

/** A project as create-project makes it — in a temporary directory, with the framework's node_modules */
function project(provider: 'postgresql' | 'mysql', datasource = ''): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-indexes-it-'));
    roots.push(root);
    fs.symlinkSync(path.join(__dirname, '..', '..', 'node_modules'), path.join(root, 'node_modules'));
    fs.mkdirSync(path.join(root, 'prisma'));
    fs.writeFileSync(path.join(root, 'prisma', 'schema.prisma'),
        `generator client {\n  provider = "prisma-client-js"\n  output   = "client"\n}\n\ndatasource db {\n  provider = "${provider}"${datasource}\n}\n${MODELS}`);
    fs.writeFileSync(path.join(root, 'prisma.config.ts'),
        "import { defineConfig, env } from 'prisma/config';\n\nexport default defineConfig({\n    schema: 'prisma/schema.prisma',\n    migrations: { path: 'prisma/migrations' },\n    datasource: { url: env('DATABASE_URL') },\n});\n");
    return root;
}

async function database(provider: 'postgresql' | 'mysql'): Promise<string> {
    const name = `rapidd_idx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    databases.push({ provider, name });
    if (provider === 'postgresql') {
        await withPostgres(`${PG}/app`, (c) => c.query(`CREATE DATABASE ${name}`));
        return `${PG}/${name}?schema=public`;
    }
    await withMySQL(`${MARIADB}/app`, (c) => c.query(`CREATE DATABASE ${name}`));
    return `${MARIADB}/${name}`;
}

const schemaOf = (root: string) => fs.readFileSync(path.join(root, 'prisma', 'schema.prisma'), 'utf8');

/** Prisma's view: the database against the schema — exit 0 means no difference */
const inStep = async (root: string, values: Record<string, string>) =>
    (await runPrisma(['migrate', 'diff', '--from-config-datasource', '--to-schema', path.join(root, 'prisma', 'schema.prisma'), '--exit-code'], values, root)).code;

afterAll(async () => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    for (const { provider, name } of databases) {
        if (provider === 'postgresql') await withPostgres(`${PG}/app`, (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).catch(() => undefined);
        else await withMySQL(`${MARIADB}/app`, (c) => c.query(`DROP DATABASE IF EXISTS ${name}`)).catch(() => undefined);
    }
});

run('indexes ↔ real databases', () => {
    it('PostgreSQL: foreign keys without an index — built concurrently, added to the schema; then one the schema lists but the database lacks', async () => {
        const root = project('postgresql');
        const values = { DATABASE_URL: await database('postgresql') };
        expect((await runPrisma(['db', 'push'], values, root)).code).toBe(0);
        await withPostgres(values.DATABASE_URL, async (c) => {
            await c.query(`INSERT INTO users (email) SELECT 'u' || g || '@example.com' FROM generate_series(1, 50) g`);
            await c.query(`INSERT INTO posts (author, title) SELECT 1 + g % 50, 'post ' || g FROM generate_series(1, 5000) g`);
            await c.query('ANALYZE');
        });

        const analysis = await analyzeIndexes(root, values);
        expect(analysis).toMatchObject({ provider: 'postgresql', via: 'database', database: { checked: true } });
        expect(analysis.suggestions.map((s) => [s.id, s.rows, s.statement])).toEqual([
            ['posts:author_id', 5000, 'CREATE INDEX "posts_author_idx" ON "posts"("author");'],
            ['post_tags:tag_id', 0, 'CREATE INDEX "post_tags_tag_id_idx" ON "post_tags"("tag_id");'],
        ]);

        const applied = await applyIndexes(root, values, analysis.suggestions.map((s) => s.id));
        expect(applied).toMatchObject({ ok: true, message: '2 indexes built and added to prisma/schema.prisma' });
        expect(applied.output).toContain('✓ CREATE INDEX CONCURRENTLY "posts_author_idx" ON "posts"("author");');
        const built = await withPostgres(values.DATABASE_URL, async (c) => (await c.query(
            `SELECT i.relname AS name, ix.indisvalid AS valid FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
              WHERE i.relname IN ('posts_author_idx', 'post_tags_tag_id_idx') ORDER BY 1`)).rows);
        expect(built).toEqual([{ name: 'post_tags_tag_id_idx', valid: true }, { name: 'posts_author_idx', valid: true }]);
        expect(schemaOf(root)).toContain('@@index([author_id])');
        expect(schemaOf(root)).toContain('@@index([tag_id])');
        expect(await inStep(root, values)).toBe(0);
        expect((await analyzeIndexes(root, values)).suggestions).toEqual([]);

        // An index written into the schema, never created in the database
        fs.writeFileSync(path.join(root, 'prisma', 'schema.prisma'), schemaOf(root).replace('@@index([author_id])', '@@index([author_id])\n  @@index([title])'));
        const behind = await analyzeIndexes(root, values);
        expect(behind.suggestions.map((s) => [s.id, s.source, s.name])).toEqual([['posts:title', 'schema', 'posts_title_idx']]);
        expect(await applyIndexes(root, values, ['posts:title'])).toMatchObject({ ok: true, message: '1 index built' });
        expect(schemaOf(root).match(/@@index\(\[title\]\)/g)).toHaveLength(1);
        expect(await inStep(root, values)).toBe(0);
    });

    it('MariaDB indexes foreign keys by itself — without them (relationMode = "prisma") the relation columns are built online', async () => {
        const withKeys = project('mysql');
        const keyed = { DATABASE_URL: await database('mysql') };
        expect((await runPrisma(['db', 'push'], keyed, withKeys)).code).toBe(0);
        const nothing = await analyzeIndexes(withKeys, keyed);
        expect(nothing).toMatchObject({ provider: 'mysql', database: { checked: true }, suggestions: [] });
        expect(nothing.notes).toContain('MySQL indexes foreign keys by itself');

        const root = project('mysql', '\n  relationMode = "prisma"');
        const values = { DATABASE_URL: await database('mysql') };
        expect((await runPrisma(['db', 'push'], values, root)).code).toBe(0);
        const analysis = await analyzeIndexes(root, values);
        expect(analysis.suggestions.map((s) => [s.id, s.statement])).toEqual([
            ['post_tags:tag_id', 'CREATE INDEX `post_tags_tag_id_idx` ON `post_tags`(`tag_id`);'],
            ['posts:author_id', 'CREATE INDEX `posts_author_idx` ON `posts`(`author`);'],
        ]);
        expect(await applyIndexes(root, values, analysis.suggestions.map((s) => s.id))).toMatchObject({ ok: true, message: '2 indexes built and added to prisma/schema.prisma' });
        const built: any[] = await withMySQL(values.DATABASE_URL, (c) => c.query(
            "SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME LIKE '%\\_idx' ORDER BY 1"));
        expect(built.map((r: any) => r.name).sort()).toEqual(['post_tags_tag_id_idx', 'posts_author_idx']);
        expect(await inStep(root, values)).toBe(0);
        expect((await analyzeIndexes(root, values)).suggestions).toEqual([]);
    });

    it('with prisma/migrations: a migration of Prisma\'s SQL, deployed', async () => {
        const root = project('postgresql');
        const values = { DATABASE_URL: await database('postgresql') };
        const migrations = path.join(root, 'prisma', 'migrations');
        fs.mkdirSync(path.join(migrations, '0_init'), { recursive: true });
        fs.writeFileSync(path.join(migrations, 'migration_lock.toml'), 'provider = "postgresql"\n');
        expect((await runPrisma(['migrate', 'diff', '--from-empty', '--to-schema', path.join(root, 'prisma', 'schema.prisma'), '--script', '--output', path.join(migrations, '0_init', 'migration.sql')], values, root)).code).toBe(0);
        expect((await runPrisma(['migrate', 'deploy'], values, root)).code).toBe(0);

        const analysis = await analyzeIndexes(root, values);
        expect(analysis.via).toBe('migration');
        const applied = await applyIndexes(root, values, analysis.suggestions.map((s) => s.id));
        expect(applied).toMatchObject({ ok: true, message: expect.stringMatching(/^2 indexes added — migration \d{14}_add_indexes, deployed$/) });
        const folders = fs.readdirSync(migrations).filter((f) => f !== 'migration_lock.toml').sort();
        expect(folders).toEqual(['0_init', expect.stringMatching(/^\d{14}_add_indexes$/)]);
        const sql = fs.readFileSync(path.join(migrations, folders[1], 'migration.sql'), 'utf8');
        expect(sql).toContain('-- CreateIndex\nCREATE INDEX "posts_author_idx" ON "posts"("author");');
        expect(sql).toContain('-- CreateIndex\nCREATE INDEX "post_tags_tag_id_idx" ON "post_tags"("tag_id");');
        const deployed = await withPostgres(values.DATABASE_URL, async (c) => (await c.query(
            'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY 1')).rows.map((r: any) => r.migration_name));
        expect(deployed).toEqual(folders);
        expect(await inStep(root, values)).toBe(0);
        expect((await analyzeIndexes(root, values)).suggestions).toEqual([]);
    });
});
