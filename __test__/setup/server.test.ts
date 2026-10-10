import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import dotenv from 'dotenv';
import { startWizardServer, WizardHandle } from '../../src/setup/server';

const PASSWORD = 'test-password-0123456789&+#';
const saved = { ...process.env };

function restoreEnv() {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
}

describe('HTTP setup wizard', () => {
    let dir: string;
    let wizard: WizardHandle;

    async function start() {
        wizard = await startWizardServer({ host: '127.0.0.1', port: 0, password: PASSWORD, root: dir });
        return wizard;
    }
    const bearer = { authorization: `Bearer ${PASSWORD}` };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-wizard-'));
        fs.mkdirSync(path.join(dir, 'prisma'));
        fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), 'datasource db {\n  provider = "postgresql"\n}\nmodel user {\n  id Int @id\n  email String @unique\n  password String\n}\n');
        process.env.ENV_FILE = path.join(dir, '.env');
        delete process.env.DATABASE_URL;
        delete process.env.JWT_SECRET;
    });
    afterEach(async () => {
        await wizard?.app.close();
        fs.rmSync(dir, { recursive: true, force: true });
        restoreEnv();
    });

    describe('access', () => {
        it('without the password: the password page, no API', async () => {
            await start();
            const page = await wizard.app.inject({ method: 'GET', url: '/setup' });
            expect(page.statusCode).toBe(200);
            expect(page.body).toContain('setup password');
            expect(page.body).not.toContain('/setup/api');
            expect((await wizard.app.inject({ method: 'GET', url: '/setup/api/state' })).statusCode).toBe(401);
        });

        it('the right password becomes an HttpOnly cookie session; the password leaves the URL', async () => {
            await start();
            const login = await wizard.app.inject({ method: 'GET', url: `/setup?password=${encodeURIComponent(PASSWORD)}` });
            expect(login.statusCode).toBe(302);
            expect(login.headers.location).toBe('/setup');
            const cookie = String(login.headers['set-cookie']);
            expect(cookie).toMatch(/^rapidd_setup=[^;]+; HttpOnly; SameSite=Strict; Path=\/setup/);
            expect(cookie).not.toContain(PASSWORD);
            const session = cookie.split(';')[0];

            const page = await wizard.app.inject({ method: 'GET', url: '/setup', headers: { cookie: session } });
            expect(page.body).toContain('/setup/api');
            const csp = String(page.headers['content-security-policy']);
            const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
            expect(page.body).toContain(`<script nonce="${nonce}">`);
            expect(csp).toContain("frame-ancestors 'none'");
            expect(page.headers['referrer-policy']).toBe('no-referrer');
            expect(page.headers['cache-control']).toBe('no-store');

            // The cookie alone is not enough for the API — the page's own header is required (CSRF)
            expect((await wizard.app.inject({ method: 'GET', url: '/setup/api/state', headers: { cookie: session } })).statusCode).toBe(403);
            expect((await wizard.app.inject({ method: 'GET', url: '/setup/api/state', headers: { cookie: session, 'x-rapidd-setup': '1' } })).statusCode).toBe(200);
        });

        it('locks out after 10 wrong passwords', async () => {
            await start();
            for (let i = 0; i < 10; i++) {
                expect((await wizard.app.inject({ method: 'GET', url: '/setup?password=wrong' })).statusCode).toBe(401);
            }
            const locked = await wizard.app.inject({ method: 'GET', url: `/setup?password=${encodeURIComponent(PASSWORD)}` });
            expect(locked.statusCode).toBe(429);
            expect((await wizard.app.inject({ method: 'GET', url: '/setup/api/state', headers: bearer })).statusCode).toBe(429);
        });

        it('the console link carries the password URL-encoded — and opens the wizard', async () => {
            const { runWebWizard } = await import('../../src/setup/server');
            let printed = '';
            const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { printed += String(chunk); return true; });
            // A project that can start once the database is set — so finishing closes the wizard
            fs.mkdirSync(path.join(dir, 'prisma', 'client'));
            fs.writeFileSync(path.join(dir, 'prisma', 'client', 'index.js'), 'module.exports = {};');
            try {
                const running = runWebWizard({ host: '127.0.0.1', port: 0, password: PASSWORD, root: dir });
                for (let i = 0; i < 50 && !printed.includes('password='); i++) await new Promise((r) => setTimeout(r, 20));
                const link = /Open:\s+(\S+)/.exec(printed)![1];
                expect(link).toMatch(/\?password=test-password-0123456789%26%2B%23$/);
                expect((await fetch(link, { redirect: 'manual' })).status).toBe(302);
                const finished = await fetch(new URL('/setup/api/finish', link), {
                    method: 'POST', headers: { authorization: `Bearer ${PASSWORD}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ changes: { DATABASE_URL: 'postgresql://u:p@h/db' } }),
                });
                expect(finished.status).toBe(200);
                await running;
            } finally {
                write.mockRestore();
            }
        });

        it('health: alive but not ready', async () => {
            await start();
            expect((await wizard.app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'setup' });
            const ready = await wizard.app.inject({ method: 'GET', url: '/health/ready' });
            expect(ready.statusCode).toBe(503);
        });
    });

    describe('API', () => {
        it('state: catalog, masked secrets with their source, suggested secrets on first boot, reasons', async () => {
            fs.writeFileSync(process.env.ENV_FILE!, 'COOKIE_SECRET=0123456789abcdefSECRET\n');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('../../src/setup/envfile').loadEnvFile();
            await start();
            const state = (await wizard.app.inject({ method: 'GET', url: '/setup/api/state', headers: bearer })).json();
            expect(state.reasons.map((r: any) => r.key)).toEqual(['DATABASE_URL', 'prisma/client']);
            expect(state.values.COOKIE_SECRET).toEqual({ value: '••••••CRET', hasValue: true, source: 'file', locked: false });
            expect(Object.keys(state.suggested).sort()).toEqual(['JWT_REFRESH_SECRET', 'JWT_SECRET']);
            expect(state.suggested.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
            expect(state.project.userModel.model).toBe('user');
            expect(JSON.stringify(state)).not.toContain('0123456789abcdefSECRET');

            const revealed = (await wizard.app.inject({ method: 'POST', url: '/setup/api/reveal', headers: bearer, payload: { key: 'COOKIE_SECRET' } })).json();
            expect(revealed.value).toBe('0123456789abcdefSECRET');
            expect((await wizard.app.inject({ method: 'POST', url: '/setup/api/reveal', headers: bearer, payload: { key: 'PATH' } })).statusCode).toBe(404);
        });

        it('evaluate: validation and visibility follow the changes', async () => {
            await start();
            const r = (await wizard.app.inject({ method: 'POST', url: '/setup/api/evaluate', headers: bearer,
                payload: { changes: { AUTH_PROVIDERS: 'ldap', PORT: 'x' } } })).json();
            expect(r.validation.errors).toMatchObject({ PORT: 'A whole number', LDAP_URL: 'Required' });
            expect(r.sections.find((s: any) => s.id === 'ldap').visible).toBe(true);
        });

        it('behind Cloudflare: TRUST_PROXY suggested while unset, the reason under the field and on the review', async () => {
            delete process.env.TRUST_PROXY;
            // In production: elsewhere trusting every proxy (unset) is fine
            process.env.NODE_ENV = 'production';
            await start();
            // visitor → Cloudflare → nginx on this machine (inject's peer: 127.0.0.1)
            const cf = { ...bearer, 'x-forwarded-for': '203.0.113.9, 172.68.1.10', 'cf-ray': '8c1e2a3b4c5d6e7f-FRA' };
            const state = (await wizard.app.inject({ method: 'GET', url: '/setup/api/state', headers: cf })).json();
            expect(state.suggested.TRUST_PROXY).toBe('private,cloudflare');
            expect(state.proxy).toMatchObject({ cloudflare: { via: 'request' }, seenAs: '203.0.113.9', proposal: null });
            expect(state.validation.warnings.TRUST_PROXY).toBeUndefined();

            const hops = (await wizard.app.inject({ method: 'POST', url: '/setup/api/evaluate', headers: cf, payload: { changes: { TRUST_PROXY: '1' } } })).json();
            expect(hops.proxy).toMatchObject({ seenAs: '172.68.1.10', proposal: 'private,cloudflare', seenAsWithProposal: '203.0.113.9' });
            expect(hops.validation.warnings.TRUST_PROXY).toMatch(/^This page came through Cloudflare\. The API sees visitors as Cloudflare's servers/);

            // Saved — here cleared: not suggested again in this run
            expect((await wizard.app.inject({ method: 'POST', url: '/setup/api/save', headers: cf, payload: { changes: { TRUST_PROXY: '' } } })).statusCode).toBe(200);
            expect((await wizard.app.inject({ method: 'GET', url: '/setup/api/state', headers: cf })).json().suggested.TRUST_PROXY).toBeUndefined();
            // Without Cloudflare nothing is suggested
            expect((await wizard.app.inject({ method: 'GET', url: '/setup/api/state', headers: bearer })).json().proxy.cloudflare).toBeNull();
        });

        it('save: refuses invalid changes; writes valid ones to ENV_FILE', async () => {
            await start();
            const bad = await wizard.app.inject({ method: 'POST', url: '/setup/api/save', headers: bearer, payload: { changes: { PORT: 'x' } } });
            expect(bad.statusCode).toBe(400);
            expect(fs.existsSync(process.env.ENV_FILE!)).toBe(false);

            const ok = await wizard.app.inject({ method: 'POST', url: '/setup/api/save', headers: bearer,
                payload: { changes: { DATABASE_URL: 'postgresql://u:p@h/db', LOG_FORMAT: 'json' } } });
            expect(ok.statusCode).toBe(200);
            expect(dotenv.parse(fs.readFileSync(process.env.ENV_FILE!))).toEqual({ DATABASE_URL: 'postgresql://u:p@h/db', LOG_FORMAT: 'json' });
            expect(process.env.LOG_FORMAT).toBe('json');
        });

        it('settings from the real environment cannot be overridden', async () => {
            process.env.PORT = '4321';
            await start();
            const state = (await wizard.app.inject({ method: 'GET', url: '/setup/api/state', headers: bearer })).json();
            expect(state.values.PORT).toMatchObject({ value: '4321', source: 'environment', locked: true });
            await wizard.app.inject({ method: 'POST', url: '/setup/api/save', headers: bearer, payload: { changes: { PORT: '9999', LOG_LEVEL: 'fine' } } });
            expect(dotenv.parse(fs.readFileSync(process.env.ENV_FILE!))).toEqual({ LOG_LEVEL: 'fine' });
        });

        it('export: complete configuration in the chosen format', async () => {
            process.env.DATABASE_URL = 'postgresql://u:p@h/db';
            await start();
            const r = (await wizard.app.inject({ method: 'POST', url: '/setup/api/export', headers: bearer,
                payload: { format: 'kubernetes', changes: { LOG_FORMAT: 'json' } } })).json();
            expect(r.text).toContain('kind: Secret');
            expect(r.text).toContain('  DATABASE_URL: "postgresql://u:p@h/db"');
            expect(r.text).toContain('  LOG_FORMAT: "json"');
            expect((await wizard.app.inject({ method: 'POST', url: '/setup/api/export', headers: bearer, payload: { format: 'xml' } })).statusCode).toBe(400);
        });

        it('config files: in the state; staged ones are validated and change the sections', async () => {
            fs.mkdirSync(path.join(dir, 'config'));
            fs.writeFileSync(path.join(dir, 'config', 'app.json'), '{"services":{"X":{"hostname":"x.test","authorization":{"type":"bearer","token":"${X_TOKEN:-dev}"}}}}');
            await start();
            const state = (await wizard.app.inject({ method: 'GET', url: '/setup/api/state', headers: bearer })).json();
            expect(state.files).toEqual({ app: expect.stringContaining('X_TOKEN'), rateLimit: null, acl: null, rls: null });
            expect(state.sections.find((s: any) => s.id === 'services').settings[0]).toMatchObject({ key: 'X_TOKEN', type: 'secret', default: 'dev' });

            const staged = { app: '{"services":{"X":{"hostname":"x.test","authorization":{"type":"basic","username":"u","password":"${X_PASS}"}}}}',
                acl: '{"models":{"ghost":{},"user":{"hide":{"*":["passwrd"]}}}}', rls: '{ broken' };
            const r = (await wizard.app.inject({ method: 'POST', url: '/setup/api/evaluate', headers: bearer, payload: { files: staged } })).json();
            expect(r.sections.find((s: any) => s.id === 'services').settings.map((x: any) => x.key)).toEqual(['X_PASS']);
            expect(r.fileProblems).toEqual({
                acl: ['ghost: no such model in the schema', 'user.hide.*: unknown field(s) passwrd'],
                rls: [expect.stringMatching(/^Invalid JSON/)],
            });
        });

        it('save: staged files and settings together — nothing is written while one is invalid', async () => {
            await start();
            const bad = await wizard.app.inject({ method: 'POST', url: '/setup/api/save', headers: bearer, payload: {
                changes: { LOG_FORMAT: 'json' }, files: { rateLimit: '{"/api":{"maxRequests":-1}}' } } });
            expect(bad.statusCode).toBe(400);
            expect(bad.json().fileProblems).toEqual({ rateLimit: ['/api.maxRequests: a whole number ≥ 0'] });
            expect(fs.existsSync(process.env.ENV_FILE!)).toBe(false);
            expect(fs.existsSync(path.join(dir, 'config'))).toBe(false);

            const acl = '{\n    "models": {\n        "user": {\n            "read": {\n                "*": "all"\n            }\n        }\n    }\n}';
            const ok = await wizard.app.inject({ method: 'POST', url: '/setup/api/save', headers: bearer, payload: {
                changes: { LOG_FORMAT: 'json' }, files: { rateLimit: '{"/api":{"maxRequests":5,"windowMs":1000}}', acl, unknown: 'x' } } });
            expect(ok.statusCode).toBe(200);
            const body = ok.json();
            expect(body.files).toEqual(['config/rate-limit.json', 'config/acl.json']);
            expect(body.texts.acl).toBe(acl + '\n');
            expect(JSON.parse(fs.readFileSync(path.join(dir, 'config', 'rate-limit.json'), 'utf8'))).toEqual({ '/api': { maxRequests: 5, windowMs: 1000 } });
            expect(fs.statSync(path.join(dir, 'config', 'acl.json')).mode & 0o777).toBe(0o644);
            expect(dotenv.parse(fs.readFileSync(process.env.ENV_FILE!))).toEqual({ LOG_FORMAT: 'json' });
        });

        it('the logo is public; the data model, access context and policy SQL need the password', async () => {
            await start();
            const logo = await wizard.app.inject({ method: 'GET', url: '/setup/assets/logo.png' });
            expect(logo.statusCode).toBe(200);
            expect(logo.headers['content-type']).toBe('image/png');
            expect(logo.rawPayload.subarray(1, 4).toString()).toBe('PNG');
            expect((await wizard.app.inject({ method: 'POST', url: '/setup/api/acl/context', payload: {} })).statusCode).toBe(401);

            const project = (await wizard.app.inject({ method: 'POST', url: '/setup/api/project', headers: bearer, payload: {} })).json();
            expect(project.models.map((m: any) => [m.name, m.route.kind, m.sensitive])).toEqual([['user', 'route', ['password']]]);
            expect(project.build).toEqual(expect.objectContaining({ installed: expect.any(Boolean) }));
            expect(project.routes).toContain('/api/v1/user');

            const acl = (await wizard.app.inject({ method: 'POST', url: '/setup/api/acl/context', headers: bearer, payload: {} })).json();
            expect(acl).toMatchObject({ userModel: 'user', userAttributes: ['id', 'email'], codeFile: null });

            const sql = (await wizard.app.inject({ method: 'POST', url: '/setup/api/rls/sql', headers: bearer, payload: {
                changes: { DATABASE_URL: 'postgresql://u:p@h/db' },
                operation: { op: 'create', policy: { model: 'user', name: 'own', command: 'SELECT', enable: false, match: [{ field: 'id', variable: 'current_user_id' }] } } } })).json();
            expect(sql.statements).toEqual(["CREATE POLICY \"own\" ON \"public\".\"user\"\n    FOR SELECT\n    USING (\"id\"::text = current_setting('app.current_user_id', true));"]);
            const refused = await wizard.app.inject({ method: 'POST', url: '/setup/api/rls/sql', headers: bearer, payload: {
                operation: { op: 'create', policy: { model: 'user', command: 'ALL', match: [{ field: 'secret', variable: 'v' }] } } } });
            expect(refused.statusCode).toBe(400);
            expect(refused.json().error).toBe('user has no column secret');

            const mysql = (await wizard.app.inject({ method: 'POST', url: '/setup/api/rls', headers: bearer, payload: { changes: { DATABASE_URL: 'mysql://u:p@h/db' } } })).json();
            expect(mysql).toMatchObject({ provider: 'mysql', supported: false, active: false, variablesSource: 'config' });
        });

        it('service test: with the staged config/app.json and unsaved settings', async () => {
            const target = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ auth: req.headers.authorization })); });
            await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
            const port = (target.address() as AddressInfo).port;
            try {
                await start();
                const app = JSON.stringify({ services: { Echo: { hostname: '127.0.0.1', port, secure: false, authorization: { type: 'bearer', token: '${ECHO_TOKEN}' }, endpoints: { ping: { path: '/ping' } } } } });
                const r = (await wizard.app.inject({ method: 'POST', url: '/setup/api/services/test', headers: bearer,
                    payload: { files: { app }, changes: { ECHO_TOKEN: 'abc' }, service: 'Echo', endpoint: 'ping' } })).json();
                expect(r).toMatchObject({ ok: true, status: 200 });
                expect(JSON.parse(r.preview)).toEqual({ auth: 'Bearer abc' });
            } finally {
                target.close();
            }
        });

        it('unknown checks and actions are 404; guarded actions explain why they cannot run', async () => {
            fs.symlinkSync(path.join(__dirname, '..', '..', 'node_modules'), path.join(dir, 'node_modules'));
            await start();
            const blocked = (await wizard.app.inject({ method: 'POST', url: '/setup/api/action/generate', headers: bearer, payload: {} })).json();
            expect(blocked).toMatchObject({ ok: false, message: 'Set the database connection first' });
            expect((await wizard.app.inject({ method: 'POST', url: '/setup/api/check/smtp', headers: bearer, payload: {} })).statusCode).toBe(404);
            expect((await wizard.app.inject({ method: 'POST', url: '/setup/api/action/rm', headers: bearer, payload: {} })).statusCode).toBe(404);
            const r = (await wizard.app.inject({ method: 'POST', url: '/setup/api/action/pull', headers: bearer, payload: { changes: { DATABASE_URL: 'postgresql://u:p@h/db' } } })).json();
            expect(r).toMatchObject({ ok: false, message: expect.stringContaining('already has models') });
        });

        it('npm run setup: finishing ends the wizard even while the API cannot start — and says so', async () => {
            const { setupCommand } = await import('../../src/setup');
            let printed = '';
            const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { printed += String(chunk); return true; });
            try {
                const running = setupCommand({ root: dir, host: '127.0.0.1', port: 0, password: PASSWORD });
                for (let i = 0; i < 50 && !printed.includes('password='); i++) await new Promise((r) => setTimeout(r, 20));
                expect(printed).toContain('Rapidd setup — the wizard is running; the API cannot start yet:');
                const base = new URL(/Open:\s+(\S+)/.exec(printed)![1]).origin;
                const auth = { authorization: `Bearer ${PASSWORD}`, 'content-type': 'application/json' };
                expect(((await (await fetch(`${base}/setup/api/state`, { headers: auth })).json()) as { mode: string }).mode).toBe('setup');
                const finished = await fetch(`${base}/setup/api/finish`, { method: 'POST', headers: auth, body: JSON.stringify({ changes: { LOG_FORMAT: 'json' } }) });
                expect(finished.status).toBe(200);
                expect(await finished.json()).toMatchObject({ ok: true, exit: true, reasons: [{ key: 'DATABASE_URL' }, { key: 'prisma/client' }] });
                const remaining = await running;
                expect(remaining.map((r) => r.key)).toEqual(['DATABASE_URL', 'prisma/client']);
                expect(printed).toContain('Setup saved — the API cannot start yet:');
                expect(dotenv.parse(fs.readFileSync(process.env.ENV_FILE!))).toMatchObject({ LOG_FORMAT: 'json' });
            } finally {
                write.mockRestore();
            }
        });

        it('npm run setup: a port in use is explained', async () => {
            const busy = http.createServer();
            await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
            const port = (busy.address() as AddressInfo).port;
            try {
                await expect(startWizardServer({ host: '127.0.0.1', port, password: PASSWORD, root: dir, mode: 'setup' }))
                    .rejects.toThrow(`Port ${port} is in use — is the API running? Stop it, or run the setup on another port: PORT=${port + 1} npm run setup`);
            } finally {
                busy.close();
            }
        });

        it('no sign-in: no JWT secrets are written, no first user offered, the anonymous role is known', async () => {
            fs.mkdirSync(path.join(dir, 'prisma', 'client'));
            fs.writeFileSync(path.join(dir, 'prisma', 'client', 'index.js'), 'module.exports = {};');
            await start();
            const changes = { DATABASE_URL: 'postgresql://u:p@h/db', AUTH_PROVIDERS: 'none' };
            expect((await wizard.app.inject({ method: 'POST', url: '/setup/api/admin/status', headers: bearer, payload: { changes } })).json())
                .toEqual({ available: false, reason: 'Sign-in is off (AUTH_PROVIDERS=none) — the API needs no accounts' });
            expect((await wizard.app.inject({ method: 'POST', url: '/setup/api/acl/context', headers: bearer, payload: { changes } })).json().roles).toContain('anonymous');
            const r = await wizard.app.inject({ method: 'POST', url: '/setup/api/finish', headers: bearer, payload: { changes } });
            expect(r.json()).toMatchObject({ ok: true });
            const env = dotenv.parse(fs.readFileSync(process.env.ENV_FILE!));
            expect(env).toMatchObject({ AUTH_PROVIDERS: 'none', COOKIE_SECRET: expect.stringMatching(/^[0-9a-f]{64}$/) });
            expect(env.JWT_SECRET).toBeUndefined();
            expect(env.JWT_REFRESH_SECRET).toBeUndefined();
        });

        it('finish: first boot refuses while the API still cannot start', async () => {
            await start();
            const r = await wizard.app.inject({ method: 'POST', url: '/setup/api/finish', headers: bearer, payload: { changes: { DATABASE_URL: 'postgresql://u:p@h/db' } } });
            expect(r.statusCode).toBe(409);
            expect(r.json().reasons.map((x: any) => x.key)).toEqual(['prisma/client']);
            // Generated secrets were saved along with the change: no throwaway secrets
            const env = dotenv.parse(fs.readFileSync(process.env.ENV_FILE!));
            expect(env.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
        });

        it('finish: completes once nothing blocks — and the wizard closes', async () => {
            fs.mkdirSync(path.join(dir, 'prisma', 'client'));
            fs.writeFileSync(path.join(dir, 'prisma', 'client', 'index.js'), 'module.exports = {};');
            await start();
            let closed = false;
            wizard.done.then(() => { closed = true; });
            const r = await wizard.app.inject({ method: 'POST', url: '/setup/api/finish', headers: bearer, payload: { changes: { DATABASE_URL: 'postgresql://u:p@h/db' } } });
            expect(r.json()).toMatchObject({ ok: true });
            await wizard.done;
            expect(closed).toBe(true);
        });
    });
});
