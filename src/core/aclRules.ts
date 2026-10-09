import fs from 'fs';
import path from 'path';
import type { ModelAcl, RapiddUser } from '../types';

/**
 * Declarative access control: config/acl.json, edited in the setup wizard.
 *
 *   {
 *     "roleField": "role",
 *     "models": {
 *       "post": {
 *         "create": { "*": true },
 *         "read":   { "admin": "all", "*": { "where": { "author_id": "$user.id" } } },
 *         "update": { "admin": "all", "*": { "where": { "author_id": "$user.id" } } },
 *         "delete": { "admin": "all" },
 *         "hide":   { "*": ["internal_notes"], "admin": [] },
 *         "write":  { "*": ["title", "content"], "admin": "all" }
 *       }
 *     }
 *   }
 *
 * Each rule is keyed by role (the user's `roleField`); "*" covers every role not listed.
 * Rows: "all", "none", or a Prisma where whose "$user.<attribute>" values come from the
 * signed-in user. Fail closed: a missing rule, an unlisted role or a missing user attribute
 * grants nothing. `hide` lists fields never returned; `write` lists the only writable fields
 * ("all": no restriction).
 * src/config/acl.ts loads these rules — code entries there override them per model.
 */

/** Which rows an action may touch */
export type AclScope = 'all' | 'none' | { where: Record<string, unknown> };
/** A value per role; "*" applies to every role not listed */
export type ByRole<T> = Record<string, T>;

export interface ModelRules {
    create?: ByRole<boolean>;
    read?: ByRole<AclScope>;
    update?: ByRole<AclScope>;
    delete?: ByRole<AclScope>;
    hide?: ByRole<string[]>;
    /** The only writable fields — "all" for no restriction */
    write?: ByRole<string[] | 'all'>;
}

export interface AclRules {
    /** User attribute holding the role (default: "role") */
    roleField?: string;
    models: Record<string, ModelRules>;
}

export const ACL_RULES_FILE = path.join('config', 'acl.json');

/** Marks ACL entries generated from rules — anything else in the ACL is code */
export const FROM_RULES = Symbol.for('rapidd.acl.fromRules');

/** A rules file that cannot be used — the API must not start with it (never fail open) */
export class AclRulesError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AclRulesError';
    }
}

const ACTIONS = ['create', 'read', 'update', 'delete', 'hide', 'write'] as const;
const USER_REF = /^\$user\.([A-Za-z_][\w.]*)$/;

/** config/acl.json, or null when there is none */
export function loadAclRules(file: string = path.join(process.cwd(), ACL_RULES_FILE)): AclRules | null {
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err: any) {
        if (err?.code === 'ENOENT') return null;
        throw new AclRulesError(`${file} cannot be read: ${err?.message || err}`);
    }
    let rules: unknown;
    try {
        rules = JSON.parse(text);
    } catch (err) {
        throw new AclRulesError(`${file} is not valid JSON: ${(err as Error).message}`);
    }
    const problems = validateAclRules(rules);
    if (problems.length > 0) throw new AclRulesError(`${file}: ${problems.join('; ')}`);
    return rules as AclRules;
}

function isScope(value: unknown): boolean {
    if (value === 'all' || value === 'none') return true;
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 1 && !!(value as any).where && typeof (value as any).where === 'object' && !Array.isArray((value as any).where);
}

/**
 * Problems with a rules object — structure, and (when the schema is given) unknown models
 * and fields. Empty when it is usable.
 */
