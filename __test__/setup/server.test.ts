import fs from 'fs';
import os from 'os';
import path from 'path';
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

    async function start(mode: 'first-boot' | 'explicit' = 'explicit') {
        wizard = await startWizardServer({ mode, host: '127.0.0.1', port: 0, password: PASSWORD, root: dir });
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
            try {
                const running = runWebWizard({ mode: 'explicit', host: '127.0.0.1', port: 0, password: PASSWORD, root: dir });
                for (let i = 0; i < 50 && !printed.includes('password='); i++) await new Promise((r) => setTimeout(r, 20));
                const link = /Open:\s+(\S+)/.exec(printed)![1];
                expect(link).toMatch(/\?password=test-password-0123456789%26%2B%23$/);
                expect((await fetch(link, { redirect: 'manual' })).status).toBe(302);
                await fetch(new URL('/setup/api/finish', link), {
                    method: 'POST', headers: { authorization: `Bearer ${PASSWORD}`, 'content-type': 'application/json' }, body: '{}',
                });
                await running;
            } finally {
                write.mockRestore();
            }
        });

        it('health: alive but not ready', async () => {
            await start('first-boot');
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
            await start('first-boot');
            const state = (await wizard.app.inject({ method: 'GET', url: '/setup/api/state', headers: bearer })).json();
            expect(state.mode).toBe('first-boot');
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

        it('config files: read with ${ENV} references, write only valid JSON', async () => {
            fs.mkdirSync(path.join(dir, 'config'));
            fs.writeFileSync(path.join(dir, 'config', 'app.json'), '{"services":{"X":{"token":"${X_TOKEN:-dev}"}}}');
            await start();
            const file = (await wizard.app.inject({ method: 'GET', url: '/setup/api/file/app', headers: bearer })).json();
            expect(file).toMatchObject({ exists: true, valid: true, envRefs: [{ name: 'X_TOKEN', default: 'dev' }] });
            const state = (await wizard.app.inject({ method: 'GET', url: '/setup/api/state', headers: bearer })).json();
            expect(state.sections.find((s: any) => s.id === 'services').settings[0]).toMatchObject({ key: 'X_TOKEN', type: 'secret', default: 'dev' });

            expect((await wizard.app.inject({ method: 'PUT', url: '/setup/api/file/app', headers: bearer, payload: { content: '{ broken' } })).statusCode).toBe(400);
            const put = await wizard.app.inject({ method: 'PUT', url: '/setup/api/file/rateLimit', headers: bearer, payload: { content: '{"/api":{"maxRequests":5,"windowMs":1000}}' } });
            expect(put.statusCode).toBe(200);
            expect(JSON.parse(fs.readFileSync(path.join(dir, 'config', 'rate-limit.json'), 'utf8'))).toEqual({ '/api': { maxRequests: 5, windowMs: 1000 } });
            expect((await wizard.app.inject({ method: 'GET', url: '/setup/api/file/secrets', headers: bearer })).statusCode).toBe(404);
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

        it('finish: first boot refuses while the API still cannot start', async () => {
            await start('first-boot');
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
            await start('first-boot');
            let closed = false;
            wizard.done.then(() => { closed = true; });
            const r = await wizard.app.inject({ method: 'POST', url: '/setup/api/finish', headers: bearer, payload: { changes: { DATABASE_URL: 'postgresql://u:p@h/db' } } });
            expect(r.json()).toMatchObject({ ok: true, mode: 'first-boot' });
            await wizard.done;
            expect(closed).toBe(true);
        });
    });
});
