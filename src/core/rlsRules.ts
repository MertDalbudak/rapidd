import fs from 'fs';
import path from 'path';
import type { RlsContextFn, RLSVariables } from '../types';

/**
 * Declarative row-level security variables: config/rls.json, edited in the setup wizard.
 *
 *   { "variables": { "current_user_id": "user.id", "current_tenant_id": "header.x-tenant-id" } }
 *
 * Before every query, each variable is set as the SQL session variable `app.<name>` (see
 * RLS_NAMESPACE) from the signed-in user (`user.<attribute>`) or a request header
 * (`header.<name>`); a missing value is not set. PostgreSQL policies read them with
 * current_setting('app.current_user_id', true). src/config/rls.ts uses this unless it
 * defines its own function.
 */

export interface RlsRules {
    variables: Record<string, string>;
}

export const RLS_RULES_FILE = path.join('config', 'rls.json');

/** Marks the context function built from config/rls.json (anything else is code) */
export const FROM_CONFIG = Symbol.for('rapidd.rls.fromConfig');

export class RlsRulesError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RlsRulesError';
    }
}

const VARIABLE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SOURCE = /^(user\.[A-Za-z_][\w.]*|header\.[A-Za-z0-9-]+)$/;

export function validateRlsRules(rules: unknown): string[] {
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return ['must be a JSON object'];
    const variables = (rules as any).variables;
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return ['variables must be an object'];
    const problems: string[] = [];
    for (const [name, source] of Object.entries(variables)) {
        if (!VARIABLE.test(name)) problems.push(`${name}: letters, digits and _ only`);
        if (typeof source !== 'string' || !SOURCE.test(source)) problems.push(`${name}: "user.<attribute>" or "header.<name>"`);
    }
    return problems;
}

/** config/rls.json, or null when there is none */
export function loadRlsRules(file: string = path.join(process.cwd(), RLS_RULES_FILE)): RlsRules | null {
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err: any) {
        if (err?.code === 'ENOENT') return null;
        throw new RlsRulesError(`${file} cannot be read: ${err?.message || err}`);
    }
    let rules: unknown;
    try {
        rules = JSON.parse(text);
    } catch (err) {
        throw new RlsRulesError(`${file} is not valid JSON: ${(err as Error).message}`);
    }
    const problems = validateRlsRules(rules);
    if (problems.length > 0) throw new RlsRulesError(`${file}: ${problems.join('; ')}`);
    return rules as RlsRules;
}

function valueAt(source: string, request: any): string | number | null {
    const [kind, ...rest] = source.split('.');
    let value: any;
    if (kind === 'header') {
        value = request?.headers?.[rest.join('.').toLowerCase()];
        if (Array.isArray(value)) value = value[0];
    } else {
        value = request?.user;
        for (const part of rest) value = value == null ? undefined : value[part];
    }
    if (typeof value === 'string' || typeof value === 'number') return value;
    if (typeof value === 'bigint' || typeof value === 'boolean') return String(value);
    return null;
}

/** The RLS context function for these rules (default: config/rls.json) */
export function rlsFromConfig(rules: RlsRules | null = loadRlsRules()): RlsContextFn {
    const variables = Object.entries(rules?.variables ?? {});
    const context: RlsContextFn = (request) => {
        const out: RLSVariables = {};
        for (const [name, source] of variables) out[name] = valueAt(source, request);
        return out;
    };
    Object.defineProperty(context, FROM_CONFIG, { value: true });
    return context;
}

/** Was this context function built from config/rls.json (as opposed to written in code)? */
export function isConfigContext(fn: unknown): boolean {
    return typeof fn === 'function' && (fn as any)[FROM_CONFIG] === true;
}
