import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import vm from 'vm';
import type { AddressInfo } from 'net';
import { readSchema } from '../../src/setup/project';
import { className, modelsOverview, routePrefixes } from '../../src/setup/models';
import type { ModelOverview } from '../../src/setup/models';
import { buildRuns } from '../../src/setup/actions';
import { rlsStatements, rlsWarnings, rlsActive, RlsSpecError } from '../../src/setup/rls';
import type { RlsStatus } from '../../src/setup/rls';
import { testService } from '../../src/setup/services';
import { setupReasons, wizardMode } from '../../src/setup';
import { wizardScript, wizardPage, passwordPage } from '../../src/setup/ui';

const SCHEMA = `datasource db {
  provider = "postgresql"
}
enum Role {
  ADMIN
  STAFF
}
model user {
  id        Int     @id @default(autoincrement())
  email     String  @unique
  password  String
  role      Role    @default(STAFF)
  tenant_id Int?
  api_token String?
  orders    order[]
}
model order {
  id      Int          @id @default(autoincrement())
  user_id Int
  user    user         @relation(fields: [user_id], references: [id])
  items   order_item[]
  @@map("orders")
}
model product {
  id    Int          @id
  items order_item[]
}
model order_item {
  order_id   Int
  product_id Int
  order      order   @relation(fields: [order_id], references: [id])
  product    product @relation(fields: [product_id], references: [id])
  @@id([order_id, product_id])
}
model audit {
  a Int
  b Int
  c Int
  @@id([a, b, c])
}
`;

function tempProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-wizard-unit-'));
    fs.mkdirSync(path.join(dir, 'prisma'));
    fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), SCHEMA);
    return dir;
}

describe('data model overview', () => {
    let dir: string;
    beforeAll(() => { dir = tempProject(); });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('names model classes like @rapidd/build', () => {
        expect(className('order_item')).toBe('OrderItem');
        expect(className('user')).toBe('User');
        expect(className('api-key')).toBe('ApiKey');
    });

    it('per model: table, key, generated files, the route @rapidd/build gives it, credentials', async () => {
        fs.mkdirSync(path.join(dir, 'src', 'models'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'models', 'User.ts'), '');
        fs.mkdirSync(path.join(dir, 'routes', 'api', 'v1', 'order'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'routes', 'api', 'v1', 'order', 'index.ts'), '');
        const { dmmf } = await readSchema(dir);
        const models = modelsOverview(dir, dmmf, ['product']);
        const by = Object.fromEntries(models.map((m) => [m.name, m]));
        expect(by.user).toMatchObject({ table: 'user', key: ['id'], modelFile: { path: path.join('src', 'models', 'User.ts'), exists: true },
            route: { kind: 'route', url: '/api/v1/user', exists: false }, code: false, sensitive: ['password', 'api_token'] });
        expect(by.order).toMatchObject({ table: 'orders', route: { kind: 'route', exists: true }, relations: { user: 'user', items: 'order_item' } });
        expect(by.order.fields.map((f) => f.name)).toEqual(['id', 'user_id']);
        expect(by.order_item.route).toMatchObject({ kind: 'nested', parents: ['order', 'product'] });
        // A key of three columns is a route of its own: /api/v1/audit/1~2~3
        expect(by.audit).toMatchObject({ key: ['a', 'b', 'c'], route: { kind: 'route', url: '/api/v1/audit' } });
        expect(by.product.code).toBe(true);
        expect(routePrefixes(models)).toEqual(['/auth/login', '/auth/refresh', '/auth', '/api/v1', '/api/v1/user', '/api/v1/order', '/api/v1/product', '/api/v1/audit']);
    });
});

