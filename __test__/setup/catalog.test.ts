import fs from 'fs';
import path from 'path';
import { SECTIONS, matches, conditionKeys, isSecretKey } from '../../src/setup/catalog';

const ROOT = path.join(__dirname, '..', '..');

/** Every env var name the framework source reads */
function envVarsReadByCode(): Set<string> {
    const names = new Set<string>();
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!['models', 'setup'].includes(entry.name)) walk(file);
                continue;
            }
            if (!file.endsWith('.ts')) continue;
            const source = fs.readFileSync(file, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '') // doc comments mention example variables
                .replace(/\/\/.*$/gm, '');
            for (const m of source.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
            for (const m of source.matchAll(/getEnv\('([A-Z][A-Z0-9_]+)'\)/g)) names.add(m[1]);
        }
    };
    walk(path.join(ROOT, 'src'));
    return names;
}

/** Paths and internals the app sets for itself — not configuration */
const INTERNAL = new Set(['ROOT', 'ROUTES_PATH', 'STRINGS_PATH', 'PUBLIC_PATH', 'PUBLIC_STATIC', 'ENV_FILE', 'KUBERNETES_SERVICE_HOST', 'NO_COLOR']);

describe('settings catalog', () => {
    const keys = SECTIONS.flatMap((s) => s.settings.map((x) => x.key));

    it('covers every environment variable the code reads', () => {
        const missing = [...envVarsReadByCode()].filter((k) => !INTERNAL.has(k) && !keys.includes(k));
        expect(missing).toEqual([]);
    });

    it('documents every setting in .env.example', () => {
        const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
        expect(keys.filter((k) => !new RegExp(`^${k}=`, 'm').test(example))).toEqual([]);
    });

    it('.env.example has exactly the catalog structure: groups, sections in order, every key under its heading', () => {
        const lines = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n');
        const found: { group: string; title: string; keys: string[] }[] = [];
        let group = '';
        lines.forEach((line, i) => {
            if (/^#\s*═{3,}$/.test(line) && /^#\s*═{3,}$/.test(lines[i + 2] ?? '')) group = lines[i + 1].replace(/^#\s*/, '').trim();
            const heading = /^#\s*─{2,}\s+(.+?)\s*─*$/.exec(line);
            if (heading) found.push({ group, title: heading[1], keys: [] });
            const key = /^([A-Z][A-Z0-9_]*)=/.exec(line);
            if (key) found[found.length - 1]?.keys.push(key[1]);
        });
        const expected = SECTIONS.map((s) => ({ group: s.group.toUpperCase(), title: s.title, keys: s.settings.map((x) => x.key) }));
        // A heading may add a hint after the title: "LDAP / Active Directory (AUTH_PROVIDERS=ldap)"
        const normalized = found.map((f, i) => ({ ...f, title: expected[i] && f.title.startsWith(`${expected[i].title} `) ? expected[i].title : f.title }));
        expect(normalized).toEqual(expected);
    });

    it('every auth setting is in the Authentication group', () => {
        const auth = SECTIONS.filter((s) => s.group === 'Authentication').flatMap((s) => s.settings.map((x) => x.key));
        const elsewhere = keys.filter((k) => /^(AUTH_|JWT_|LDAP_|OIDC_|WEBDAV_|DB_USER_)/.test(k) && !auth.includes(k));
        expect(elsewhere).toEqual([]);
    });

    it('has no duplicate keys, and every setting explains itself', () => {
        expect(new Set(keys).size).toBe(keys.length);
        for (const s of SECTIONS.flatMap((x) => x.settings)) {
            expect(s.help.length).toBeGreaterThan(5);
            if (s.type === 'enum' || s.type === 'multi') expect(s.key === 'DEFAULT_LANGUAGE' || (s.options?.length ?? 0) > 0).toBe(true);
        }
    });

    it('conditions only refer to settings that exist', () => {
        expect(conditionKeys(SECTIONS).filter((k) => !keys.includes(k))).toEqual([]);
    });

    it('matches(): equals, includes (comma lists), set, any / all / not', () => {
        const v = { AUTH_PROVIDERS: 'Local, LDAP', NODE_ENV: 'production', EMPTY: '' };
        expect(matches({ key: 'AUTH_PROVIDERS', includes: 'ldap' }, v)).toBe(true);
        expect(matches({ key: 'AUTH_PROVIDERS', includes: 'oidc' }, v)).toBe(false);
        expect(matches({ key: 'NODE_ENV', equals: 'production' }, v)).toBe(true);
        expect(matches({ key: 'EMPTY', set: false }, v)).toBe(true);
        expect(matches({ any: [{ key: 'X', set: true }, { key: 'NODE_ENV', set: true }] }, v)).toBe(true);
        expect(matches({ all: [{ key: 'X', set: true }, { key: 'NODE_ENV', set: true }] }, v)).toBe(false);
        expect(matches({ not: { key: 'X', set: true } }, v)).toBe(true);
        expect(matches(undefined, v)).toBe(true);
    });

    it('masks credentials — by type in the catalog, by name for config/app.json variables', () => {
        const secrets = SECTIONS.flatMap((s) => s.settings).filter((x) => x.type === 'secret').map((x) => x.key);
        expect(secrets).toEqual(expect.arrayContaining(['DATABASE_URL', 'DATABASE_URL_ADMIN', 'REDIS_URL', 'REDIS_PASSWORD', 'JWT_SECRET',
            'JWT_REFRESH_SECRET', 'COOKIE_SECRET', 'LDAP_BIND_PASSWORD', 'OIDC_CLIENT_SECRET', 'SETUP_PASSWORD']));
        for (const k of ['PARTNER_API_TOKEN', 'INTERNAL_API_PASSWORD', 'WEATHER_API_KEY', 'STORAGE_CLIENT_SECRET', 'CUSTOM_API_KEY']) {
            expect(isSecretKey(k)).toBe(true);
        }
        for (const k of ['PORT', 'LOG_LEVEL', 'MONKEY', 'KEYCLOAK_URL', 'AUTH_ACCESS_TOKEN_EXPIRY', 'AUTH_REFRESH_TOKEN_EXPIRY']) {
            expect(isSecretKey(k)).toBe(false);
        }
    });
});
