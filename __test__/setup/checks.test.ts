import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCheck, explain } from '../../src/setup/checks';
import { describeUserModel, readConfigFile, findBin } from '../../src/setup/project';
import { adminStatus } from '../../src/setup/admin';
import { startMockIdp, MockIdp } from '../helpers/mockIdp';

describe('explain()', () => {
    it.each([
        ['ECONNREFUSED', /nothing is listening/],
        ['ENOTFOUND', /Host not found/],
        ['28P01', /Authentication failed/],
        ['3D000', /does not exist/],
        ['ER_ACCESS_DENIED_ERROR', /Authentication failed/],
        ['SELF_SIGNED_CERT_IN_CHAIN', /CA certificate/],
    ])('%s', (code, message) => {
        expect(explain(Object.assign(new Error('x'), { code }))).toMatch(message);
    });

    it('falls back to the first line of the message', () => {
        expect(explain(new Error('first\nsecond'))).toBe('first');
    });
});

describe('connection checks', () => {
    it('database: unreachable, and a missing connection string', async () => {
        expect(await runCheck('database', { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db' }))
            .toMatchObject({ ok: false, message: expect.stringContaining('Connection refused') });
        expect(await runCheck('database', { DATABASE_URL: 'mysql://u:p@127.0.0.1:1/db' }))
            .toMatchObject({ ok: false, message: expect.stringMatching(/refused|connect/i) });
        expect(await runCheck('database', {})).toMatchObject({ ok: false, message: 'No connection string' });
    });

    it('redis: not configured is fine; unreachable is not', async () => {
        expect(await runCheck('redis', {})).toMatchObject({ ok: true, message: expect.stringContaining('process memory') });
        expect(await runCheck('redis', { REDIS_URL: 'redis://127.0.0.1:1' }, { timeoutMs: 1000 })).toMatchObject({ ok: false });
    });

    it('ldap: configuration errors and unreachable servers, per server', async () => {
        expect(await runCheck('ldap', { LDAP_URL: 'ldap://127.0.0.1:1' }))
            .toMatchObject({ ok: false, message: expect.stringContaining('bindTemplate') });
        const r = await runCheck('ldap', { LDAP_URL: 'ldap://127.0.0.1:1,ldap://127.0.0.1:2', LDAP_BIND_TEMPLATE: '{{username}}@x' }, { timeoutMs: 1000 });
        expect(r.ok).toBe(false);
        expect(r.steps?.map((s) => s.target)).toEqual(['ldap://127.0.0.1:1', 'ldap://127.0.0.1:2']);
    });

    describe('oidc', () => {
        let idp: MockIdp;
        beforeAll(async () => { idp = await startMockIdp(); });
        afterAll(async () => { await idp.close(); });
        afterEach(() => { idp.reportedIssuer = undefined; idp.down = false; });

        it('discovery, signing keys and the redirect URI to register', async () => {
            const r = await runCheck('oidc', { OIDC_ISSUER: idp.issuer, PUBLIC_URL: 'https://api.example.com/' });
            expect(r).toMatchObject({ ok: true, details: { register_redirect_uri: 'https://api.example.com/auth/oidc/callback' } });
            expect(r.steps).toEqual(expect.arrayContaining([{ target: 'signing keys', ok: true, message: expect.stringMatching(/key/) }]));
        });

        it('an issuer that does not match the discovery document', async () => {
            idp.reportedIssuer = 'https://elsewhere.example.com';
            expect(await runCheck('oidc', { OIDC_ISSUER: idp.issuer }))
                .toMatchObject({ ok: false, message: expect.stringContaining('https://elsewhere.example.com') });
        });

        it('a provider that is down', async () => {
            idp.down = true;
            expect((await runCheck('oidc', { OIDC_ISSUER: idp.issuer })).ok).toBe(false);
        });
    });

    describe('webdav', () => {
        let server: http.Server;
        let url: string;
        beforeAll(async () => {
            server = http.createServer((req, res) => {
                const auth = req.headers.authorization;
                if (req.method === 'PROPFIND' && auth === `Basic ${Buffer.from('alice:secret').toString('base64')}`) {
                    res.writeHead(207, { 'content-type': 'application/xml' }).end('<multistatus/>');
                    return;
                }
                res.writeHead(401, { 'www-authenticate': 'Basic' }).end();
            });
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            url = `http://127.0.0.1:${(server.address() as any).port}/dav/{{username}}/`;
        });
        afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

        it('reachable, and the test sign-in decides', async () => {
            expect(await runCheck('webdav', { WEBDAV_URL: url })).toMatchObject({ ok: true });
            expect(await runCheck('webdav', { WEBDAV_URL: url }, { username: 'alice', password: 'secret' })).toMatchObject({ ok: true });
            const wrong = await runCheck('webdav', { WEBDAV_URL: url }, { username: 'alice', password: 'nope' });
            expect(wrong.ok).toBe(false);
            expect(wrong.steps?.[1]).toMatchObject({ ok: false, message: expect.stringContaining('rejected') });
        });

        it('missing URL', async () => {
            expect((await runCheck('webdav', {})).ok).toBe(false);
        });
    });
});

describe('project inspection', () => {
    const SCHEMA = `
datasource db {
  provider = "postgresql"
}
enum Role {
  USER
  ADMIN
}
model account {
  id         Int      @id @default(autoincrement())
  login      String   @unique
  email      String?  @unique
  hash       String
  role       Role     @default(USER)
  is_active  Boolean  @default(true)
  tenant_id  Int
  created_at DateTime @default(now())
  updated_at DateTime @updatedAt
  notes      String?
}`;

    it('describes what a first user needs, as Auth would detect it', async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const dmmf = await require('@prisma/internals').getDMMF({ datamodel: SCHEMA });
        const info = describeUserModel(dmmf, {})!;
        expect(info).toMatchObject({ model: 'account', passwordField: 'hash', identifierFields: ['login', 'email'] });
        expect(info.fields.map((f) => f.name)).toEqual(['login', 'email', 'role', 'is_active', 'tenant_id']);
        expect(info.fields.find((f) => f.name === 'role')).toMatchObject({ required: false, enumValues: ['USER', 'ADMIN'], default: 'USER' });
        expect(info.fields.find((f) => f.name === 'tenant_id')).toMatchObject({ required: true, type: 'Int' });
        expect(describeUserModel(dmmf, { DB_USER_TABLE: 'nope' })).toBeNull();
    });

    it('reads config files and their ${ENV} references', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-cfg-'));
        try {
            fs.mkdirSync(path.join(dir, 'config'));
            fs.writeFileSync(path.join(dir, 'config', 'app.json'), '{"a":"${A}","b":"${B:-x}","c":"${A}"}');
            expect(readConfigFile(dir, 'config/app.json')).toMatchObject({ exists: true, valid: true, envRefs: [{ name: 'A' }, { name: 'B', default: 'x' }] });
            fs.writeFileSync(path.join(dir, 'config', 'app.json'), '[1]');
            expect(readConfigFile(dir, 'config/app.json')).toMatchObject({ valid: false, error: 'must be a JSON object' });
            expect(readConfigFile(dir, 'config/none.json')).toMatchObject({ exists: false });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('finds tool binaries from the project', () => {
        expect(findBin('prisma')).toMatch(/prisma[/\\]build[/\\]index\.js$/);
        expect(findBin('surely-not-installed-xyz')).toBeNull();
    });

    it('first user: explains why it is not possible', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-admin-'));
        try {
            expect(await adminStatus({}, dir)).toMatchObject({ available: false, reason: expect.stringContaining('no Prisma schema') });
            fs.mkdirSync(path.join(dir, 'prisma'));
            fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), SCHEMA);
            expect(await adminStatus({}, dir)).toMatchObject({ available: false, reason: 'Set the database connection first' });
            expect(await adminStatus({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db' }, dir))
                .toMatchObject({ available: false, reason: expect.stringContaining('generate it first') });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
