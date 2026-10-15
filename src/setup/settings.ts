import fs from 'fs';
import crypto from 'crypto';
import { SECTIONS, matches, listItems, isSecretKey, conditionKeys } from './catalog';
import type { Section, Setting, Values } from './catalog';
import { envFilePath, readEnvFile, updateEnvContent, writeEnvFile, valueSource, markFromFile } from './envfile';
import type { EnvLayout } from './envfile';
import { detectProvider } from '../core/adapter';
import type { ProjectInfo } from './project';
import { trustProxyError } from '../core/trustProxy';

/**
 * The settings model shared by both setup front-ends: sections for this project,
 * current values and where they come from, validation, saving and exports.
 */

/** Catalog sections for this project: locale options, and the ${VARS} config/app.json references */
export function buildSections(project?: Pick<ProjectInfo, 'locales' | 'configFiles'>): Section[] {
    const sections = SECTIONS.map((section) => ({
        ...section,
        // Languages are the project's locales/*.json — without that folder, a free text field
        settings: section.settings.map((s): Setting => (s.key !== 'DEFAULT_LANGUAGE' || !project ? s
            : project.locales.length ? { ...s, options: project.locales } : { ...s, type: 'string' })),
    }));
    const known = new Set(sections.flatMap((s) => s.settings.map((x) => x.key)));
    const refs = (project?.configFiles.app.envRefs ?? []).filter((r) => !known.has(r.name));
    if (refs.length > 0) {
        // Next to "Outgoing requests": the credentials of the same calls
        sections.splice(sections.findIndex((s) => s.id === 'outgoing') + 1, 0, {
            id: 'services',
            group: 'API',
            title: 'External services',
            description: 'Variables that config/app.json references with ${NAME} — credentials of the APIs your app calls.',
            settings: refs.map((r): Setting => ({
                key: r.name,
                label: r.name,
                type: isSecretKey(r.name) ? 'secret' : 'string',
                help: 'Referenced in config/app.json.',
                ...(r.default !== undefined ? { default: r.default } : {}),
            })),
        });
    }
    return sections;
}

/** The env-file layout of these sections — the structure of .env.example */
export function envLayout(sections: Section[]): EnvLayout {
    return { sections: sections.map((s) => ({ title: s.title, group: s.group, keys: s.settings.map((x) => x.key) })) };
}

export function allSettings(sections: Section[]): Setting[] {
    return sections.flatMap((s) => s.settings);
}

/** Keys whose values are masked in every output */
export function secretKeys(sections: Section[]): Set<string> {
    return new Set(allSettings(sections).filter((s) => s.type === 'secret').map((s) => s.key));
}

export type Source = 'file' | 'environment' | 'unset';

export interface SettingValue {
    value: string;
    source: Source;
    /** Set by the real environment: an env-file value would be ignored */
    locked: boolean;
}

/** Current values of every setting and where each comes from */
export function currentValues(sections: Section[]): Record<string, SettingValue> {
    const out: Record<string, SettingValue> = {};
    for (const setting of allSettings(sections)) {
        const source = valueSource(setting.key);
        out[setting.key] = { value: process.env[setting.key] ?? '', source, locked: source === 'environment' };
    }
    return out;
}

export function plainValues(current: Record<string, SettingValue>): Values {
    return Object.fromEntries(Object.entries(current).map(([k, v]) => [k, v.value]));
}

/** Show a secret without revealing it */
export function mask(value: string): string {
    if (!value) return '';
    return value.length <= 8 ? '••••••' : `••••••${value.slice(-4)}`;
}

