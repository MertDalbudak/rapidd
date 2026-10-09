import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { validate, saveSettings, exportSettings, buildSections, mask, authEnabled } from '../../src/setup/settings';
import { setupReasons } from '../../src/setup';
import { loadEnvFile } from '../../src/setup/envfile';

const sections = buildSections();
const DB = 'postgresql://u:p@localhost:5432/app';

describe('validate', () => {
    it('requires DATABASE_URL — a boot blocker', () => {
        const v = validate({}, sections);
        expect(v.errors.DATABASE_URL).toBe('Required');
        expect(v.blockers).toEqual(['DATABASE_URL']);
    });

    it('checks types: numbers, booleans, enums, lists of options, URLs, JSON', () => {
        const v = validate({
            DATABASE_URL: DB, PORT: 'abc', HEALTH_ENABLED: 'yes', LOG_LEVEL: 'debug', AUTH_STRATEGIES: 'bearer,magic',
            AUTH_PROVIDERS: 'ldap,ldap', PUBLIC_URL: 'ftp://x', AUTH_ROLE_MAP: '[1]',
        }, sections);
        expect(v.errors).toMatchObject({
            PORT: 'A whole number', HEALTH_ENABLED: 'true or false', LOG_LEVEL: expect.stringContaining('essential'),
            AUTH_STRATEGIES: expect.stringContaining('magic'), AUTH_PROVIDERS: 'Listed twice', PUBLIC_URL: expect.any(String),
            AUTH_ROLE_MAP: 'A JSON object',
        });
    });

    it('applies the rules beyond types', () => {
        const v = validate({
            DATABASE_URL: 'mongodb://x', PORT: '70000', API_TIMEZONE: 'Mars/Base', AUTH_ACCESS_TOKEN_EXPIRY: 'forever',
            ALLOWED_ORIGINS: 'ok.example.com, not an origin', AUTH_SESSION_STORAGE: 'redis', SETUP_PASSWORD: 'short',
        }, sections);
        expect(v.errors.DATABASE_URL).toMatch(/postgresql:\/\//);
        expect(v.errors.PORT).toBe('1 – 65535');
        expect(v.errors.API_TIMEZONE).toMatch(/IANA/);
        expect(v.errors.AUTH_ACCESS_TOKEN_EXPIRY).toMatch(/duration/);
        expect(v.errors.ALLOWED_ORIGINS).toMatch(/not an origin/);
        expect(v.errors.AUTH_SESSION_STORAGE).toMatch(/Redis/);
        expect(v.errors.SETUP_PASSWORD).toMatch(/16/);
        // Only problems that stop the app today block boot
        expect(v.blockers.sort()).toEqual(['API_TIMEZONE', 'DATABASE_URL']);
    });

    it('TRUST_PROXY: addresses and a hop count are fine; what is no address stops the start', () => {
        for (const ok of ['true', 'false', '1', '2,10.0.0.0/8', 'loopback, uniquelocal', '10.0.0.0/8,::1', 'private,cloudflare']) {
            expect(validate({ DATABASE_URL: DB, TRUST_PROXY: ok }, sections).errors.TRUST_PROXY).toBeUndefined();
        }
        const bad = validate({ DATABASE_URL: DB, TRUST_PROXY: '1,proxy.internal' }, sections);
        expect(bad.errors.TRUST_PROXY).toBe('invalid IP address: proxy.internal — use IPs, CIDRs, private, cloudflare, loopback, linklocal or uniquelocal');
        expect(bad.blockers).toEqual(['TRUST_PROXY']);
        expect(validate({ DATABASE_URL: DB, TRUST_PROXY: '1,2' }, sections).errors.TRUST_PROXY).toBe('one hop count, not 2 (1, 2)');
    });

    it('AUTH_SALT_ROUNDS: what bcrypt accepts', () => {
        expect(validate({ DATABASE_URL: DB, AUTH_SALT_ROUNDS: '12' }, sections).errors.AUTH_SALT_ROUNDS).toBeUndefined();
        expect(validate({ DATABASE_URL: DB, AUTH_SALT_ROUNDS: '3' }, sections).errors.AUTH_SALT_ROUNDS).toBe('4 – 31');
        expect(validate({ DATABASE_URL: DB, AUTH_SALT_ROUNDS: '40' }, sections).errors.AUTH_SALT_ROUNDS).toBe('4 – 31');
    });

    it('a URL for another database than the schema is an error', () => {
        const v = validate({ DATABASE_URL: 'mysql://u:p@h/db' }, sections, { schema: { provider: 'postgresql' } as any });
        expect(v.errors.DATABASE_URL).toMatch(/schema is for postgresql/);
    });

    it('shows and requires provider settings only when the provider is enabled', () => {
        const off = validate({ DATABASE_URL: DB }, sections);
        expect(off.visible).not.toContain('LDAP_URL');
        const on = validate({ DATABASE_URL: DB, AUTH_PROVIDERS: 'ldap,oidc' }, sections);
        expect(on.visible).toEqual(expect.arrayContaining(['LDAP_URL', 'OIDC_ISSUER', 'AUTH_ROLE_MAP']));
        expect(on.errors).toMatchObject({ LDAP_URL: 'Required', LDAP_BIND_TEMPLATE: expect.stringContaining('service account'), OIDC_ISSUER: 'Required' });
        // OIDC_CLIENT_ID is required too, but its absence does not stop the app — not a blocker
        expect(on.errors.OIDC_CLIENT_ID).toBe('Required');
        expect(on.blockers.sort()).toEqual(['LDAP_BIND_TEMPLATE', 'LDAP_URL', 'OIDC_ISSUER']);
        const ok = validate({ DATABASE_URL: DB, AUTH_PROVIDERS: 'ldap', LDAP_URL: 'ldaps://dc1', LDAP_BIND_DN: 'cn=svc', LDAP_SEARCH_BASE: 'dc=x' }, sections);
        expect(ok.errors).toEqual({});
    });

    it('JWT secrets: required in production when auth is on — not otherwise', () => {
        const prod = { DATABASE_URL: DB, NODE_ENV: 'production' };
        expect(validate(prod, sections, { userModel: { model: 'user' } as any }).blockers).toEqual(['JWT_SECRET', 'JWT_REFRESH_SECRET']);
        expect(validate(prod, sections, { userModel: null }).blockers).toEqual([]);
        expect(validate({ DATABASE_URL: DB }, sections, { userModel: { model: 'user' } as any }).blockers).toEqual([]);
        expect(authEnabled({ AUTH_PROVIDERS: 'oidc' }, { userModel: null })).toBe(true);
    });

    it('no sign-in (AUTH_PROVIDERS=none): stands alone, hides the sign-in settings, needs no JWT secrets', () => {
        const prod = { DATABASE_URL: DB, NODE_ENV: 'production', AUTH_PROVIDERS: 'none' };
        const user = { userModel: { model: 'user' } as any, schema: { models: ['user'] } as any };
        const v = validate(prod, sections, user);
        expect(v.blockers).toEqual([]);
        expect(v.visible).not.toEqual(expect.arrayContaining(['JWT_SECRET']));
        for (const key of ['JWT_SECRET', 'AUTH_SESSION_STORAGE', 'AUTH_STRATEGIES', 'DB_USER_TABLE']) expect(v.visible).not.toContain(key);
        expect(v.warnings.AUTH_PROVIDERS).toMatch(/models without access rules are open/);
        expect(validate({ ...prod, ACL_DEFAULT: 'deny' }, sections, user).warnings.AUTH_PROVIDERS).toMatch(/access rules for “anonymous” or “\*” decide/);
        expect(authEnabled({ AUTH_PROVIDERS: 'none' }, user)).toBe(false);
        expect(validate({ DATABASE_URL: DB, AUTH_PROVIDERS: 'none,local' }, sections).errors.AUTH_PROVIDERS).toBe('none cannot be combined with others');
        expect(validate({ DATABASE_URL: DB, AUTH_PROVIDERS: 'none,local' }, sections).blockers).toContain('AUTH_PROVIDERS');
    });

    it('local sign-in without a user table: says that the API would refuse every request', () => {
        const project = { userModel: null, schema: { models: ['product'] } as any };
        expect(validate({ DATABASE_URL: DB }, sections, project).warnings.AUTH_PROVIDERS).toMatch(/choose none for an API without sign-in/);
        expect(validate({ DATABASE_URL: DB, AUTH_PROVIDERS: 'oidc' }, sections, project).warnings.AUTH_PROVIDERS).toBeUndefined();
        // A fresh project (no models yet) is not warned about
        expect(validate({ DATABASE_URL: DB }, sections, { userModel: null, schema: { models: [] } as any }).warnings.AUTH_PROVIDERS).toBeUndefined();
    });

    it('warns about risky production values', () => {
        const v = validate({ DATABASE_URL: DB, NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), JWT_REFRESH_SECRET: 'x'.repeat(40),
            ALLOWED_ORIGINS: '*', LOG_LEVEL: 'finest' }, sections);
        expect(v.warnings).toMatchObject({
            TRUST_PROXY: expect.any(String), ALLOWED_ORIGINS: expect.any(String), LOG_LEVEL: expect.any(String),
            JWT_REFRESH_SECRET: expect.stringContaining('different'), AUTH_SESSION_STORAGE: expect.any(String),
        });
    });

    it('masks secrets', () => {
        expect(mask('')).toBe('');
        expect(mask('short')).toBe('••••••');
        expect(mask('0123456789abcdef')).toBe('••••••cdef');
    });
});

