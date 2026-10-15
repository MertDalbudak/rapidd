import type { RapiddUser } from '../types';
import { Logger } from '../utils/Logger';

/**
 * System-user marker.
 *
 * A module-private symbol — it cannot be set from JSON, a request body, or an auth
 * token, so a client can never forge a privileged (ACL-bypassing) user. The ONLY way
 * to obtain a system user is `createSystemUser()`, which the framework controls.
 *
 * This replaces the old `role === 'application'` convention, which was both a magic
 * string and forgeable (anything able to influence a user attribute could bypass ACL).
 */
const SYSTEM_USER = Symbol('rapidd.systemUser');

/**
 * Create a system user that bypasses ACL. Used by the framework as the fallback identity
 * for calls with no user, and available to apps for genuinely internal/privileged
 * operations (e.g. `new Users({ user: createSystemUser() })`).
 *
 * The system user is intentionally **identity-less**: `id` defaults to `null` rather than a
 * fabricated value (`'system'`) that might violate the user table's PK type. The bypass keys
 * off the symbol marker, so no attribute is ever consulted for a decision, validated, or
 * written to the database. Add attributes only for auditing/logging:
 * `createSystemUser({ id: 1, job: 'cron' })`.
 */
export function createSystemUser(overrides: Partial<RapiddUser> = {}): RapiddUser {
    // Spread overrides first so callers can set attributes, then stamp the (non-overridable) marker.
    return { id: null, ...overrides, [SYSTEM_USER]: true } as unknown as RapiddUser;
}

/**
 * True when the user is a framework system user (created via `createSystemUser`).
 * Non-forgeable: checks the private symbol, never a role string.
 */
export function isSystemUser(user: unknown): boolean {
    return user != null && typeof user === 'object' && (user as Record<PropertyKey, unknown>)[SYSTEM_USER] === true;
}

let _defaultUser: RapiddUser | null | undefined;

/**
 * Load the optional default user from `src/config/user.ts`.
 *
 * When present, its default export is used as the identity for requests without an
 * authenticated user (a real, ACL-enforced identity — unless the app exports a
 * `createSystemUser(...)` to make the default privileged). When absent, callers fall
 * back to the framework system user. Cached after first load (config is static).
 */
export function getDefaultUser(): RapiddUser | null {
    if (_defaultUser === undefined) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const mod = require('../config/user');
            const value = mod.default ?? mod.defaultUser ?? null;
            _defaultUser = value && typeof value === 'object' ? (value as RapiddUser) : null;
        } catch {
            _defaultUser = null;
        }

        // Surface the two config footguns loudly (once, at load):
        if (_defaultUser) {
            if (isSystemUser(_defaultUser)) {
                // A system-marked default means EVERY call without an explicit user bypasses ACL.
                Logger.warn('src/config/user.ts default user is a system user — all requests without an authenticated user will BYPASS ACL. This is only correct if intended.');
            } else if (_defaultUser.id == null) {
                // A non-system identity with a null id turns ownership filters like { ownerId: user.id }
                // into `ownerId IS NULL`, matching unowned rows. Almost always a misconfiguration.
                Logger.warn('src/config/user.ts default user has a null/undefined id — ownership ACL filters may match rows WHERE the column IS NULL. Set a real id or return null to use the system user.');
            }
        }
    }
    // Return a fresh shallow copy so per-request middleware can't mutate the cached identity
    // across requests. The system-user marker (an enumerable symbol) is preserved by the spread.
    return _defaultUser ? { ..._defaultUser } : null;
}

/**
 * The identity of every request while sign-in is off (AUTH_PROVIDERS=none): the default user
 * of `src/config/user.ts` when the app defines one, else `{ id: null }`. Not a system user —
 * src/config/acl.ts decides what it may do (ownership filters on `user.id` must not match
 * rows whose owner IS NULL).
 */
export function anonymousUser(): RapiddUser {
    return getDefaultUser() ?? ({ id: null } as RapiddUser);
}

/** Reset the cached default user (tests). */
export function resetDefaultUserCache(): void {
    _defaultUser = undefined;
}