export function generateSecret(): string {
    return crypto.randomBytes(32).toString('hex');
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface Validation {
    /** Invalid values — not saved */
    errors: Record<string, string>;
    /** Worth a look, but allowed */
    warnings: Record<string, string>;
    /** Keys whose problem keeps the API from starting (opens the wizard on boot) */
    blockers: string[];
    /** Keys shown for these values */
    visible: string[];
    /** Keys required for these values */
    required: string[];
}

const DURATION = /^\d+(\.\d+)?\s*(ms|msecs?|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|y|yrs?|years?)?$/i;
const ORIGIN = /^(\*|(https?:\/\/)?[^/:\s]+(:\d+)?)$/i;
const DB_PREFIX = /^(postgresql|postgres|mysql|mariadb):\/\//;

function typeError(setting: Setting, value: string): string | null {
    switch (setting.type) {
        case 'number':
            return /^\d+$/.test(value) ? null : 'A whole number';
        case 'boolean':
            return value === 'true' || value === 'false' ? null : 'true or false';
        case 'enum':
            return !setting.options || setting.options.includes(value) ? null : `One of: ${setting.options.join(', ')}`;
        case 'multi': {
            const items = listItems(value);
            const unknown = items.filter((i) => !setting.options?.includes(i));
            if (unknown.length) return `Unknown: ${unknown.join(', ')} — allowed: ${setting.options?.join(', ')}`;
            const alone = items.filter((i) => setting.exclusive?.includes(i));
            if (alone.length && items.length > 1) return `${alone.join(', ')} cannot be combined with others`;
            return new Set(items).size === items.length ? null : 'Listed twice';
        }
        case 'url':
            try {
                const url = new URL(value);
                return url.protocol === 'http:' || url.protocol === 'https:' ? null : 'An http:// or https:// URL';
            } catch {
                return 'An http:// or https:// URL';
            }
        case 'json':
            try {
                const parsed = JSON.parse(value);
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? null : 'A JSON object';
            } catch (err) {
                return `Invalid JSON: ${(err as Error).message}`;
            }
        default:
            return null;
    }
}

/** Rules beyond the type. Returns [error, warning] */
function rules(key: string, value: string, values: Values, project?: Partial<ProjectInfo>): [string | null, string | null] {
    const production = values.NODE_ENV === 'production';
    switch (key) {
        case 'DATABASE_URL':
        case 'DATABASE_URL_ADMIN': {
            if (!value) return [null, null];
            if (!DB_PREFIX.test(value)) return ['Must start with postgresql://, postgres://, mysql:// or mariadb://', null];
            try { new URL(value); } catch { return ['Not a valid URL — URL-encode special characters in the password (@ → %40)', null]; }
            const schemaProvider = project?.schema?.provider;
            const urlProvider = detectProvider(value);
            if (key === 'DATABASE_URL' && schemaProvider && schemaProvider !== urlProvider) {
                // A schema without models yet is switched over on save; one with models is a real mismatch
                return Array.isArray(project?.schema?.models) && project!.schema!.models.length === 0
                    ? [null, `The schema is set up for ${schemaProvider} — saving switches it to ${urlProvider}`]
                    : [`The Prisma schema is for ${schemaProvider}, this is a ${urlProvider} database`, null];
            }
            return [null, null];
        }
        case 'PORT':
            return value && (Number(value) < 1 || Number(value) > 65535) ? ['1 – 65535', null] : [null, null];
        case 'AUTH_SALT_ROUNDS':
            // What bcrypt accepts
            return value && (Number(value) < 4 || Number(value) > 31) ? ['4 – 31', null] : [null, null];
        case 'AUTH_PROVIDERS': {
            const providers = listItems(value);
            if (providers.includes('none')) {
                return [null, values.ACL_DEFAULT === 'deny'
                    ? 'No sign-in: every request is anonymous ({ id: null }) — src/config/acl.ts decides what it may do'
                    : 'No sign-in, and models without an entry in src/config/acl.ts are open: anyone who reaches the API may read and change their data. Add access control there, or close such models (ACL_DEFAULT=deny)'];
            }
            // Local sign-in without a user table: nobody can sign in, and the routes refuse every request
            const external = providers.some((p) => p !== 'local');
            const modelled = Array.isArray(project?.schema?.models) && project!.schema!.models.length > 0;
            if (!external && modelled && project?.userModel === null && !values.DB_USER_TABLE) {
                const candidates = project?.userModelCandidates ?? [];
                return [null, candidates.length
                    ? `No user table detected, so nobody can sign in and the API refuses every request — ${candidates.join(' or ')} looks like one: set it as the user table (DB_USER_TABLE), or choose none for an API without sign-in`
                    : 'There is no user table, so nobody can sign in and the API refuses every request — choose none for an API without sign-in, or add a user table'];
            }
            return [null, null];
        }
        case 'JWT_SECRET':
        case 'JWT_REFRESH_SECRET':
        case 'COOKIE_SECRET':
            if (value && value.length < 32) return [null, 'Use at least 32 random characters'];
            if (key === 'JWT_REFRESH_SECRET' && value && value === values.JWT_SECRET) return [null, 'Use a different secret than for access tokens'];
            return [null, null];
        case 'ALLOWED_ORIGINS': {
            const bad = (value || '').split(',').map((s) => s.trim()).filter(Boolean).filter((e) => !ORIGIN.test(e));
            if (bad.length) return [`Not an origin: ${bad.join(', ')}`, null];
            return [null, production && listItems(value).includes('*') ? 'Allows every website to call the API with credentials' : null];
        }
        case 'TRUST_PROXY': {
            const error = value ? trustProxyError(value) : null;
            if (error) return [error, null];
            return [null, production && !value ? 'Unset in production trusts every proxy — set the proxies’ addresses or a hop count' : null];
        }
        case 'AUTH_LINK':
            return value && !/^(email|username|subject|false|none|off|[\w.]+(:[\w.]+)?)$/i.test(value.trim())
                ? ['email, username, subject, false, or <userField>:<identityAttribute>', null] : [null, null];
        case 'AUTH_ACCESS_TOKEN_EXPIRY':
        case 'AUTH_REFRESH_TOKEN_EXPIRY':
            return value && !DURATION.test(value.trim()) ? ['A duration such as 15m, 12h or 30d', null] : [null, null];
        case 'AUTH_SESSION_STORAGE':
            return value === 'redis' && !values.REDIS_URL && !values.REDIS_HOST ? ['Configure Redis (REDIS_URL or REDIS_HOST) first', null]
                : [null, production && (value === 'memory' || (!value && !values.REDIS_URL && !values.REDIS_HOST))
                    ? 'In memory, sessions end on every restart and are not shared between instances' : null];
        case 'AUTH_COOKIE_SAME_SITE':
            return [null, value === 'none' && values.AUTH_COOKIE_SECURE === 'false' ? 'SameSite=none requires Secure cookies' : null];
        case 'API_TIMEZONE':
            if (!value) return [null, null];
            try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return [null, null]; } catch { return ['Unknown timezone — use an IANA name such as Europe/Berlin or UTC', null]; }
        case 'LDAP_URL': {
            const bad = listItems(value).filter((u) => !/^ldaps?:\/\//.test(u));
            if (bad.length) return [`Not an ldap:// or ldaps:// URL: ${bad.join(', ')}`, null];
            return [null, production && listItems(value).some((u) => u.startsWith('ldap://')) && values.LDAP_STARTTLS !== 'true'
                ? 'Passwords travel unencrypted — use ldaps:// or StartTLS' : null];
        }
        case 'LDAP_BIND_TEMPLATE':
            // The provider needs one of the two ways to find users
            return !value && !(values.LDAP_BIND_DN && values.LDAP_SEARCH_BASE)
                ? ['Set a service account (DN + search base) or a direct bind template', null] : [null, null];
        case 'LDAP_TLS_CA_FILE':
            return value && !fs.existsSync(value) ? [`File not found: ${value}`, null] : [null, null];
        case 'SAML_IDP_METADATA_URL':
            // The signing certificates come from it
            return value && /^http:\/\//i.test(value) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(value)
                ? ['Use https — the identity provider’s signing certificates come from it', null] : [null, null];
        case 'SAML_IDP_METADATA_FILE':
            if (!listItems(values.AUTH_PROVIDERS).includes('saml') || values.SAML_IDP_METADATA_URL) return [null, null];
            if (project?.saml && !project.saml.library) return ['SAML needs the @node-saml/node-saml package — run: npm install @node-saml/node-saml', null];
            return project?.saml && !project.saml.metadata
                ? [`Upload the identity provider’s metadata below — or set its URL${value ? ` (no file ${value})` : ''}`, null] : [null, null];
        case 'SAML_SP_ENTITY_ID':
            return listItems(values.AUTH_PROVIDERS).includes('saml') && !values.PUBLIC_URL && !values.SAML_CALLBACK_URL
                ? ['Set PUBLIC_URL (Server) — the identity provider posts sign-ins to <PUBLIC_URL>/auth/saml/callback', null] : [null, null];
        case 'SAML_SP_PRIVATE_KEY_FILE':
        case 'SAML_SP_CERT_FILE': {
            if (!value) return [null, null];
            if (!fs.existsSync(value)) return [`File not found: ${value}`, null];
            try {
                const pem = fs.readFileSync(value, 'utf8');
                if (key === 'SAML_SP_PRIVATE_KEY_FILE') crypto.createPrivateKey(pem);
                else new crypto.X509Certificate(pem);
                return [null, null];
            } catch {
                return [key === 'SAML_SP_PRIVATE_KEY_FILE' ? 'Not a PEM private key' : 'Not a PEM certificate', null];
            }
        }
        case 'RLS_ENABLED':
            return [null, value === 'true' && values.DATABASE_URL && detectProvider(values.DATABASE_URL) === 'mysql'
                ? 'No effect: MySQL and MariaDB have no row-level security — restrict rows in src/config/acl.ts' : null];
        case 'LOG_LEVEL':
            return [null, production && value === 'finest' ? 'finest logs request bodies — keep it for troubleshooting' : null];
        case 'SETUP_PASSWORD':
            return value && value.length < 16 ? ['At least 16 characters', null] : [null, null];
        default:
            return [null, null];
    }
}

/**
 * Problems that keep the API from starting today — exactly these open the wizard on boot,
 * so a deployment that starts now is never sent into setup by a stricter rule.
 */
const BOOT_BLOCKERS = new Set(['DATABASE_URL', 'API_TIMEZONE', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'AUTH_PROVIDERS',
    'LDAP_URL', 'LDAP_BIND_TEMPLATE', 'LDAP_TLS_CA_FILE', 'OIDC_ISSUER', 'WEBDAV_URL', 'TRUST_PROXY']);

export function validate(values: Values, sections: Section[] = buildSections(), project?: Partial<ProjectInfo>): Validation {
    const result: Validation = { errors: {}, warnings: {}, blockers: [], visible: [], required: [] };
    for (const section of sections) {
        const sectionVisible = matches(section.when, values);
        for (const setting of section.settings) {
            if (!sectionVisible || !matches(setting.when, values)) continue;
            result.visible.push(setting.key);
            const value = (values[setting.key] ?? '').trim();
            const required = setting.required === true || (typeof setting.required === 'object' && matches(setting.required, values));
            if (required) result.required.push(setting.key);
            let error: string | null = null;
            let warning: string | null = null;
            if (!value) {
                if (required) error = 'Required';
            } else {
                error = typeError(setting, value);
            }
            if (!error) [error, warning] = rules(setting.key, value, values, project);
            if (error) result.errors[setting.key] = error;
            if (warning) result.warnings[setting.key] = warning;
        }
    }
    // Auth is off without a user table and without external providers — then the API needs
    // no JWT secrets, in production either
    if (project && !authEnabled(values, project)) {
        for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET']) {
            if (result.errors[key] === 'Required') delete result.errors[key];
            result.required = result.required.filter((k) => k !== key);
        }
    }
    result.blockers = Object.keys(result.errors).filter((key) => BOOT_BLOCKERS.has(key));
    return result;
}

