import { Logger } from '../utils/Logger';
import type {
    AuthConfig, AuthLinkConfig, AuthProvider, ExternalIdentity, RapiddUser, ResolveUserHelpers, RoleMappingConfig,
} from '../types';

/** The slice of Auth the resolver needs */
export interface UserTableSource {
    getUserModel(): any | null;
    buildUserQuery(includePassword: boolean): Record<string, unknown>;
    sanitizeUser(user: Record<string, unknown> | null): RapiddUser | null;
}

export interface ResolvedUser {
    user: RapiddUser;
    /** True when the user is a user-table row (re-loaded from the database on refresh) */
    persisted: boolean;
}

const DEFAULT_LINK: AuthLinkConfig = { field: 'email', from: 'email' };

/** AUTH_LINK: 'email' | 'username' | 'subject' | '<userField>:<identityAttribute>' | 'false' */
export function linkFromEnv(value = process.env.AUTH_LINK): AuthLinkConfig | false | undefined {
    const v = value?.trim();
    if (!v) return undefined;
    if (['false', 'none', 'off'].includes(v.toLowerCase())) return false;
    const [field, from] = v.split(':').map((s) => s.trim());
    return { field, from: from || field };
}

/** AUTH_ROLE_MAP (JSON object) + AUTH_DEFAULT_ROLE */
export function rolesFromEnv(env: NodeJS.ProcessEnv = process.env): RoleMappingConfig | undefined {
    if (!env.AUTH_ROLE_MAP && !env.AUTH_DEFAULT_ROLE) return undefined;
    let map: Record<string, string> | undefined;
    if (env.AUTH_ROLE_MAP) {
        try {
            map = JSON.parse(env.AUTH_ROLE_MAP);
        } catch {
            throw new Error('[Auth] AUTH_ROLE_MAP must be a JSON object, e.g. {"Domain Admins":"admin","Staff":"staff"}');
        }
        if (!map || typeof map !== 'object' || Array.isArray(map)) {
            throw new Error('[Auth] AUTH_ROLE_MAP must be a JSON object');
        }
    }
    return { map, default: env.AUTH_DEFAULT_ROLE || null };
}

/**
 * Maps identities asserted by providers (LDAP, OIDC, WebDAV, ...) to application users.
 *
 * Resolution order:
 * 1. Providers that already return an app user (local) — used as is.
 * 2. `resolveUser` from the auth config — full control.
 * 3. A user table exists and linking is on → the row whose `link.field` equals the
 *    identity's `link.from`; `provision` may create it on first login.
 * 4. Otherwise a claims-only user: { id: subject, role: mapped role, email, name, ... }.
 */
export class IdentityResolver {
    private readonly source: UserTableSource;
    private readonly config: AuthConfig;
    private readonly caseInsensitiveEmail: boolean;

    constructor(source: UserTableSource, config: AuthConfig, options: { caseInsensitiveEmail?: boolean } = {}) {
        this.source = source;
        this.config = config;
        this.caseInsensitiveEmail = !!options.caseInsensitiveEmail;
    }

    linkFor(provider?: AuthProvider): AuthLinkConfig | false {
        return provider?.link ?? this.config.link ?? DEFAULT_LINK;
    }

    /**
     * Map the identity's groups/roles to an app role. Keys match EXACTLY (LDAP DNs
     * case-insensitively) — a bare name like "admin" must not be satisfiable by some
     * same-named group a user created. `group:<id>` / `role:<name>` restrict a key to
     * one source; unprefixed keys match either.
     */
    mapRole(identity: ExternalIdentity, provider?: AuthProvider): string | null {
        const roles = provider?.roles ?? this.config.roles;
        if (!roles) return null;
        const groups = new Set(identity.groups.map(normalizeName));
        const idpRoles = new Set(identity.roles.map(normalizeName));
        for (const [external, role] of Object.entries(roles.map || {})) {
            if (external.startsWith('group:')) {
                if (groups.has(normalizeName(external.slice(6)))) return role;
            } else if (external.startsWith('role:')) {
                if (idpRoles.has(normalizeName(external.slice(5)))) return role;
            } else if (groups.has(normalizeName(external)) || idpRoles.has(normalizeName(external))) {
                return role;
            }
        }
        return roles.default ?? null;
    }

    helpers(provider?: AuthProvider): ResolveUserHelpers {
        return {
            findUser: async (where) => {
                const User = this.source.getUserModel();
                if (!User) return null;
                const row = await User.findFirst({ where, ...this.source.buildUserQuery(false) });
                return this.source.sanitizeUser(row);
            },
            createUser: async (data) => {
                const User = this.source.getUserModel();
                if (!User) throw new Error('[Auth] createUser: no user table');
                const row = await User.create({ data, ...this.source.buildUserQuery(false) });
                return this.source.sanitizeUser(row)!;
            },
            mapRole: (identity) => this.mapRole(identity, provider),
        };
    }

