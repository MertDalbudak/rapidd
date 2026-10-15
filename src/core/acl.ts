import { getDMMFSync } from './dmmf';
import { Logger } from '../utils/Logger';
import type { AclConfig, ModelAcl } from '../types';

/** ACL applied to models without an entry when ACL_DEFAULT=deny: no create/read/update/delete */
export const DENY_ALL: ModelAcl = Object.freeze({
    canCreate: () => false,
    getAccessFilter: () => false,
    getUpdateFilter: () => false,
    getDeleteFilter: () => false,
});

const RAW_MODELS = Symbol('rapidd.acl.rawModels');

const reportedUndefined = new Set<string>();

/** An undefined value anywhere in a plain filter object */
function hasUndefined(value: unknown, depth = 0): boolean {
    if (value === undefined) return true;
    if (depth > 32 || !value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some((v) => hasUndefined(v, depth + 1));
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    return Object.values(value as Record<string, unknown>).some((v) => hasUndefined(v, depth + 1));
}

/**
 * A row filter returned by an ACL hook, made safe: a filter with an `undefined` value — usually
 * a user attribute that does not exist (`{ owner_id: user.uid }`) — denies. Prisma drops
 * undefined conditions, so the filter would otherwise match every row. Reported once per hook.
 */
export function guardAclFilter<T>(filter: T, model: string, hook: string): T | false {
    if (!filter || typeof filter !== 'object' || !hasUndefined(filter)) return filter;
    const at = `${model}.${hook}`;
    if (!reportedUndefined.has(at)) {
        reportedUndefined.add(at);
        Logger.error(`ACL: ${at} returned a filter with an undefined value — denied. It probably reads a user attribute that does not exist.`);
    }
    return false;
}

function isModelName(name: string): boolean {
    const dmmf = getDMMFSync();
    // Before the schema is loaded, treat any non-prototype key as a model (fail closed)
    if (!dmmf) return !(name in Object.prototype);
    return dmmf.datamodel.models.some((m) => m.name === name);
}

/**
 * Apply the ACL default policy. ACL_DEFAULT=allow (default) keeps Rapidd's historical
 * fail-open behavior: a model without an ACL entry is unrestricted. ACL_DEFAULT=deny makes
 * such models inaccessible to every user except the system user — new tables stay closed
 * until someone writes their ACL.
 */
export function applyAclDefault(acl: AclConfig, mode: string | undefined = process.env.ACL_DEFAULT): AclConfig {
    if (mode !== 'deny') return acl;
    const models = acl.model || {};
    const proxied = new Proxy(models, {
        get(target, prop, receiver) {
            if (prop === RAW_MODELS) return target;
            if (typeof prop === 'string' && !Object.prototype.hasOwnProperty.call(target, prop) && isModelName(prop)) {
                return DENY_ALL;
            }
            return Reflect.get(target, prop, receiver);
        },
    });
    return { ...acl, model: proxied };
}

/**
 * Log which models have no ACL entry — unrestricted (allow mode) or denied (deny mode).
 * Runs once at startup so an unprotected table is visible in the boot log, not in an audit.
 */
export function auditAcl(acl: AclConfig, mode: string | undefined = process.env.ACL_DEFAULT): string[] {
    const dmmf = getDMMFSync();
    if (!dmmf) return [];
    const configured = ((acl.model as any)?.[RAW_MODELS] ?? acl.model ?? {}) as Record<string, ModelAcl>;
    const missing = dmmf.datamodel.models
        .map((m) => m.name)
        .filter((name) => !Object.prototype.hasOwnProperty.call(configured, name));

    if (missing.length > 0) {
        if (mode === 'deny') {
            Logger.log(`ACL: ${missing.length} model(s) without an ACL entry are denied (ACL_DEFAULT=deny): ${missing.join(', ')}`);
        } else {
            // Sign-in off (AUTH_PROVIDERS=none): every request is the anonymous user
            const signInOff = (process.env.AUTH_PROVIDERS ?? '').split(',').some((name) => name.trim().toLowerCase() === 'none');
            Logger.warn(`ACL: ${missing.length} model(s) have no ACL entry and are UNRESTRICTED for ${signInOff ? 'every caller — sign-in is off' : 'every authenticated user'}: ${missing.join(', ')}. Add access control in src/config/acl.ts, or set ACL_DEFAULT=deny.`);
        }
    }
    return missing;
}
