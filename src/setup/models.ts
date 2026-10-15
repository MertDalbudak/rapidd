import fs from 'fs';
import path from 'path';
import { relationFields, type RelationField } from './schema';
import { keyOf } from '../core/dmmf';
import type { AclConfig, DMMF, DMMFField, DMMFModel } from '../types';

/**
 * The data model as the wizard shows it: per model its fields, the generated code (model
 * class, REST route) and whether src/config/acl.ts has an entry for it.
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
    /** The relation fields in detail, with a clearer name where introspection's is not one */
    relationFields: RelationField[];
    /** src/models/<Class>.ts */
    modelFile: { path: string; exists: boolean };
    /** Its REST route: a file of its own, nested under its parents (a join table), or none */
    route: { kind: 'route' | 'nested' | 'none'; url: string | null; file: string | null; exists: boolean; parents?: string[]; reason?: string };
    /** src/config/acl.ts has an entry for the model — else ACL_DEFAULT applies */
    code: boolean;
    /** Credential-like fields — returned by the API unless acl.ts hides them */
    sensitive: string[];
}

/** Same as @rapidd/build: credential columns its generated acl.ts hides */
const SENSITIVE = /^(password|passwd|pwd|hash|password_?hash|hashed_?password)$|secret|token$|_token|api_?key/i;

/** @rapidd/build's file name for a model class */
export function className(model: string): string {
    return model.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function exists(root: string, ...candidates: string[]): string | null {
    return candidates.find((c) => fs.existsSync(path.join(root, c))) ?? null;
}

/** The model's REST route, as @rapidd/build generates it (join tables become sub-routes of their parents) */
function routeOf(root: string, model: DMMFModel): ModelOverview['route'] {
    const key = keyOf(model);
    if (key.length === 2) {
        const parents = key.map((k) => model.fields.find((f) => f.kind === 'object' && f.relationFromFields?.includes(k))?.type).filter(Boolean) as string[];
        if (parents.length === 2) return { kind: 'nested', url: null, file: null, exists: false, parents };
    }
    const dir = path.join('routes', 'api', 'v1');
    const file = exists(root, ...['.ts', '.js'].flatMap((ext) => [path.join(dir, `${model.name}${ext}`), path.join(dir, model.name, `index${ext}`)]));
    return { kind: 'route', url: `/api/v1/${model.name}`, file: file ?? path.join(dir, `${model.name}.ts`), exists: !!file };
}

/** src/config/acl.ts as the app loads it — fresh on every call: a build may have just written it */
export function loadCodeAcl(root: string): { file: string | null; acl: AclConfig | null; error?: string } {
    const file = exists(root, 'src/config/acl.ts', 'src/config/acl.js', 'dist/src/config/acl.js');
    if (!file) return { file: null, acl: null };
    try {
        // Resolved next to this module, so the compiled app (dist/) loads its compiled acl.js
        const resolved = require.resolve('../config/acl');
        delete require.cache[resolved];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const loaded = require(resolved);
        return { file, acl: (loaded.default || loaded) as AclConfig };
    } catch (err) {
        return { file, acl: null, error: (err as Error).message.split('\n')[0] };
    }
}

/** Models with an entry in src/config/acl.ts */
export function codeAcl(root: string): { file: string | null; models: string[]; error?: string } {
    const { file, acl, error } = loadCodeAcl(root);
    return { file, models: Object.keys(acl?.model ?? {}), ...(error ? { error } : {}) };
}

/**
 * `userModel`: the user table and its password column (DB_USER_PASSWORD_FIELD may name one the
 * credential pattern doesn't know)
 */
export function modelsOverview(
    root: string,
    dmmf: DMMF | null,
    code: string[] = codeAcl(root).models,
    userModel: { model: string; passwordField: string | null } | null = null,
): ModelOverview[] {
    return (dmmf?.datamodel.models ?? []).map((model) => {
        const scalars = model.fields.filter((f) => f.kind !== 'object');
        const password = model.name === userModel?.model ? userModel.passwordField : null;
        const key = keyOf(model);
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
            relationFields: dmmf ? relationFields(dmmf, model) : [],
            modelFile: { path: modelFile, exists: fs.existsSync(path.join(root, modelFile)) },
            route: routeOf(root, model),
            code: code.includes(model.name),
            sensitive: scalars.filter((f) => SENSITIVE.test(f.name) || f.name === password).map((f) => f.name),
        };
    });
}

/** Path prefixes worth a rate limit: sign-in endpoints and the model routes */
export function routePrefixes(models: ModelOverview[]): string[] {
    return ['/auth/login', '/auth/refresh', '/auth', '/api/v1', ...models.filter((m) => m.route.kind === 'route').map((m) => m.route.url!)];
}