describe('user table under another name', () => {
    it('tables with a password column and a unique text identifier are suggested', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-wizard-users-'));
        try {
            fs.mkdirSync(path.join(dir, 'prisma'));
            fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), `datasource db {
  provider = "mysql"
}
model employees {
  id       Int    @id
  email    String @unique
  password String
}
model projects {
  id   Int    @id
  name String @unique
}
`);
            const { inspectProject, userModelCandidates } = await import('../../src/setup/project');
            const { validate, buildSections } = await import('../../src/setup/settings');
            const project = await inspectProject(dir, { DATABASE_URL: 'mysql://u:p@h/db' });
            expect(project.userModel).toBeNull();
            expect(project.userModelCandidates).toEqual(['employees']);
            expect(userModelCandidates((await readSchema(dir)).dmmf!)).toEqual(['employees']);
            const warning = validate({ DATABASE_URL: 'mysql://u:p@h/db' }, buildSections(), project).warnings.AUTH_PROVIDERS;
            expect(warning).toMatch(/employees looks like one: set it as the user table \(DB_USER_TABLE\)/);
            // Once chosen, nothing to suggest
            expect((await inspectProject(dir, { DATABASE_URL: 'mysql://u:p@h/db', DB_USER_TABLE: 'employees' })).userModelCandidates).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('a password column under another name', () => {
    it('DB_USER_PASSWORD_FIELD makes it a credential the overview warns about', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-wizard-password-'));
        try {
            fs.mkdirSync(path.join(dir, 'prisma'));
            fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), `datasource db {
  provider = "postgresql"
}
model members {
  id       Int    @id
  login    String @unique
  kennwort String
}
`);
            const { inspectProject } = await import('../../src/setup/project');
            const project = await inspectProject(dir, { DATABASE_URL: 'postgresql://u:p@h/db', DB_USER_TABLE: 'members', DB_USER_PASSWORD_FIELD: 'kennwort' });
            const { dmmf } = await readSchema(dir);
            expect(modelsOverview(dir, dmmf, [], project.userModel)[0].sensitive).toEqual(['kennwort']);
            expect(modelsOverview(dir, dmmf, [])[0].sensitive).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('rapidd build runs', () => {
    const all = ['user', 'order', 'product'];
    const modern = { installed: true, modelList: true, skipGenerate: true };
    const legacy = { installed: true, modelList: false, skipGenerate: false };

    it('one run per component — the client is generated once', () => {
        expect(buildRuns({}, all, modern)).toEqual([['build', '--only', 'model'], ['build', '--only', 'route', '--skip-generate']]);
        expect(buildRuns({ models: all, components: ['route'] }, all, modern)).toEqual([['build', '--only', 'route']]);
    });

    it('some models: one list, or one run per model for an older @rapidd/build', () => {
        expect(buildRuns({ models: ['user', 'order'], components: ['model'] }, all, modern)).toEqual([['build', '--model', 'user,order', '--only', 'model']]);
        expect(buildRuns({ models: ['user', 'order', 'ghost'], components: ['model'] }, all, legacy))
            .toEqual([['build', '--model', 'user', '--only', 'model'], ['build', '--model', 'order', '--only', 'model']]);
    });
});

describe('row-level security SQL', () => {
    const models: ModelOverview[] = [{
        name: 'post', table: 'Post"s', key: ['id'], relations: {}, relationFields: [], sensitive: [], code: false,
        modelFile: { path: '', exists: false }, route: { kind: 'route', url: '/api/v1/post', file: null, exists: false },
        fields: [
            { name: 'id', column: 'id', type: 'Int', kind: 'scalar', isList: false, isId: true, isRequired: true },
            { name: 'ownerId', column: 'owner_id', type: 'Int', kind: 'scalar', isList: false, isId: false, isRequired: true },
            { name: 'tenant', column: 'tenant', type: 'String', kind: 'scalar', isList: false, isId: false, isRequired: true },
            { name: 'tags', column: 'tags', type: 'String', kind: 'scalar', isList: true, isId: false, isRequired: true },
        ],
    }];
    const values = { DATABASE_URL: 'postgresql://u:p@h/db?schema=crm' };

    it('a policy from conditions: quoted names, settings as text, enable + force first', () => {
        expect(rlsStatements({ op: 'create', policy: {
            model: 'post', command: 'ALL', match: [{ field: 'ownerId', variable: 'current_user_id' }],
            bypass: { variable: 'current_user_role', value: 'admin' }, force: true,
        } }, models, values)).toEqual([
            'ALTER TABLE "crm"."Post""s" ENABLE ROW LEVEL SECURITY;',
            'ALTER TABLE "crm"."Post""s" FORCE ROW LEVEL SECURITY;',
            'CREATE POLICY "Post_s_all_current_user_id_admin" ON "crm"."Post""s"\n    FOR ALL\n'
                + "    USING ((\"owner_id\"::text = current_setting('app.current_user_id', true)) OR current_setting('app.current_user_role', true) = 'admin')\n"
                + "    WITH CHECK ((\"owner_id\"::text = current_setting('app.current_user_id', true)) OR current_setting('app.current_user_role', true) = 'admin');",
        ]);
    });

    it('USING for reads and deletes, WITH CHECK for inserts; OR; the namespace', () => {
        const [insert] = rlsStatements({ op: 'create', policy: { model: 'post', name: 'p_ins', command: 'INSERT', enable: false,
            match: [{ field: 'tenant', variable: 'tenant_id' }] } }, models, { ...values, RLS_NAMESPACE: 'acme' });
        expect(insert).toBe("CREATE POLICY \"p_ins\" ON \"crm\".\"Post\"\"s\"\n    FOR INSERT\n    WITH CHECK (\"tenant\"::text = current_setting('acme.tenant_id', true));");
        const [select] = rlsStatements({ op: 'create', policy: { model: 'post', name: 'p_sel', command: 'SELECT', enable: false, combine: 'OR',
            match: [{ field: 'tenant', variable: 'a' }, { field: 'ownerId', variable: 'b' }] } }, models, values);
        expect(select).toContain("USING (\"tenant\"::text = current_setting('app.a', true) OR \"owner_id\"::text = current_setting('app.b', true))");
        expect(select).not.toContain('WITH CHECK');
    });

    it('table changes', () => {
        expect(rlsStatements({ op: 'drop', model: 'post', name: 'x"y' }, models, values)).toEqual(['DROP POLICY "x""y" ON "crm"."Post""s";']);
        expect(rlsStatements({ op: 'noforce', model: 'post' }, models, {})).toEqual(['ALTER TABLE "public"."Post""s" NO FORCE ROW LEVEL SECURITY;']);
        expect(rlsStatements({ op: 'disable', model: 'post' }, models, values)).toEqual(['ALTER TABLE "crm"."Post""s" DISABLE ROW LEVEL SECURITY;']);
    });

    it('refuses what it cannot generate safely', () => {
        const create = (policy: object, v: Record<string, string> = values) => () => rlsStatements({ op: 'create', policy: { model: 'post', command: 'ALL', match: [], ...policy } as any }, models, v);
        expect(create({ model: 'ghost' })).toThrow('Unknown model: ghost');
        expect(create({ match: [{ field: 'nope', variable: 'v' }] })).toThrow('post has no column nope');
        expect(create({ match: [{ field: 'tags', variable: 'v' }] })).toThrow('post has no column tags');
        expect(create({ match: [{ field: 'tenant', variable: "x', true) OR true OR ('" }] })).toThrow(RlsSpecError);
        expect(create({ bypass: { variable: 'role', value: "admin' OR '1'='1" } })).toThrow('The value uses');
        expect(create({})).toThrow('Add a condition');
        expect(create({ command: 'TRUNCATE', bypass: { variable: 'r', value: 'a' } })).toThrow('Command');
        expect(create({ name: 'bad name', bypass: { variable: 'r', value: 'a' } })).toThrow('Policy names');
        expect(create({ bypass: { variable: 'r', value: 'a' } }, { ...values, RLS_NAMESPACE: 'app.x' })).toThrow('RLS_NAMESPACE');
    });

    it('RLS_ENABLED: on for PostgreSQL unless turned off', () => {
        expect(rlsActive({ DATABASE_URL: 'postgresql://h/db' })).toBe(true);
        expect(rlsActive({ DATABASE_URL: 'mysql://h/db' })).toBe(false);
        expect(rlsActive({ DATABASE_URL: 'mysql://h/db', RLS_ENABLED: 'true' })).toBe(false); // MySQL has no RLS
        expect(rlsActive({ DATABASE_URL: 'postgresql://h/db', RLS_ENABLED: 'false' })).toBe(false);
    });

    it('warns about what keeps the policies from working', () => {
        const status = (patch: Partial<RlsStatus>): RlsStatus => ({
            provider: 'postgresql', supported: true, active: true, namespace: 'app', schema: 'public',
            connection: { user: 'app', superuser: false, bypassrls: false }, admin: null,
            tables: [
                { model: 'user', table: 'user', exists: true, enabled: true, forced: false, owner: 'owner', policies: [{ name: 'p', command: 'SELECT', permissive: true, roles: [], using: 'x', check: null }] },
                { model: 'post', table: 'post', exists: true, enabled: true, forced: false, owner: 'app', policies: [] },
            ],
            warnings: [], ...patch,
        });
        const all = rlsWarnings(status({}), 'user');
        expect(all).toEqual([
            "The API's role app owns post — owners skip policies unless the table FORCEs row-level security.",
            'Row-level security is on without a policy for post — no row is visible to roles it binds.',
            'Sign-in reads user before any variable is set — set DATABASE_URL_ADMIN to a role that bypasses its policies (its owner without FORCE, or a role with BYPASSRLS).',
        ]);
        // The owner of the user table signs in: its policies do not bind it
        expect(rlsWarnings(status({ admin: { user: 'owner', superuser: false, bypassrls: false } }), 'user')).toHaveLength(2);
        expect(rlsWarnings(status({ connection: { user: 'root', superuser: true, bypassrls: false } }), 'user')[0]).toMatch(/superuser/);
        expect(rlsWarnings(status({ connection: { user: 'svc', superuser: false, bypassrls: true } }), null)[0]).toMatch(/BYPASSRLS/);
        expect(rlsWarnings(status({ active: false }), null)).toContain('RLS_ENABLED is off: the API sets no variables, so policies that read them hide every row from it.');
    });
});

describe('service test calls', () => {
    let server: http.Server;
    let port: number;
    const seen: { method?: string; url?: string; auth?: string; header?: string }[] = [];
    beforeAll(async () => {
        server = http.createServer((req, res) => {
            seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, header: req.headers['x-team'] as string });
            if (req.url!.startsWith('/v1/fail')) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('down'); return; }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, path: req.url }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as AddressInfo).port;
    });
    afterAll(() => server.close());

    const config = () => JSON.stringify({ services: { Shop: {
        hostname: '127.0.0.1', port, secure: false, path: '/v1',
        headers: { 'X-Team': '${TEAM:-core}' }, queries: { api_key: 'k-123' },
        authorization: { type: 'bearer', token: '${SHOP_TOKEN}' },
        endpoints: { item: { path: '/items/{{id}}' }, fail: { path: '/fail', method: 'POST' } },
    } } });

    it('calls the endpoint with the unsaved settings; masks secret query values', async () => {
        const r = await testService(config(), 'Shop', 'item', { id: 'a b' }, { SHOP_TOKEN: 'tok-1' });
        expect(r).toMatchObject({ ok: true, status: 200, method: 'GET', contentType: 'application/json' });
        expect(r.url).toBe(`http://127.0.0.1:${port}/v1/items/a b?api_key=••••`);
        expect(JSON.parse(r.preview!)).toEqual({ ok: true, path: '/v1/items/a%20b?api_key=k-123' });
        expect(seen.at(-1)).toMatchObject({ auth: 'Bearer tok-1', header: 'core' });
        expect(r.missing).toBeUndefined();
    });

    it('reports errors, missing variables, unknown services and endpoints', async () => {
        expect(await testService(config(), 'Shop', 'fail', {}, { SHOP_TOKEN: 't' })).toMatchObject({ ok: false, status: 503, method: 'POST', preview: 'down' });
        // An unset credential: nothing is sent
        expect(await testService(config(), 'Shop', 'item', { id: '1' }, {})).toMatchObject({ ok: false, message: 'Bearer auth requires token', missing: ['SHOP_TOKEN'] });
        expect(await testService(config(), 'Nope', 'item', {}, {})).toEqual({ ok: false, message: 'No service Nope' });
        expect((await testService(config(), 'Shop', 'ghost', {}, {})).message).toMatch(/Endpoint 'ghost' not found/);
        expect((await testService('{ broken', 'Shop', 'item', {}, {})).message).toMatch(/^config\/app.json:/);
        const free = http.createServer();
        await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve));
        const closedPort = (free.address() as AddressInfo).port;
        await new Promise((resolve) => free.close(resolve));
        const closed = JSON.stringify({ services: { Down: { hostname: '127.0.0.1', port: closedPort, secure: false, endpoints: { x: { path: '/' } } } } });
        expect(await testService(closed, 'Down', 'x', {}, {})).toMatchObject({ ok: false, message: expect.stringMatching(/ECONNREFUSED/) });
        const blocked = JSON.stringify({ services: { Blocked: { hostname: '127.0.0.1', port: 25, secure: false, endpoints: { x: { path: '/' } } } } });
        expect(await testService(blocked, 'Blocked', 'x', {}, {})).toMatchObject({ ok: false, message: 'fetch failed: bad port' });
    });
});

