import fs from 'fs';
import { LocalProvider, LocalUserSource } from './LocalProvider';
import { LdapProvider, escapeFilterValue, escapeDnValue } from './LdapProvider';
import { WebdavProvider } from './WebdavProvider';
import { OidcProvider } from './OidcProvider';
import type {
    AuthProvider, AuthProviderConfig, LdapProviderConfig, OidcProviderConfig, WebdavProviderConfig,
} from '../../types';

const list = (value: string | undefined): string[] =>
    (value || '').split(',').map((s) => s.trim()).filter(Boolean);

const bool = (value: string | undefined, fallback: boolean): boolean =>
    value === undefined || value === '' ? fallback : value.toLowerCase() === 'true';

const int = (value: string | undefined): number | undefined =>
    value ? parseInt(value, 10) : undefined;

/** LDAP_* env vars → LDAP provider config */
export function ldapConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LdapProviderConfig {
    const tlsOptions: Record<string, unknown> = {};
    if (env.LDAP_TLS_REJECT_UNAUTHORIZED === 'false') tlsOptions.rejectUnauthorized = false;
    if (env.LDAP_TLS_CA_FILE) tlsOptions.ca = [fs.readFileSync(env.LDAP_TLS_CA_FILE)];

    return {
        type: 'ldap',
        url: list(env.LDAP_URL),
        bindTemplate: env.LDAP_BIND_TEMPLATE || undefined,
        bindDN: env.LDAP_BIND_DN || undefined,
        bindPassword: env.LDAP_BIND_PASSWORD || undefined,
        searchBase: env.LDAP_SEARCH_BASE || undefined,
        searchFilter: env.LDAP_SEARCH_FILTER || undefined,
        nestedGroups: bool(env.LDAP_NESTED_GROUPS, false),
        groupSearchBase: env.LDAP_GROUP_SEARCH_BASE || undefined,
        groupSearchFilter: env.LDAP_GROUP_SEARCH_FILTER || undefined,
        startTLS: bool(env.LDAP_STARTTLS, false),
        tlsOptions: Object.keys(tlsOptions).length ? tlsOptions : undefined,
        timeout: int(env.LDAP_TIMEOUT),
    };
}

/** OIDC_* env vars → OIDC provider config */
export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcProviderConfig {
    const audience = list(env.OIDC_AUDIENCE);
    return {
        type: 'oidc',
        issuer: env.OIDC_ISSUER || undefined,
        clientId: env.OIDC_CLIENT_ID || undefined,
        clientSecret: env.OIDC_CLIENT_SECRET || undefined,
        audience: audience.length > 1 ? audience : audience[0],
        scopes: env.OIDC_SCOPES ? env.OIDC_SCOPES.split(/[\s,]+/).filter(Boolean) : undefined,
        requiredScopes: env.OIDC_REQUIRED_SCOPES ? env.OIDC_REQUIRED_SCOPES.split(/[\s,]+/).filter(Boolean) : undefined,
        redirectUri: env.OIDC_REDIRECT_URI || undefined,
        acceptBearer: bool(env.OIDC_ACCEPT_BEARER, true),
        login: bool(env.OIDC_LOGIN, true),
        introspection: bool(env.OIDC_INTROSPECTION, false),
        subjectClaim: env.OIDC_SUBJECT_CLAIM || undefined,
    };
}

/** WEBDAV_* env vars → WebDAV provider config */
export function webdavConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebdavProviderConfig {
    return { type: 'webdav', url: env.WEBDAV_URL || '', timeout: int(env.WEBDAV_TIMEOUT) };
}

/** AUTH_PROVIDERS (default 'local') → provider configs, each fed from its env vars */
export function providerConfigsFromEnv(env: NodeJS.ProcessEnv = process.env): AuthProviderConfig[] {
    const names = list(env.AUTH_PROVIDERS);
    return (names.length ? names : ['local']).map((type) => {
        switch (type.toLowerCase()) {
            case 'local': return { type: 'local' };
            case 'ldap': return ldapConfigFromEnv(env);
            case 'oidc': return oidcConfigFromEnv(env);
            case 'webdav': return webdavConfigFromEnv(env);
            default:
                throw new Error(`[Auth] Unknown provider "${type}" in AUTH_PROVIDERS (expected local, ldap, oidc, webdav)`);
        }
    });
}

function isProviderInstance(entry: unknown): entry is AuthProvider {
    const e = entry as Record<string, unknown>;
    return typeof e?.name === 'string' && (
        typeof e.authenticate === 'function' || typeof e.verifyToken === 'function' || typeof e.beginLogin === 'function'
    );
}

/** Instantiate providers from configs (custom provider objects pass through unchanged). */
export function createProviders(
    entries: Array<AuthProviderConfig | AuthProvider>,
    localSource: LocalUserSource
): AuthProvider[] {
    const providers = entries.map((entry) => {
        if (isProviderInstance(entry)) return entry;
        const config = entry as AuthProviderConfig;
        switch (config.type) {
            case 'local': return new LocalProvider(localSource, config.name || 'local');
            case 'ldap': return new LdapProvider(config);
            case 'oidc': return new OidcProvider(config);
            case 'webdav': return new WebdavProvider(config);
            default:
                throw new Error(`[Auth] Unknown provider type "${(config as { type?: string }).type}"`);
        }
    });

    const seen = new Set<string>();
    for (const provider of providers) {
        if (seen.has(provider.name)) {
            throw new Error(`[Auth] Duplicate provider name "${provider.name}" — give each provider a unique name`);
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(provider.name)) {
            throw new Error(`[Auth] Provider name "${provider.name}" must only contain letters, digits, _ and - (it is used in URLs)`);
        }
        seen.add(provider.name);
    }
    return providers;
}

export { LocalProvider, LdapProvider, WebdavProvider, OidcProvider, escapeFilterValue, escapeDnValue };