describe('saveSettings', () => {
    let dir: string;
    const saved = { ...process.env };
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-save-')); });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    });

    it('writes the env file, applies the values, and leaves env-provided keys alone', () => {
        const file = path.join(dir, '.env');
        fs.writeFileSync(file, '# mine\nLOG_LEVEL=fine\nRATE_LIMIT_ENABLED=true\n');
        loadEnvFile(file);
        process.env.PORT = '4000'; // the real environment
        const result = saveSettings({ LOG_LEVEL: 'finest', RATE_LIMIT_ENABLED: '', PORT: '5000', AUTH_ROLE_MAP: '{"a b":"admin"}' }, sections, file);
        expect(result).toMatchObject({ written: ['LOG_LEVEL', 'AUTH_ROLE_MAP'], removed: ['RATE_LIMIT_ENABLED'], ignored: ['PORT'], backup: `${file}.bak` });
        const content = fs.readFileSync(file, 'utf8');
        expect(content.startsWith('# mine\nLOG_LEVEL=finest\n')).toBe(true);
        expect(dotenv.parse(content)).toEqual({ LOG_LEVEL: 'finest', AUTH_ROLE_MAP: '{"a b":"admin"}' });
        expect(process.env.LOG_LEVEL).toBe('finest');
        expect(process.env.RATE_LIMIT_ENABLED).toBeUndefined();
        expect(process.env.PORT).toBe('4000');
    });

    it('rejects invalid variable names', () => {
        expect(() => saveSettings({ 'BAD NAME': 'x' }, sections, path.join(dir, '.env'))).toThrow(/Invalid variable name/);
    });
});