    async resolve(identity: ExternalIdentity, provider?: AuthProvider): Promise<ResolvedUser | null> {
        if (identity.user) return { user: identity.user, persisted: true };

        if (this.config.resolveUser) {
            const user = await this.config.resolveUser(identity, this.helpers(provider));
            return user ? { user, persisted: false } : null;
        }

        const User = this.source.getUserModel();
        const link = this.linkFor(provider);
        if (User && link !== false) {
            return this.resolveLinked(User, identity, link);
        }

        return {
            user: {
                // Namespaced by provider: subjects are only unique per IdP, and a bare "1" (e.g. a
                // GitHub id) would collide with real user-table ids in ACL filters or RLS
                id: `${identity.provider}:${identity.subject}`,
                role: this.mapRole(identity, provider),
                ...(identity.email ? { email: identity.email } : {}),
                ...(identity.name ? { name: identity.name } : {}),
                ...(identity.username ? { username: identity.username } : {}),
                groups: identity.groups,
                provider: identity.provider,
            },
            persisted: false,
        };
    }

    private async resolveLinked(User: any, identity: ExternalIdentity, link: AuthLinkConfig): Promise<ResolvedUser | null> {
        const value = identityValue(identity, link.from);
        if (value === undefined) {
            Logger.warn(`Auth: ${identity.provider} identity has no "${link.from}" to link a user by — login rejected`, { subject: identity.subject });
            return null;
        }

        // The database only PROPOSES candidates. On PostgreSQL `mode: insensitive` compiles to an
        // unescaped ILIKE (so `_`/`%` in an IdP-supplied address are wildcards), and MySQL
        // collations ignore accents and trailing spaces — either would let one identity link to
        // another person's account. The match itself is decided below, exactly.
        const where = link.from === 'email' && this.caseInsensitiveEmail
            ? { [link.field]: { equals: value, mode: 'insensitive' } }
            : { [link.field]: value };
        const query = this.source.buildUserQuery(false);
        if (query.select) (query.select as Record<string, boolean>)[link.field] = true;

        const find = async (): Promise<Record<string, unknown>[]> => {
            const candidates: Record<string, unknown>[] = await User.findMany({ where, take: 20, ...query });
            return candidates.filter((row) => sameValue(row[link.field], value));
        };

        let rows = await find();
        if (rows.length === 0 && this.config.provision) {
            const data = await this.config.provision(identity);
            if (!data) return null;
            try {
                rows = [await User.create({ data, ...query })];
            } catch (err) {
                // Two first logins racing: the other one created the row
                if ((err as { code?: string }).code !== 'P2002') throw err;
                rows = await find();
            }
        }

        if (rows.length > 1) {
            Logger.warn(`Auth: ${identity.provider} identity matches several users by "${link.field}" — login rejected as ambiguous`);
            return null;
        }
        if (rows.length === 0) {
            Logger.log(`Auth: no user linked to ${identity.provider} identity — login rejected`, { [link.from]: value });
            return null;
        }
        return { user: this.source.sanitizeUser(rows[0])!, persisted: true };
    }
}

/** Exact match, ignoring (ASCII/Unicode) letter case only — no wildcards, accents or padding */
function sameValue(stored: unknown, value: string): boolean {
    if (typeof stored === 'number' || typeof stored === 'bigint') return String(stored) === value;
    return typeof stored === 'string' && stored.toLowerCase() === value.toLowerCase();
}

const DN_LIKE = /^[A-Za-z][\w-]*\s*=/;

/** LDAP DNs compare case-insensitively and ignore spaces around RDN separators; anything else is exact */
function normalizeName(value: string): string {
    if (!DN_LIKE.test(value)) return value;
    return value.split(/(?<!\\),/).map((rdn) => rdn.trim().replace(/\s*=\s*/, '=')).join(',').toLowerCase();
}

/** Read an attribute of the identity: a well-known field or a raw claim name */
function identityValue(identity: ExternalIdentity, from: string): string | undefined {
    const known: Record<string, unknown> = {
        email: identity.email,
        username: identity.username,
        subject: identity.subject,
        name: identity.name,
    };
    const value = from in known ? known[from] : identity.claims[from];
    if (typeof value === 'number') return String(value);
    return typeof value === 'string' && value !== '' ? value : undefined;
}