/** Mirrors Auth: off with AUTH_PROVIDERS=none; on with a user table (detected or DB_USER_TABLE) or any external provider */
export function authEnabled(values: Values, project: Partial<ProjectInfo>): boolean {
    if (listItems(values.AUTH_PROVIDERS).includes('none')) return false;
    const external = listItems(values.AUTH_PROVIDERS).some((p) => p !== 'local');
    return external || !!values.DB_USER_TABLE || !!project.userModel;
}

/** Keys whose change can show/hide or require other settings — the UI re-evaluates on these */
export function drivers(sections: Section[]): string[] {
    return conditionKeys(sections);
}

// ── Saving ───────────────────────────────────────────────────────────────────

export interface SaveResult {
    file: string;
    backup: string | null;
    written: string[];
    removed: string[];
    /** Keys set by the real environment — changing them in the file has no effect */
    ignored: string[];
}

/**
 * Write changed settings to the env file and apply them to process.env (so a first-boot
 * handover starts the API with them). Empty values remove the key from the file.
 */
export function saveSettings(changes: Values, sections: Section[], file: string = envFilePath()): SaveResult {
    const fileChanges: Record<string, string | null> = {};
    const result: SaveResult = { file, backup: null, written: [], removed: [], ignored: [] };
    for (const [key, raw] of Object.entries(changes)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid variable name: ${key}`);
        const value = (raw ?? '').trim() === '' ? '' : raw!;
        if (valueSource(key) === 'environment') {
            result.ignored.push(key);
            continue;
        }
        fileChanges[key] = value === '' ? null : value;
        (value === '' ? result.removed : result.written).push(key);
    }
    if (Object.keys(fileChanges).length === 0) return result;

    const { content } = readEnvFile(file);
    const header = content ? '' : '# Written by the Rapidd setup wizard — see .env.example for every setting\n';
    const updated = updateEnvContent(header + content, fileChanges, envLayout(sections));
    result.backup = writeEnvFile(file, updated).backup;

    for (const [key, value] of Object.entries(fileChanges)) {
        if (value === null) delete process.env[key];
        else process.env[key] = value;
        markFromFile(key, value !== null);
    }
    return result;
}

// ── Exports ──────────────────────────────────────────────────────────────────

export type ExportFormat = 'env' | 'compose' | 'kubernetes' | 'shell';

/** The configured (non-empty) settings in a format for another home: compose, a Kubernetes Secret, a shell */
export function exportSettings(values: Values, format: ExportFormat, sections: Section[] = buildSections(), name = 'rapidd-config'): string {
    const entries = Object.entries(values).filter(([, v]) => v !== undefined && v !== '') as [string, string][];
    const yaml = (v: string) => JSON.stringify(v); // a JSON string is a valid YAML scalar
    switch (format) {
        case 'compose':
            return ['services:', '  api:', '    environment:', ...entries.map(([k, v]) => `      ${k}: ${yaml(v)}`)].join('\n') + '\n';
        case 'kubernetes':
            return ['apiVersion: v1', 'kind: Secret', 'metadata:', `  name: ${name}`, 'type: Opaque', 'stringData:',
                ...entries.map(([k, v]) => `  ${k}: ${yaml(v)}`)].join('\n') + '\n';
        case 'shell':
            return entries.map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'`).join('\n') + '\n';
        default:
            return updateEnvContent('', Object.fromEntries(entries), envLayout(sections));
    }
}
