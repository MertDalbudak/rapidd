import fs from 'fs';
import path from 'path';
import { isRulesEntry } from '../core/aclRules';
import { describeUserModel } from './project';
import type { DMMF, DMMFField, DMMFModel } from '../types';

/**
 * The data model as the wizard shows it: per model the generated code (model class, REST
 * route) and whether code owns its access control — plus what the access rule editor
 * needs: fields, the user's attributes and the known roles.
 */

export interface ModelField {
    name: string;
    /** Column name in the database */
    column: string;
    type: string;
    kind: string;
    isList: boolean;
    isId: boolean;
    isRequired: boolean;
}

export interface ModelOverview {
    name: string;
    table: string;
    key: string[];
    /** Scalar and enum fields (relations left out) */
    fields: ModelField[];
    /** Relation fields: name → related model */
    relations: Record<string, string>;
    /** src/models/<Class>.ts */
    modelFile: { path: string; exists: boolean };
    /** Its REST route: a file of its own, nested under its parents (a join table), or none */
    route: { kind: 'route' | 'nested' | 'none'; url: string | null; file: string | null; exists: boolean; parents?: string[]; reason?: string };
    /** An entry in src/config/acl.ts takes the model over — its rules are not used */
    code: boolean;
    /** Credential-like fields: hidden by the default rules */
    sensitive: string[];
}

export interface AclContext {
    models: ModelOverview[];
    /** Fields of the user table that can hold a role */
    roleFieldCandidates: string[];
    /** Roles the project knows of: enum values of the role field, AUTH_ROLE_MAP, AUTH_DEFAULT_ROLE */
    roles: string[];
    userModel: string | null;
    /** For "$user.<attribute>" in row filters */
    userAttributes: string[];
    codeFile: string | null;
    codeError?: string;
}

/** Same as @rapidd/build: credential columns are hidden by default rules */
const SENSITIVE = /^(password|passwd|pwd|hash|password_?hash|hashed_?password)$|secret|token$|_token|api_?key/i;
const ROLE_FIELD = /role|group|type|level|permission|kind/i;

/** @rapidd/build's file name for a model class */
export function className(model: string): string {
    return model.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function exists(root: string, ...candidates: string[]): string | null {
    return candidates.find((c) => fs.existsSync(path.join(root, c))) ?? null;
}

/** The model's REST route, as @rapidd/build generates it (join tables become sub-routes of their parents) */
function routeOf(root: string, model: DMMFModel): ModelOverview['route'] {
    const key = model.primaryKey?.fields ?? [];
    if (key.length > 2) return { kind: 'none', url: null, file: null, exists: false, reason: 'A key of three or more columns has no REST route' };
    if (key.length === 2) {
        const parents = key.map((k) => model.fields.find((f) => f.kind === 'object' && f.relationFromFields?.includes(k))?.type).filter(Boolean) as string[];
        if (parents.length === 2) return { kind: 'nested', url: null, file: null, exists: false, parents };
    }
    const dir = path.join('routes', 'api', 'v1');
    const file = exists(root, ...['.ts', '.js'].flatMap((ext) => [path.join(dir, `${model.name}${ext}`), path.join(dir, model.name, `index${ext}`)]));
    return { kind: 'route', url: `/api/v1/${model.name}`, file: file ?? path.join(dir, `${model.name}.ts`), exists: !!file };
}

/** Models with an entry written in src/config/acl.ts (entries from config/acl.json are not code) */
export function codeAcl(root: string): { file: string | null; models: string[]; error?: string } {
    const file = exists(root, 'src/config/acl.ts', 'src/config/acl.js', 'dist/src/config/acl.js');
    if (!file) return { file: null, models: [] };
    try {
        // Fresh on every call: a build may have just written it. Resolved next to this module,
        // so the compiled app (dist/) loads its compiled acl.js
        const resolved = require.resolve('../config/acl');
        delete require.cache[resolved];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const loaded = require(resolved);
        const model = (loaded.default || loaded)?.model ?? {};
        return { file, models: Object.keys(model).filter((name) => !isRulesEntry(model[name])) };
    } catch (err) {
        return { file, models: [], error: (err as Error).message.split('\n')[0] };
    }
}

export function modelsOverview(root: string, dmmf: DMMF | null, code: string[] = codeAcl(root).models): ModelOverview[] {
    return (dmmf?.datamodel.models ?? []).map((model) => {
        const scalars = model.fields.filter((f) => f.kind !== 'object');
        const key = model.primaryKey?.fields?.length ? model.primaryKey.fields : scalars.filter((f) => f.isId).map((f) => f.name);
        const modelFile = path.join('src', 'models', `${className(model.name)}.ts`);
        return {
            name: model.name,
            table: (model as { dbName?: string | null }).dbName || model.name,
            key,
            fields: scalars.map((f: DMMFField) => ({
                name: f.name,
                column: (f as { dbName?: string | null }).dbName || f.name,
                type: f.type,
                kind: f.kind,
                isList: f.isList,
                isId: f.isId,
                isRequired: f.isRequired,
            })),
            relations: Object.fromEntries(model.fields.filter((f) => f.kind === 'object').map((f) => [f.name, f.type])),
            modelFile: { path: modelFile, exists: fs.existsSync(path.join(root, modelFile)) },
            route: routeOf(root, model),
            code: code.includes(model.name),
            sensitive: scalars.filter((f) => SENSITIVE.test(f.name)).map((f) => f.name),
        };
    });
}

/** What the access rule editor needs to know about the project */
export function aclContext(root: string, dmmf: DMMF | null, env: Record<string, string | undefined> = process.env, roleField = 'role'): AclContext {
    const code = codeAcl(root);
    const models = modelsOverview(root, dmmf, code.models);
    const userModel = dmmf ? describeUserModel(dmmf, env)?.model : undefined;
    const user = dmmf?.datamodel.models.find((m) => m.name === userModel);
    const scalars = user?.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum') ?? [];

    const roles = new Set<string>();
    const field = scalars.find((f) => f.name === roleField);
    if (field?.kind === 'enum') {
        const enums = (dmmf?.datamodel as { enums?: { name: string; values: { name: string }[] }[] }).enums ?? [];
        for (const v of enums.find((e) => e.name === field.type)?.values ?? []) roles.add(v.name);
    }
    try {
        const map = env.AUTH_ROLE_MAP ? JSON.parse(env.AUTH_ROLE_MAP) : {};
        for (const role of Object.values(map ?? {})) if (typeof role === 'string' && role) roles.add(role);
    } catch {
        // invalid AUTH_ROLE_MAP is reported on the sign-in page
    }
    if (env.AUTH_DEFAULT_ROLE) roles.add(env.AUTH_DEFAULT_ROLE);

    return {
        models,
        roleFieldCandidates: scalars.filter((f) => !f.isList && (f.kind === 'enum' || f.type === 'String') && ROLE_FIELD.test(f.name)).map((f) => f.name),
        roles: [...roles],
        userModel: user?.name ?? null,
        userAttributes: scalars.filter((f) => !SENSITIVE.test(f.name)).map((f) => f.name),
        codeFile: code.file,
        ...(code.error ? { codeError: code.error } : {}),
    };
}

/** Path prefixes worth a rate limit: sign-in endpoints and the model routes */
export function routePrefixes(models: ModelOverview[]): string[] {
    return ['/auth/login', '/auth/refresh', '/auth', '/api/v1', ...models.filter((m) => m.route.kind === 'route').map((m) => m.route.url!)];
}
