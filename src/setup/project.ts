import fs from 'fs';
import path from 'path';
import { envFilePath, writeEnvFile } from './envfile';
import { detectProvider } from '../core/adapter';
import { isConfigContext } from '../core/rlsRules';
import { codeAcl } from './models';
import { readConfigText } from './files';
import type { DMMF, DMMFField, DMMFModel } from '../types';
import { idpMetadataPath, uploadsToDefault } from './saml';

/**
 * What the setup wizard shows about the project beyond the environment: the Prisma
 * schema and client, generated code, ACL coverage, config files and available tools.
 * Everything is read fresh on each call — the wizard's actions change these.
 */

export interface ConfigFileInfo {
    path: string;
    exists: boolean;
    valid: boolean;
    error?: string;
    /** ${NAME} / ${NAME:-default} references to environment variables */
    envRefs: { name: string; default?: string }[];
}

export interface FieldSpec {
    name: string;
    type: string;
    kind: string;
    required: boolean;
    enumValues?: string[];
    isList?: boolean;
    /** The column's default, when it is a plain value (shown preselected) */
    default?: string;
}

export interface UserModelInfo {
    model: string;
    passwordField: string | null;
    identifierFields: string[];
    /** Fields the first user needs (identifiers, required columns without a default) */
    fields: FieldSpec[];
}

export interface ProjectInfo {
    root: string;
    /** display: relative to the project when inside it */
    envFile: { path: string; display: string; exists: boolean; writable: boolean };
    /** Running in a container — files written there are lost on redeploy unless on a volume */
    container: boolean;
    schema: { path: string; exists: boolean; provider: string | null; models: string[]; tables: Record<string, string>; error?: string };
    client: { generated: boolean };
    migrations: boolean;
    generated: { models: number; routes: number };
    /** Access control: src/config/acl.ts and the models without an entry there */
    acl: { codeFile: string | null; missing: string[]; error?: string };
    /** Where the RLS variables come from: config/rls.json, or a function in src/config/rls.ts */
    rls: { source: 'config' | 'code'; error?: string };
    configFiles: Record<'app' | 'rateLimit', ConfigFileInfo>;
    locales: string[];
    tools: { prisma: boolean; rapiddBuild: boolean };
    userModel: UserModelInfo | null;
    /** SAML: the IdP metadata file (an unsaved upload counts) and whether the SAML library is installed */
    saml: { metadataFile: string; metadata: boolean; library: boolean };
    /** Without a detected user table: tables that look like one (for DB_USER_TABLE) */
    userModelCandidates: string[];
}

const USER_MODEL_NAMES = ['user', 'users', 'account', 'accounts'];
const PASSWORD_FIELD_NAMES = ['password', 'hash', 'passwordhash', 'password_hash', 'passwd', 'pwd', 'hashed_password'];
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

const DATASOURCE_PROVIDER = /(datasource\s+\w+\s*\{[^}]*?provider\s*=\s*")(\w+)(")/;

/** The datasource provider of schema source (postgresql, mysql, ...) */
export function schemaProvider(source: string): string | null {
    return DATASOURCE_PROVIDER.exec(source)?.[2] ?? null;
}

