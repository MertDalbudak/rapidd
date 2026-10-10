import { ErrorResponse } from '../../core/errors';
import { Logger } from '../../utils/Logger';
import type { AuthProvider, ExternalIdentity, LdapProviderConfig, AuthLinkConfig, RoleMappingConfig } from '../../types';

const DEFAULT_SEARCH_FILTER =
    '(|(sAMAccountName={{username}})(userPrincipalName={{username}})(uid={{username}})(mail={{username}}))';
const DEFAULT_GROUP_FILTER = '(|(member={{dn}})(uniqueMember={{dn}})(memberUid={{username}}))';
/** LDAP_MATCHING_RULE_IN_CHAIN — Active Directory's transitive membership match */
const AD_IN_CHAIN = '1.2.840.113556.1.4.1941';
const INVALID_CREDENTIALS = 49;

// ── Escaping ────────────────────────────────────────────────────────────────

/** Escape a value for use inside an LDAP search filter (RFC 4515). */
export function escapeFilterValue(value: string): string {
    return value.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/** Escape a value for use as an attribute value inside a DN (RFC 4514). */
export function escapeDnValue(value: string): string {
    let escaped = value.replace(/[\\,+"<>;=]/g, '\\$&').replace(/\0/g, '\\00');
    if (escaped.startsWith('#') || escaped.startsWith(' ')) escaped = '\\' + escaped;
    if (escaped.endsWith(' ') && !escaped.endsWith('\\ ')) escaped = escaped.slice(0, -1) + '\\ ';
    return escaped;
}

function fill(template: string, vars: Record<string, string>, escape: (v: string) => string): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
        vars[key] !== undefined ? escape(vars[key]) : match);
}

/** Active Directory objectGUID bytes → canonical GUID string (first three groups are little-endian). */
export function formatObjectGuid(buf: Buffer): string {
    if (buf.length !== 16) return buf.toString('hex');
    const h = (i: number) => buf[i].toString(16).padStart(2, '0');
    return `${h(3)}${h(2)}${h(1)}${h(0)}-${h(5)}${h(4)}-${h(7)}${h(6)}-${h(8)}${h(9)}-` +
        [10, 11, 12, 13, 14, 15].map(h).join('');
}

function first(value: unknown): string | undefined {
    if (Array.isArray(value)) value = value[0];
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    return typeof value === 'string' && value !== '' ? value : undefined;
}

function list(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    return (Array.isArray(value) ? value : [value]).map((v) => Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
}

/** ldapts reports LDAP result codes as numeric `code`; socket/timeout failures have none. */
function resultCode(err: unknown): number | null {
    const code = (err as { code?: unknown })?.code;
    return typeof code === 'number' ? code : null;
}

function loadLdapts(): any {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('ldapts');
    } catch {
        throw new Error('[Auth] The LDAP provider needs the "ldapts" package — run: npm install ldapts');
    }
}

// ── Provider ────────────────────────────────────────────────────────────────

/**
 * LDAP / Active Directory password provider.
 *
 * Two modes:
 * - **search-then-bind** (bindDN + searchBase): a service account finds the user — so people
 *   can log in with sAMAccountName, UPN, uid or email — then the user's own DN is bound
 *   with the password.
 * - **direct bind** (bindTemplate): the DN/UPN is built from the username; no service account.
 */
export class LdapProvider implements AuthProvider {
    readonly name: string;
    readonly type = 'ldap';
    readonly link?: AuthLinkConfig | false;
    readonly roles?: RoleMappingConfig;
    private readonly config: LdapProviderConfig;
    private readonly urls: string[];
    private readonly attributes: { username?: string; email: string; name?: string; groups: string };

    constructor(config: LdapProviderConfig) {
        this.config = config;
        this.name = config.name || 'ldap';
        this.link = config.link;
        this.roles = config.roles;
        this.urls = (Array.isArray(config.url) ? config.url : [config.url]).filter(Boolean);

        if (this.urls.length === 0) {
            throw new Error(`[Auth] LDAP provider "${this.name}" needs a url`);
        }
        if (!config.bindTemplate && !(config.bindDN && config.searchBase)) {
            throw new Error(`[Auth] LDAP provider "${this.name}" needs either bindTemplate (direct bind) or bindDN + searchBase (search-then-bind)`);
        }
        if (process.env.NODE_ENV === 'production'
            && this.urls.some((u) => u.startsWith('ldap://')) && !config.startTLS) {
            Logger.warn(`Auth: LDAP provider "${this.name}" sends passwords over plain ldap:// — use ldaps:// or startTLS`);
        }

        this.attributes = {
            username: config.attributes?.username,
            email: config.attributes?.email || 'mail',
            name: config.attributes?.name,
            groups: config.attributes?.groups || 'memberOf',
        };
    }

    async authenticate(username: string, password: string): Promise<ExternalIdentity | null> {
        // An empty password turns the bind into an anonymous ("unauthenticated") bind,
        // which most directories ACCEPT — it must never count as a login.
        if (typeof username !== 'string' || typeof password !== 'string') return null;
        if (!username.trim() || !password || username.includes('\0')) return null;

        return this.withClient(async (client) => {
            const { bindDN, bindPassword, bindTemplate, searchBase } = this.config;
            let entry: Record<string, unknown> | null;
            let groups: string[] | null = null;

            if (bindDN) {
                // Search-then-bind: groups are resolved with the service account BEFORE the
                // user bind, since the user may not be allowed to search group membership.
                try {
                    await client.bind(bindDN, bindPassword ?? '');
                } catch (err) {
                    // Socket/TLS failures propagate so withClient() fails over to the next server
                    if (resultCode(err) === null) throw err;
                    Logger.error(`Auth: LDAP service-account bind failed for provider "${this.name}"`, { error: (err as Error).message });
                    throw new ErrorResponse(503, 'auth_provider_unavailable', { provider: this.name });
                }
                entry = await this.findUser(client, username);
                if (!entry) return null;
                groups = await this.resolveGroups(client, entry, username);
                if (!await this.bindAs(client, entry.dn as string, password)) return null;
            } else {
                const dn = fill(bindTemplate!, { username }, bindTemplate!.includes('=') ? escapeDnValue : (v) => v);
                if (!await this.bindAs(client, dn, password)) return null;
                entry = await this.readOwnEntry(client, dn, username, searchBase);
                groups = await this.resolveGroups(client, entry, username);
            }

            return this.toIdentity(entry, groups, username);
        });
    }

    /**
     * Is the account behind this identity still usable? Checked at every token refresh, so
     * disabling or deleting a user in the directory ends their sessions. Needs the service
     * account (search-then-bind). Returns null when it cannot tell (no service account,
     * directory unreachable) — the session then continues until it expires.
     */
    async revalidate(identity: ExternalIdentity): Promise<boolean | null> {
        const dn = identity.claims.dn;
        const { bindDN, bindPassword } = this.config;
        if (typeof dn !== 'string' || !dn || !bindDN) return null;

        try {
            return await this.withClient(async (client) => {
                await client.bind(bindDN, bindPassword ?? '');
                let entry: Record<string, unknown> | undefined;
                try {
                    ({ searchEntries: [entry] } = await client.search(dn, {
                        scope: 'base', attributes: ['userAccountControl', 'nsAccountLock', 'pwdAccountLockedTime'],
                    }));
                } catch (err) {
                    if (resultCode(err) === 32) return false; // noSuchObject: deleted or moved
                    throw err;
                }
                if (!entry) return false;
                if ((Number(first(entry.userAccountControl)) & 2) === 2) return false; // AD: ACCOUNTDISABLE
                if (first(entry.nsAccountLock)?.toLowerCase() === 'true') return false; // 389-DS / FreeIPA
                if (first(entry.pwdAccountLockedTime)) return false; // OpenLDAP ppolicy lockout
                return true;
            });
        } catch (err) {
            Logger.warn(`Auth: could not re-check LDAP account — keeping the session`, { provider: this.name, error: (err as Error).message });
            return null;
        }
    }

    private async bindAs(client: any, dn: string, password: string): Promise<boolean> {
        try {
            await client.bind(dn, password);
            return true;
        } catch (err) {
            // AD answers 49 for wrong passwords AND disabled/locked/expired accounts — all
            // are reported as invalid credentials, so account state is not enumerable.
            if (resultCode(err) === INVALID_CREDENTIALS) return false;
            throw err;
        }
    }

    /**
     * After a successful direct bind, read the user's attributes. Directories commonly let
     * users read only their OWN entry ("by self read"), not search the tree — so a DN is read
     * with a base-scope search first. The password is already verified: failing to read
     * attributes must never fail the login, it only yields a leaner identity.
     */
    private async readOwnEntry(client: any, dn: string, username: string, searchBase?: string): Promise<Record<string, unknown>> {
        const options = { attributes: this.requestedAttributes(), explicitBufferAttributes: ['objectGUID'] };
        try {
            if (dn.includes('=')) {
                const { searchEntries } = await client.search(dn, { scope: 'base', ...options });
                if (searchEntries[0]) return searchEntries[0];
            }
        } catch {
            // not readable by its owner on this directory — try a search next
        }
        if (searchBase) {
            try {
                // A UPN bind proves the UPN, so look up exactly that — matching the typed name
                // against sAMAccountName/uid/mail could land on a different account
                const entry = dn.includes('=')
                    ? await this.findUser(client, username)
                    : await this.findUser(client, username, `(userPrincipalName=${escapeFilterValue(dn)})`);
                if (entry) return entry;
            } catch (err) {
                Logger.warn(`Auth: LDAP user attributes not readable after bind — continuing without them`, { provider: this.name, error: (err as Error).message });
            }
        }
        return { dn };
    }

    private async findUser(client: any, username: string, exactFilter?: string): Promise<Record<string, unknown> | null> {
        const filter = exactFilter ?? fill(this.config.searchFilter || DEFAULT_SEARCH_FILTER, { username }, escapeFilterValue);
        let entries: Record<string, unknown>[];
        try {
            ({ searchEntries: entries } = await client.search(this.config.searchBase, {
                scope: 'sub',
                filter,
                sizeLimit: 2,
                attributes: this.requestedAttributes(),
                explicitBufferAttributes: ['objectGUID'],
            }));
        } catch (err) {
            if (resultCode(err) !== 4) throw err;
            entries = [{}, {}]; // sizeLimitExceeded: more than one match
        }

        if (entries.length > 1) {
            // Never guess which account the password belongs to
            Logger.warn(`Auth: LDAP login matched several directory entries — rejected as ambiguous`, { provider: this.name });
            return null;
        }
        return entries[0] ?? null;
    }

    private requestedAttributes(): string[] {
        const attrs = new Set(['cn', 'uid', 'sAMAccountName', 'userPrincipalName', 'mail', 'displayName',
            'objectGUID', 'entryUUID', this.attributes.groups, this.attributes.email]);
        if (this.attributes.username) attrs.add(this.attributes.username);
        if (this.attributes.name) attrs.add(this.attributes.name);
        return [...attrs];
    }

    private async resolveGroups(client: any, entry: Record<string, unknown>, username: string): Promise<string[]> {
        const dn = entry.dn as string;
        const { nestedGroups, groupSearchBase, groupSearchFilter, searchBase } = this.config;

        let filter: string | null = null;
        if (nestedGroups) {
            filter = `(member:${AD_IN_CHAIN}:=${escapeFilterValue(dn)})`;
        } else if (groupSearchBase) {
            filter = fill(groupSearchFilter || DEFAULT_GROUP_FILTER, { dn, username }, escapeFilterValue);
        }

        // Full DNs, not bare CNs: "CN=Domain Admins" exists in every OU and trusted domain
        if (!filter) return list(entry[this.attributes.groups]);

        try {
            const { searchEntries } = await client.search(groupSearchBase || searchBase, {
                scope: 'sub', filter, attributes: ['cn'], paged: true,
            });
            return searchEntries.map((g: Record<string, unknown>) => g.dn as string);
        } catch (err) {
            Logger.warn(`Auth: LDAP group lookup failed — continuing without groups`, { provider: this.name, error: (err as Error).message });
            return list(entry[this.attributes.groups]);
        }
    }

    private toIdentity(entry: Record<string, unknown>, groups: string[] | null, login: string): ExternalIdentity {
        const guid = entry.objectGUID;
        const subject = Buffer.isBuffer(guid) ? formatObjectGuid(guid)
            : first(entry.entryUUID) || String(entry.dn).toLowerCase();

        const claims: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(entry)) {
            claims[key] = Buffer.isBuffer(value) ? (key === 'objectGUID' ? subject : value.toString('base64')) : value;
        }

        return {
            provider: this.name,
            subject,
            username: first(entry[this.attributes.username || 'sAMAccountName']) || first(entry.uid) || login,
            email: first(entry[this.attributes.email]),
            name: first(entry[this.attributes.name || 'displayName']) || first(entry.cn),
            groups: groups ?? [],
            roles: [],
            claims,
        };
    }

    /** Run an operation on a fresh connection, failing over across the configured URLs. */
    private async withClient<T>(fn: (client: any) => Promise<T>): Promise<T> {
        const { Client } = loadLdapts();
        const timeout = this.config.timeout ?? 5000;
        let lastError: unknown;

        for (const url of this.urls) {
            const client = new Client({ url, timeout, connectTimeout: timeout, tlsOptions: this.config.tlsOptions });
            try {
                if (this.config.startTLS && url.startsWith('ldap://')) {
                    await client.startTLS(this.config.tlsOptions);
                }
                return await fn(client);
            } catch (err) {
                if (err instanceof ErrorResponse) throw err;
                if (resultCode(err) !== null) {
                    // The server answered with an LDAP error (bad search base, insufficient
                    // access, unwilling to perform...): a configuration problem, not a wrong password
                    Logger.error(`Auth: LDAP operation failed for provider "${this.name}"`, { code: resultCode(err), error: (err as Error).message });
                    throw new ErrorResponse(503, 'auth_provider_unavailable', { provider: this.name });
                }
                lastError = err; // socket / TLS / timeout failure → next server
                Logger.warn(`Auth: LDAP server unreachable`, { provider: this.name, url, error: (err as Error).message });
            } finally {
                await client.unbind().catch(() => undefined);
            }
        }

        Logger.error(`Auth: no LDAP server reachable for provider "${this.name}"`, { error: (lastError as Error)?.message });
        throw new ErrorResponse(503, 'auth_provider_unavailable', { provider: this.name });
    }
}
