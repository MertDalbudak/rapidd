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

/**
 * The ACL in effect: the rules of config/acl.json for the models they list, and the entries
 * of src/config/acl.ts on top — a code entry takes its model over.
 */
export function mergeAclRules(code: AclConfig | null | undefined, rules: Record<string, ModelAcl>): AclConfig {
    return { ...(code ?? {}), model: { ...rules, ...(code?.model ?? {}) } };
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
            Logger.log(`ACL: ${missing.length} model(s) without an ACL entry are denied (ACL_DEFAULT=deny)`, { models: missing });
        } else {
            Logger.warn(`ACL: ${missing.length} model(s) have no ACL entry and are UNRESTRICTED for every authenticated user: ${missing.join(', ')}. Add access rules in the setup wizard (config/acl.json) or src/config/acl.ts, or set ACL_DEFAULT=deny.`);
        }
    }
    return missing;
}