/** The provider the generated Prisma client was built for — null when there is no client */
export function clientProvider(root: string): string | null {
    try {
        return schemaProvider(fs.readFileSync(path.join(root, 'prisma', 'client', 'schema.prisma'), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * A fresh schema (no models yet) follows the database: its datasource provider is set to
 * the one DATABASE_URL needs — the scaffold says postgresql, a MySQL / MariaDB database needs
 * mysql. A schema with models is never changed (that is a real mismatch).
 */
export function alignSchemaProvider(root: string, url: string | undefined): { changed: boolean; from?: string; to?: string } {
    if (!url) return { changed: false };
    const file = path.join(root, 'prisma', 'schema.prisma');
    let source: string;
    try {
        source = fs.readFileSync(file, 'utf8');
    } catch {
        return { changed: false };
    }
    const from = schemaProvider(source);
    const to = detectProvider(url);
    if (!from || from === to || /^\s*model\s+\w+/m.test(source)) return { changed: false, from: from ?? undefined, to };
    writeEnvFile(file, source.replace(DATASOURCE_PROVIDER, `$1${to}$3`));
    fs.chmodSync(file, 0o644);
    return { changed: true, from, to };
}

/** Prisma's CLI accepts mysql:// only — a mariadb:// URL (fine for the app) is passed on as mysql:// */
export function cliDatabaseUrl(url: string): string {
    return url.replace(/^mariadb:\/\//, 'mysql://');
}

/** Locate a package's bin script from the project (handles hoisting) */
export function findBin(pkg: string, root: string = process.cwd()): string | null {
    try {
        const manifest = require.resolve(`${pkg}/package.json`, { paths: [root] });
        const { bin } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        const rel = typeof bin === 'string' ? bin : bin && Object.values(bin)[0];
        return rel ? path.join(path.dirname(manifest), rel as string) : null;
    } catch {
        return null;
    }
}

function countFiles(dir: string, pattern: RegExp): number {
    if (!fs.existsSync(dir)) return 0;
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name), pattern);
        else if (pattern.test(entry.name)) count++;
    }
    return count;
}

function writable(file: string): boolean {
    try {
        fs.accessSync(fs.existsSync(file) ? file : path.dirname(file), fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

/** ${NAME} / ${NAME:-default} references in a config text */
export function envRefsOf(content: string): ConfigFileInfo['envRefs'] {
    const refs = new Map<string, string | undefined>();
    for (const match of content.matchAll(ENV_REF)) {
        if (!refs.has(match[1])) refs.set(match[1], match[2]);
    }
    return [...refs].map(([name, def]) => (def === undefined ? { name } : { name, default: def }));
}

/** A config file — or, when given, its staged content (not yet saved) */
export function readConfigFile(root: string, rel: string, staged?: string): ConfigFileInfo & { content: string } {
    let content = '';
    if (staged !== undefined) {
        content = staged;
    } else {
        try {
            content = fs.readFileSync(path.join(root, rel), 'utf8');
        } catch {
            return { path: rel, exists: false, valid: true, envRefs: [], content: '' };
        }
    }
    let valid = true;
    let error: string | undefined;
    try {
        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object');
    } catch (err) {
        valid = false;
        error = (err as Error).message;
    }
    return { path: rel, exists: true, valid, error, content, envRefs: envRefsOf(content) };
}

type SchemaInfo = { dmmf: DMMF | null; provider: string | null; error?: string; exists: boolean };
let _schemaCache: { key: string; info: SchemaInfo } | null = null;

/**
 * Parse the schema with Prisma (not the app's cached DMMF). Re-parsed only when the file
 * changes — the wizard asks on every edit, and parsing takes Prisma's engine a moment.
 */
export async function readSchema(root: string): Promise<SchemaInfo> {
    const file = path.join(root, 'prisma', 'schema.prisma');
    let source: string;
    let key: string;
    try {
        const stat = fs.statSync(file);
        key = `${file}:${stat.mtimeMs}:${stat.size}`;
        if (_schemaCache?.key === key) return _schemaCache.info;
        source = fs.readFileSync(file, 'utf8');
    } catch {
        return { dmmf: null, provider: null, exists: false };
    }
    const info = await parseSchema(source);
    _schemaCache = { key, info };
    return info;
}

async function parseSchema(source: string): Promise<SchemaInfo> {
    const provider = schemaProvider(source);
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getDMMF } = require('@prisma/internals');
        return { dmmf: await getDMMF({ datamodel: source }), provider, exists: true };
    } catch (err) {
        // Prisma colors its validation output — keep the text only
        // eslint-disable-next-line no-control-regex
        const message = (err as Error).message.replace(/\u001b\[[0-9;]*m/g, '');
        return { dmmf: null, provider, exists: true, error: message.split('\n').slice(0, 12).join('\n') };
    }
}

/**
 * Tables that look like users — a password column and a unique text identifier — for
 * DB_USER_TABLE when the table is not called user, users, account or accounts
 */
export function userModelCandidates(dmmf: DMMF): string[] {
    return dmmf.datamodel.models.filter((m) => {
        const scalars = m.fields.filter((f) => f.kind === 'scalar');
        return scalars.some((f) => PASSWORD_FIELD_NAMES.includes(f.name.toLowerCase()))
            && scalars.some((f) => f.isUnique && f.type === 'String' && !f.isId);
    }).map((m) => m.name);
}

/** The user model and what a first user needs, from env overrides or detection (as Auth does) */
export function describeUserModel(dmmf: DMMF, env: Record<string, string | undefined> = process.env): UserModelInfo | null {
    const models = dmmf.datamodel.models;
    const model: DMMFModel | undefined = env.DB_USER_TABLE
        ? models.find((m) => m.name === env.DB_USER_TABLE)
        : USER_MODEL_NAMES.map((n) => models.find((m) => m.name.toLowerCase() === n)).find(Boolean);
    if (!model) return null;

    const scalars = model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum');
    const passwordField = env.DB_USER_PASSWORD_FIELD
        || scalars.find((f) => PASSWORD_FIELD_NAMES.includes(f.name.toLowerCase()))?.name
        || null;
    const configuredIds = (env.DB_USER_IDENTIFIER_FIELDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const detectedIds = scalars
        .filter((f) => f.isUnique && f.type === 'String' && !f.isId && !PASSWORD_FIELD_NAMES.includes(f.name.toLowerCase()))
        .map((f) => f.name);
    const identifierFields = configuredIds.length ? configuredIds : detectedIds.length ? detectedIds : ['email'];

    const enums = (dmmf.datamodel as any).enums as { name: string; values: { name: string }[] }[] | undefined;
    const spec = (f: DMMFField, required: boolean): FieldSpec => {
        const def = (f as { default?: unknown }).default;
        return {
            name: f.name, type: f.type, kind: f.kind, required, isList: f.isList,
            ...(f.kind === 'enum' ? { enumValues: enums?.find((e) => e.name === f.type)?.values.map((v) => v.name) } : {}),
            ...(['string', 'number', 'boolean'].includes(typeof def) ? { default: String(def) } : {}),
        };
    };
    const fields: FieldSpec[] = [];
    for (const f of scalars) {
        if (f.name === passwordField || f.isList || f.isId) continue;
        const generated = f.hasDefaultValue || f.isUpdatedAt === true;
        if (identifierFields.includes(f.name)) fields.push(spec(f, f.isRequired && !generated));
        else if (f.isRequired && !generated) fields.push(spec(f, true));
        // A first account is usually the administrator: offer the columns with a fixed default —
        // flags, status, levels — preselected, whatever they are called (generated values such
        // as now() or uuid() are left out)
        else if (['string', 'number', 'boolean'].includes(typeof (f as { default?: unknown }).default) && !f.isUpdatedAt) {
            fields.push(spec(f, false));
        }
    }
    return { model: model.name, passwordField, identifierFields, fields };
}

/** Drop src/config/acl and src/config/rls from the module cache — a build may rewrite acl.ts, rls.ts reads config/rls.json */
export function forgetConfigModules(): void {
    for (const id of ['../config/acl', '../config/rls']) {
        try {
            delete require.cache[require.resolve(id)];
        } catch {
            // not there
        }
    }
}

/** Where the RLS variables come from — src/config/rls.ts built from config/rls.json, or its own function */
function rlsSource(): ProjectInfo['rls'] {
    try {
        const resolved = require.resolve('../config/rls');
        delete require.cache[resolved];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const loaded = require(resolved);
        return { source: isConfigContext(loaded.default || loaded) ? 'config' : 'code' };
    } catch (err) {
        return { source: 'config', error: (err as Error).message.split('\n')[0] };
    }
}

export async function inspectProject(
    root: string = process.cwd(),
    env: Record<string, string | undefined> = process.env,
    staged: { app?: string; samlIdp?: string } = {},
): Promise<ProjectInfo> {
    const envPath = envFilePath();
    const schema = await readSchema(root);
    const models = schema.dmmf?.datamodel.models ?? [];

    const code = codeAcl(root);
    const acl: ProjectInfo['acl'] = {
        codeFile: code.file,
        missing: models.map((m) => m.name).filter((n) => !code.models.includes(n)),
        ...(code.error ? { error: code.error } : {}),
    };

    let clientGenerated = false;
    try {
        require.resolve(path.join(root, 'prisma', 'client'));
        clientGenerated = true;
    } catch {
        clientGenerated = false;
    }

    let locales: string[] = [];
    try {
        locales = fs.readdirSync(path.join(root, 'locales')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
    } catch {
        locales = [];
    }

    const { content: _app, ...app } = readConfigFile(root, 'config/app.json', staged.app);
    const { content: _rl, ...rateLimit } = readConfigFile(root, 'config/rate-limit.json');

    return {
        root,
        envFile: {
            path: envPath,
            display: path.relative(root, envPath).startsWith('..') ? envPath : path.relative(root, envPath),
            exists: fs.existsSync(envPath),
            writable: writable(envPath),
        },
        container: fs.existsSync('/.dockerenv') || !!process.env.KUBERNETES_SERVICE_HOST,
        schema: {
            path: 'prisma/schema.prisma',
            exists: schema.exists,
            provider: schema.provider,
            models: models.map((m) => m.name),
            tables: Object.fromEntries(models.map((m) => [m.name, (m as any).dbName || m.name])),
            ...(schema.error ? { error: schema.error } : {}),
        },
        client: { generated: clientGenerated },
        migrations: fs.existsSync(path.join(root, 'prisma', 'migrations')),
        generated: {
            models: countFiles(path.join(root, 'src', 'models'), /\.ts$/),
            routes: countFiles(path.join(root, 'routes', 'api'), /\.(ts|js)$/),
        },
        acl,
        rls: rlsSource(),
        configFiles: { app, rateLimit },
        locales,
        tools: { prisma: !!findBin('prisma', root), rapiddBuild: !!findBin('@rapidd/build', root) },
        saml: {
            metadataFile: idpMetadataPath(env),
            metadata: (staged.samlIdp !== undefined && uploadsToDefault(env)) || fs.existsSync(path.resolve(root, idpMetadataPath(env))),
            library: (() => {
                try {
                    require.resolve('@node-saml/node-saml', { paths: [root] });
                    return true;
                } catch {
                    return false;
                }
            })(),
        },
        userModel: schema.dmmf ? describeUserModel(schema.dmmf, env) : null,
        userModelCandidates: schema.dmmf && !describeUserModel(schema.dmmf, env) ? userModelCandidates(schema.dmmf) : [],
    };
}