export function validateAclRules(rules: unknown, models?: Record<string, string[]>): string[] {
    const problems: string[] = [];
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return ['must be a JSON object'];
    const r = rules as Record<string, any>;
    if (r.roleField !== undefined && (typeof r.roleField !== 'string' || !r.roleField)) problems.push('roleField must be a field name');
    if (!r.models || typeof r.models !== 'object' || Array.isArray(r.models)) return [...problems, 'models must be an object'];

    for (const [model, rule] of Object.entries(r.models as Record<string, any>)) {
        if (models && !models[model]) problems.push(`${model}: no such model in the schema`);
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
            problems.push(`${model}: must be an object`);
            continue;
        }
        for (const [action, byRole] of Object.entries(rule)) {
            if (!(ACTIONS as readonly string[]).includes(action)) {
                problems.push(`${model}.${action}: unknown — use ${ACTIONS.join(', ')}`);
                continue;
            }
            if (!byRole || typeof byRole !== 'object' || Array.isArray(byRole)) {
                problems.push(`${model}.${action}: must map roles to values`);
                continue;
            }
            for (const [role, value] of Object.entries(byRole as Record<string, unknown>)) {
                const at = `${model}.${action}.${role}`;
                if (action === 'create' && typeof value !== 'boolean') problems.push(`${at}: true or false`);
                if (['read', 'update', 'delete'].includes(action) && !isScope(value)) problems.push(`${at}: "all", "none" or { "where": { ... } }`);
                if (action === 'write' && value === 'all') continue;
                if (action === 'hide' || action === 'write') {
                    if (!Array.isArray(value) || value.some((f) => typeof f !== 'string')) {
                        problems.push(`${at}: a list of field names${action === 'write' ? ' or "all"' : ''}`);
                    } else if (models?.[model]) {
                        const unknown = value.filter((f) => !models[model].includes(f));
                        if (unknown.length) problems.push(`${at}: unknown field(s) ${unknown.join(', ')}`);
                    }
                }
                if (['read', 'update', 'delete'].includes(action) && isScope(value) && typeof value === 'object' && models?.[model]) {
                    const unknown = Object.keys((value as any).where).filter((f) => !['AND', 'OR', 'NOT'].includes(f) && !models[model].includes(f));
                    if (unknown.length) problems.push(`${at}: unknown field(s) ${unknown.join(', ')}`);
                }
            }
        }
    }
    return problems;
}

/** Replace "$user.<attr>" values; null when an attribute is missing (the scope then grants nothing) */
export function resolveUserRefs(value: unknown, user: RapiddUser | null): unknown {
    if (typeof value === 'string') {
        const ref = USER_REF.exec(value);
        if (!ref) return value;
        let current: any = user;
        for (const part of ref[1].split('.')) current = current == null ? undefined : current[part];
        if (current === undefined || current === null) throw MISSING;
        return current;
    }
    if (Array.isArray(value)) return value.map((v) => resolveUserRefs(v, user));
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = resolveUserRefs(v, user);
        return out;
    }
    return value;
}
const MISSING = Symbol('missing user attribute');

function scopeFilter(scope: AclScope | undefined, user: RapiddUser | null): Record<string, unknown> | boolean {
    if (scope === 'all') return true;
    if (!scope || scope === 'none') return false;
    try {
        return resolveUserRefs(scope.where, user) as Record<string, unknown>;
    } catch (err) {
        if (err === MISSING) return false;
        throw err;
    }
}

/**
 * ACL entries for every model in the rules (default: config/acl.json). Spread them into
 * src/config/acl.ts; entries written in code after them win.
 */
export function aclFromRules(rules: AclRules | null = loadAclRules()): Record<string, ModelAcl> {
    if (!rules) return {};
    const roleField = rules.roleField || 'role';
    const pick = <T>(byRole: ByRole<T> | undefined, user: RapiddUser | null): T | undefined => {
        if (!byRole) return undefined;
        const role = (user as any)?.[roleField];
        if (role !== undefined && role !== null && Object.prototype.hasOwnProperty.call(byRole, String(role))) return byRole[String(role)];
        return Object.prototype.hasOwnProperty.call(byRole, '*') ? byRole['*'] : undefined;
    };

    const out: Record<string, ModelAcl> = {};
    for (const [model, rule] of Object.entries(rules.models)) {
        const acl: ModelAcl = {
            canCreate: (user) => pick(rule.create, user) === true,
            getAccessFilter: (user) => scopeFilter(pick(rule.read, user), user),
            getUpdateFilter: (user) => scopeFilter(pick(rule.update, user), user),
            getDeleteFilter: (user) => scopeFilter(pick(rule.delete, user), user),
            getOmitFields: (user) => [...(pick(rule.hide, user) ?? [])],
            getWritableFields: (user) => {
                const fields = pick(rule.write, user);
                return Array.isArray(fields) ? [...fields] : null;
            },
        };
        Object.defineProperty(acl, FROM_RULES, { value: true });
        out[model] = acl;
    }
    return out;
}

/** Was this ACL entry generated from rules (as opposed to written in code)? */
export function isRulesEntry(entry: unknown): boolean {
    return !!entry && typeof entry === 'object' && (entry as any)[FROM_RULES] === true;
}