describe('setup reasons and wizard mode', () => {
    let dir: string;
    const saved = { ...process.env };
    beforeEach(() => {
        dir = tempProject();
        fs.mkdirSync(path.join(dir, 'prisma', 'client'));
        fs.writeFileSync(path.join(dir, 'prisma', 'client', 'index.js'), 'module.exports = {};');
        fs.mkdirSync(path.join(dir, 'config'));
        process.env.DATABASE_URL = 'postgresql://u:p@h/db';
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    });

    it('a broken config/rls.json keeps the API from starting', async () => {
        fs.writeFileSync(path.join(dir, 'config', 'rls.json'), '{ broken');
        const reasons = await setupReasons(dir);
        expect(reasons.map((r) => r.key)).toEqual([path.join('config', 'rls.json')]);
        expect(reasons.every((r) => !r.message.includes(dir))).toBe(true);
    });

    it('SETUP_WIZARD: auto, on or off', () => {
        delete process.env.SETUP_WIZARD;
        expect(wizardMode()).toBe('auto');
        process.env.SETUP_WIZARD = 'ON';
        expect(wizardMode()).toBe('on');
        process.env.SETUP_WIZARD = 'off';
        expect(wizardMode()).toBe('off');
        process.env.SETUP_WIZARD = 'sometimes';
        expect(wizardMode()).toBe('auto');
    });
});

describe('wizard page', () => {
    it('ships one script that parses — module code only, no imports', () => {
        const script = wizardScript();
        expect(() => new vm.Script(script)).not.toThrow();
        expect(script).not.toMatch(/\brequire\(|\bexports\.|import\(/);
        for (const page of ['overview', 'database', 'model', 'signin', 'admin', 'rls', 'ratelimits', 'services', 'environment', 'review']) {
            expect(script).toContain(`id: '${page}'`);
        }
    });

    it('nonce on every inline script and style; the sign-in page escapes its message', () => {
        const page = wizardPage('n0nce');
        expect(page.match(/<script/g)!.length).toBe(page.match(/<script nonce="n0nce">/g)!.length);
        expect(page).toContain('<style nonce="n0nce">');
        expect(passwordPage('n', '<b>wrong</b>')).toContain('&lt;b&gt;wrong&lt;/b&gt;');
    });
});
