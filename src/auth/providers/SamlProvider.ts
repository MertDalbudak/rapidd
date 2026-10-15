import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ErrorResponse } from '../../core/errors';
import { Logger } from '../../utils/Logger';
import { parseIdpMetadata, pemCertificate, certificateBody, requireSaml } from './samlMetadata';
import type { IdpMetadata } from './samlMetadata';
import type { AuthProvider, AuthLinkConfig, AuthFlowState, ExternalIdentity, ISessionStore, SamlProviderConfig } from '../../types';

/** Where the setup wizard puts an uploaded metadata file */
export const DEFAULT_IDP_METADATA_FILE = 'config/saml-idp-metadata.xml';

const UNSPECIFIED = 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified';
const EMAIL_ADDRESS = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const METADATA_TTL_MS = 24 * 3600 * 1000;
const METADATA_RETRY_MS = 30 * 1000;
const METADATA_MAX_BYTES = 20 * 1024 * 1024;
/** As long as the login flow it belongs to */
const REQUEST_TTL_S = 600;

/**
 * Attribute names, first one present wins — plain names (Okta, Keycloak, Google), the claim URIs
 * of Entra ID and ADFS, and the LDAP attribute OIDs of Shibboleth / InCommon. Compared without case.
 */
const ATTRIBUTES: Record<'email' | 'name' | 'username' | 'groups' | 'roles' | 'givenName' | 'surname', string[]> = {
    email: ['email', 'mail', 'emailAddress', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'urn:oid:0.9.2342.19200300.100.1.3'],
    name: ['displayName', 'name', 'cn', 'http://schemas.microsoft.com/identity/claims/displayname', 'urn:oid:2.16.840.1.113730.3.1.241', 'urn:oid:2.5.4.3'],
    username: ['username', 'uid', 'preferred_username', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name', 'urn:oid:0.9.2342.19200300.100.1.1'],
    groups: ['groups', 'group', 'memberOf', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', 'http://schemas.xmlsoap.org/claims/Group', 'urn:oid:1.3.6.1.4.1.5923.1.5.1.1'],
    roles: ['roles', 'role', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'],
    givenName: ['givenName', 'firstName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'urn:oid:2.5.4.42'],
    surname: ['sn', 'surname', 'lastName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'urn:oid:2.5.4.4'],
};

/** The parts of node-saml's profile this provider reads */
interface SamlProfile {
    issuer?: string;
    nameID?: string;
    nameIDFormat?: string;
    sessionIndex?: string;
    inResponseTo?: string;
    attributes?: Record<string, unknown>;
    getAssertion?(): Record<string, any>;
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');

/** An attribute value as text — a plain value, or one xml2js wrapped with its XML attributes */
function text(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const inner = (value as { _?: unknown } | null)?._;
    return typeof inner === 'string' ? inner : null;
}

/**
 * The assertion's attributes, every value — read from the signed assertion itself: an IdP may
 * send one attribute several times (Keycloak's role list does), which node-saml's profile
 * collapses to the last
 */
export function samlAttributes(profile: SamlProfile): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    const add = (name: string, values: unknown[]) => {
        const list = values.map(text).filter((v): v is string => v !== null && v !== '');
        if (list.length) out[name] = [...(out[name] ?? []), ...list];
    };
    const statements = profile.getAssertion?.()?.Assertion?.AttributeStatement;
    if (Array.isArray(statements)) {
        for (const statement of statements) {
            for (const attribute of statement?.Attribute ?? []) {
                const name = attribute?.$?.Name;
                if (typeof name === 'string') add(name, attribute.AttributeValue ?? []);
            }
        }
        return out;
    }
    for (const [name, value] of Object.entries(profile.attributes ?? {})) add(name, Array.isArray(value) ? value : [value]);
    return out;
}

/** node-saml's request id cache in the session store — every instance sees it with Redis */
function requestCache(store: () => ISessionStore, provider: string) {
    const key = (id: string) => `saml:${provider}:${id}`;
    return {
        async saveAsync(id: string, value: string) {
            await store().create(key(id), { value }, { ttl: REQUEST_TTL_S });
            return { value, createdAt: Date.now() };
        },
        async getAsync(id: string) {
            const entry = await store().get(key(id));
            return entry ? String(entry.value) : null;
        },
        async removeAsync(id: string | null) {
            if (!id) return null;
            const s = store();
            const entry = s.take ? await s.take(key(id)) : await s.get(key(id));
            if (!s.take && entry) await s.delete(key(id));
            return entry ? String(entry.value) : null;
        },
    };
}

/** This API's entity id at the IdP: configured, else the metadata URL next to the callback */
export function samlEntityId(config: Pick<SamlProviderConfig, 'spEntityId'>, redirectUri: string): string {
    return config.spEntityId || redirectUri.replace(/\/callback$/, '/metadata');
}

/**
 * This API's metadata for the IdP: entity id, assertion consumer URL (HTTP-POST), NameID format
 * — and, with a private key, its certificate for signed requests and encrypted assertions
 */
export function samlServiceMetadata(config: Pick<SamlProviderConfig, 'spEntityId' | 'nameIdFormat' | 'privateKey' | 'cert'>, redirectUri: string): string {
    const { generateServiceProviderMetadata } = requireSaml();
    const privateKey = config.privateKey?.replace(/\\n/g, '\n');
    const cert = config.cert && privateKey ? config.cert.replace(/\\n/g, '\n') : null;
    return generateServiceProviderMetadata({
        issuer: samlEntityId(config, redirectUri),
        callbackUrl: redirectUri,
        identifierFormat: config.nameIdFormat || UNSPECIFIED,
        // Ask for signed assertions; a signed response is accepted too
        wantAssertionsSigned: true,
        ...(cert ? { publicCerts: cert, privateKey, decryptionCert: cert, decryptionPvk: privateKey } : {}),
    });
}

function isLoopback(url: string): boolean {
    try {
        return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
    } catch {
        return false;
    }
}

/**
 * SAML 2.0 single sign-on (Entra ID, ADFS, Okta, Keycloak, Shibboleth, Google Workspace, ...).
 *
 * The browser is sent to the identity provider with an authentication request (HTTP-Redirect
 * binding); the IdP answers with a form POST to the callback (HTTP-POST binding). The response
 * must carry a valid signature of the IdP — on the response or the assertion — and answer a
 * request this API sent, for this API (audience), from this IdP (issuer), within its validity
 * period. Each request id is accepted once.
 *
 * The IdP's metadata (entity id, sign-on URL, certificates) comes from a URL, refreshed daily,
 * or a file, read again when it changes. Nothing loads before first use, so an unreachable IdP
 * never keeps the API from starting.
 */
export class SamlProvider implements AuthProvider {
    readonly name: string;
    readonly type = 'saml';
    readonly link?: AuthLinkConfig | false;
    private readonly config: SamlProviderConfig;
    private readonly store: (() => ISessionStore) | null;
    private cached: { idp: IdpMetadata; loadedAt: number; mtime?: number } | null = null;
    private loading: Promise<IdpMetadata> | null = null;
    private failedAt = 0;

    constructor(config: SamlProviderConfig, options: { sessionStore?: () => ISessionStore } = {}) {
        this.config = config;
        this.name = config.name || 'saml';
        this.link = config.link;
        this.store = options.sessionStore ?? null;

        const explicit = !!(config.entryPoint && config.idpCert);
        if (!config.idpMetadata && !config.idpMetadataUrl && !explicit && !fs.existsSync(this.metadataFile)) {
            throw new Error(`[Auth] SAML provider "${this.name}" needs the identity provider's metadata — SAML_IDP_METADATA_URL, or the file ${this.metadataFile}`);
        }
        // The certificates come from it — fetched in the clear, anyone in between could replace them
        if (config.idpMetadataUrl && !/^https:\/\//i.test(config.idpMetadataUrl) && !isLoopback(config.idpMetadataUrl)) {
            throw new Error(`[Auth] SAML provider "${this.name}": the metadata URL must use https`);
        }
    }

    get loginEnabled(): boolean {
        return true;
    }

    /** Configured assertion consumer URL (otherwise the auth plugin derives one from PUBLIC_URL / the request) */
    get redirectUri(): string | undefined {
        return this.config.callbackUrl;
    }

    private get metadataFile(): string {
        return path.resolve(this.config.idpMetadataFile || DEFAULT_IDP_METADATA_FILE);
    }

    async initialize(): Promise<void> {
        try {
            await this.idp();
        } catch (err) {
            // Never block startup on the IdP — it is retried on demand
            Logger.warn(`Auth: SAML metadata of provider "${this.name}" not loaded — will retry on demand`, { error: (err as Error).message });
        }
    }

    // ── The identity provider's metadata ──────────────────────────────────────

    private fresh(cached: NonNullable<SamlProvider['cached']>): boolean {
        if (this.config.idpMetadata) return true;
        if (this.config.idpMetadataUrl) return Date.now() - cached.loadedAt < METADATA_TTL_MS;
        try {
            return fs.statSync(this.metadataFile).mtimeMs === cached.mtime;
        } catch {
            return true; // gone meanwhile — keep what was read
        }
    }

    private async readMetadata(): Promise<{ xml: string; mtime?: number }> {
        if (this.config.idpMetadata) return { xml: this.config.idpMetadata };
        if (this.config.idpMetadataUrl) {
            const response = await fetch(this.config.idpMetadataUrl, {
                headers: { Accept: 'application/samlmetadata+xml, application/xml, text/xml' },
                signal: AbortSignal.timeout(this.config.timeout ?? 5000),
            });
            if (!response.ok) throw new Error(`GET ${this.config.idpMetadataUrl} → ${response.status}`);
            const xml = await response.text();
            if (xml.length > METADATA_MAX_BYTES) throw new Error('the metadata is larger than 20 MB');
            return { xml };
        }
        const stat = fs.statSync(this.metadataFile);
        return { xml: fs.readFileSync(this.metadataFile, 'utf8'), mtime: stat.mtimeMs };
    }

    /** Entity id, sign-on URL and certificates of the IdP */
    async idp(): Promise<IdpMetadata> {
        const { entryPoint, idpCert } = this.config;
        if (entryPoint && idpCert) {
            return {
                entityId: this.config.idpIssuer ?? '', ssoUrl: entryPoint, ssoPostUrl: null,
                certificates: (Array.isArray(idpCert) ? idpCert : [idpCert]).map(certificateBody), nameIdFormats: [], wantAuthnRequestsSigned: false,
            };
        }
        const cached = this.cached;
        if (cached && this.fresh(cached)) return cached.idp;
        if (this.loading) return this.loading;
        if (!cached && this.failedAt > 0 && Date.now() - this.failedAt < METADATA_RETRY_MS) {
            throw new ErrorResponse(503, 'auth_provider_unavailable', { provider: this.name });
        }
        this.loading = (async () => {
            const { xml, mtime } = await this.readMetadata();
            const idp = parseIdpMetadata(xml, this.config.idpEntityId);
            if (!idp.ssoUrl) throw new Error('the identity provider offers no single sign-on endpoint for the HTTP-Redirect binding');
            this.cached = { idp, loadedAt: Date.now(), mtime };
            return idp;
        })();
        try {
            return await this.loading;
        } catch (err) {
            this.failedAt = Date.now();
            if (cached) {
                Logger.warn(`Auth: SAML metadata of provider "${this.name}" could not be refreshed — keeping the previous`, { error: (err as Error).message });
                cached.loadedAt = Date.now();
                return cached.idp;
            }
            Logger.error(`Auth: SAML metadata of provider "${this.name}" could not be loaded`, { error: (err as Error).message });
            throw new ErrorResponse(503, 'auth_provider_unavailable', { provider: this.name });
        } finally {
            this.loading = null;
        }
    }

    // ── node-saml ─────────────────────────────────────────────────────────────

    spEntityId(redirectUri: string): string {
        return samlEntityId(this.config, redirectUri);
    }

    private privateKey(): string | undefined {
        return this.config.privateKey?.replace(/\\n/g, '\n');
    }

    private async saml(redirectUri: string, requestId?: string): Promise<any> {
        const { SAML } = requireSaml();
        const idp = await this.idp();
        const privateKey = this.privateKey();
        return new SAML({
            entryPoint: idp.ssoUrl,
            idpCert: idp.certificates.map(pemCertificate),
            issuer: this.spEntityId(redirectUri),
            audience: this.spEntityId(redirectUri),
            callbackUrl: redirectUri,
            identifierFormat: this.config.nameIdFormat || UNSPECIFIED,
            // Asking for one way of signing in (node-saml: exactly a password) fails MFA and Kerberos at Entra ID and ADFS
            disableRequestedAuthnContext: true,
            // One valid signature — on the response or the assertion — is always required
            wantAssertionsSigned: this.config.wantAssertionsSigned ?? false,
            wantAuthnResponseSigned: this.config.wantResponseSigned ?? false,
            // Only answers to requests this API sent, each once
            validateInResponseTo: 'always',
            requestIdExpirationPeriodMs: REQUEST_TTL_S * 1000,
            ...(this.store ? { cacheProvider: requestCache(this.store, this.name) } : {}),
            acceptedClockSkewMs: (this.config.clockTolerance ?? 30) * 1000,
            signatureAlgorithm: 'sha256',
            ...(privateKey ? { privateKey, decryptionPvk: privateKey } : {}),
            ...(requestId ? { generateUniqueId: () => requestId } : {}),
        });
    }

    // ── Login ─────────────────────────────────────────────────────────────────

    async beginLogin({ redirectUri }: { redirectUri: string }): Promise<{ url: string; state: string; flow: AuthFlowState }> {
        const state = base64url(crypto.randomBytes(32));
        // An NCName: XML ids must not start with a digit
        const requestId = `_${crypto.randomBytes(20).toString('hex')}`;
        const saml = await this.saml(redirectUri, requestId);
        const url: string = await saml.getAuthorizeUrlAsync(state, undefined, {});
        return { url, state, flow: { requestId, redirectUri } };
    }

    async receivePost(body: Record<string, unknown>, { redirectUri }: { redirectUri: string }): Promise<{ state: string; data: Record<string, unknown> }> {
        const response = typeof body.SAMLResponse === 'string' ? body.SAMLResponse : '';
        const state = typeof body.RelayState === 'string' ? body.RelayState : '';
        // No RelayState: a login the IdP started (unsolicited) — not accepted
        if (!response || !state) throw new ErrorResponse(400, 'auth_login_failed', { provider: this.name });

        const saml = await this.saml(redirectUri);
        const idp = await this.idp();
        let profile: SamlProfile | null;
        try {
            ({ profile } = await saml.validatePostResponseAsync({ SAMLResponse: response }));
        } catch (err) {
            // The IdP's own status (sign-in cancelled or denied), or a response that fails validation
            Logger.warn(`Auth: SAML response rejected for provider "${this.name}"`, { error: (err as Error).message.split('\n')[0] });
            throw new ErrorResponse(401, 'auth_login_failed', { provider: this.name });
        }
        if (!profile?.nameID) throw new ErrorResponse(401, 'auth_login_failed', { provider: this.name });
        // node-saml checks the issuer of logout messages only
        if (idp.entityId && profile.issuer && profile.issuer !== idp.entityId) {
            Logger.warn(`Auth: SAML assertion from another issuer rejected for provider "${this.name}"`, { issuer: profile.issuer });
            throw new ErrorResponse(401, 'auth_login_failed', { provider: this.name });
        }
        return { state, data: { requestId: profile.inResponseTo ?? null, identity: this.toIdentity(profile) } };
    }

    async completeLogin(_query: Record<string, string | undefined>, flow: AuthFlowState, posted?: Record<string, unknown>): Promise<ExternalIdentity> {
        // The response must answer the request of the browser that began this login — not one an
        // attacker obtained for their own account and had the victim's browser post (login CSRF)
        if (!posted?.requestId || posted.requestId !== flow.requestId) {
            throw new ErrorResponse(401, 'auth_login_failed', { provider: this.name });
        }
        return posted.identity as ExternalIdentity;
    }

    async serviceMetadata({ redirectUri }: { redirectUri: string }): Promise<{ contentType: string; body: string }> {
        return { contentType: 'application/samlmetadata+xml', body: samlServiceMetadata(this.config, redirectUri) };
    }

    // ── Assertion → identity ──────────────────────────────────────────────────

    private toIdentity(profile: SamlProfile): ExternalIdentity {
        const attributes = samlAttributes(profile);
        const byName = new Map(Object.entries(attributes).map(([name, values]) => [name.toLowerCase(), values]));
        const values = (key: keyof typeof ATTRIBUTES): string[] => {
            const configured = key in (this.config.attributes ?? {}) ? (this.config.attributes as Record<string, string | undefined>)[key] : undefined;
            for (const name of configured ? [configured] : ATTRIBUTES[key]) {
                const found = byName.get(name.toLowerCase());
                if (found?.length) return found;
            }
            return [];
        };
        const one = (key: keyof typeof ATTRIBUTES) => values(key)[0];
        const name = one('name') ?? ([one('givenName'), one('surname')].filter(Boolean).join(' ') || undefined);
        return {
            provider: this.name,
            subject: profile.nameID!,
            username: one('username'),
            email: one('email') ?? (profile.nameIDFormat === EMAIL_ADDRESS ? profile.nameID : undefined),
            name,
            groups: [...new Set(values('groups'))],
            roles: [...new Set(values('roles'))],
            claims: {
                nameID: profile.nameID, nameIDFormat: profile.nameIDFormat ?? null, issuer: profile.issuer ?? null,
                sessionIndex: profile.sessionIndex ?? null, attributes,
            },
        };
    }
}