describe('exportSettings', () => {
    const values = { DATABASE_URL: 'postgresql://u:p@h/db', AUTH_ROLE_MAP: '{"CN=x":"admin"}', QUOTE: "it's", EMPTY: '' };

    it('env: parseable by dotenv, structured like .env.example', () => {
        const env = exportSettings(values, 'env');
        expect(dotenv.parse(env)).toEqual({ DATABASE_URL: values.DATABASE_URL, AUTH_ROLE_MAP: values.AUTH_ROLE_MAP, QUOTE: "it's" });
        expect(env.split('\n').filter((l) => /^#  [A-Z]/.test(l))).toEqual(['#  DATA STORES', '#  AUTHENTICATION', '#  OTHER']);
        expect(env).toContain('# ── External identities');
    });

    it('compose / kubernetes: values as quoted YAML scalars', () => {
        const compose = exportSettings(values, 'compose');
        expect(compose).toContain('      AUTH_ROLE_MAP: "{\\"CN=x\\":\\"admin\\"}"');
        expect(compose).not.toContain('EMPTY');
        const k8s = exportSettings(values, 'kubernetes', sections, 'my-api');
        expect(k8s).toMatch(/^apiVersion: v1\nkind: Secret\nmetadata:\n {2}name: my-api\ntype: Opaque\nstringData:\n/);
    });

    it('shell: single-quoted, quotes escaped', () => {
        expect(exportSettings({ QUOTE: "it's" }, 'shell')).toBe("export QUOTE='it'\\''s'\n");
    });
});

describe('setupReasons — what keeps the API from starting', () => {
    const saved = { ...process.env };
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-reasons-')); });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    });

    it('lists a missing database and a missing Prisma client', async () => {
        delete process.env.DATABASE_URL;
        expect((await setupReasons(dir)).map((r) => r.key)).toEqual(['DATABASE_URL', 'prisma/client']);
    });

    it('is empty for a configured project', async () => {
        process.env.DATABASE_URL = DB;
        fs.mkdirSync(path.join(dir, 'prisma', 'client'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'prisma', 'client', 'index.js'), 'module.exports = {};');
        expect(await setupReasons(dir)).toEqual([]);
    });
});
