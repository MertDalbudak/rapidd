import crypto, { KeyObject } from 'crypto';
import jwt from 'jsonwebtoken';
import { ErrorResponse } from '../../core/errors';
import { Logger } from '../../utils/Logger';
import type {
    AuthProvider, ExternalIdentity, OidcProviderConfig, AuthFlowState, AuthLinkConfig,
} from '../../types';

interface OidcMetadata {
    issuer?: string;
    authorization_endpoint?: string;
    token_endpoint?: string;
    userinfo_endpoint?: string;
    jwks_uri?: string;
    introspection_endpoint?: string;
    token_endpoint_auth_methods_supported?: string[];
}

interface TokenResponse {
    access_token?: string;
    id_token?: string;
    token_type?: string;
    error?: string;
}

/** Asymmetric algorithms only — HS* would let anyone holding the public JWKS forge tokens */
const DEFAULT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];
const JWKS_TTL_MS = 10 * 60 * 1000;
/** Minimum gap between JWKS refetches triggered by unknown key ids (stops kid-spraying DoS) */
const JWKS_COOLDOWN_MS = 30 * 1000;
const METADATA_RETRY_MS = 30 * 1000;
const INTROSPECTION_CACHE_TTL_MS = 60 * 1000;
const INTROSPECTION_CACHE_MAX = 10_000;

function base64url(buf: Buffer): string {
    return buf.toString('base64url');
}

function toList(value: unknown): string[] {
    if (value === undefined || value === null || value === '') return [];
    return Array.isArray(value) ? value.map(String) : [String(value)];
}

/** `scope` / `scp` claims are space-delimited strings (or arrays, e.g. Okta) */
function scopeList(value: unknown): string[] {
    return typeof value === 'string' ? value.split(' ').filter(Boolean) : toList(value);
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : (typeof value === 'number' ? String(value) : undefined);
}

/**
 * OpenID Connect / OAuth2 provider (Entra ID, Keycloak, Okta, Auth0, Google, ADFS, ...).
 *
 * - **Resource server**: accepts access tokens issued by the IdP as bearer tokens — signature
 *   checked against the IdP's JWKS, plus issuer, audience, expiry and (optionally) scopes.
 *   Opaque tokens can be validated through RFC 7662 introspection.
 * - **Redirect login**: authorization code flow with PKCE (S256), state and nonce; the
 *   id_token is fully validated before the identity is trusted.
 *
 * Everything is lazy: discovery and keys load on first use and are cached, so an IdP outage
 * at boot never prevents the API from starting.
 */
export class OidcProvider implements AuthProvider {
    readonly name: string;
    readonly type = 'oidc';
    readonly link?: AuthLinkConfig | false;
    private readonly config: OidcProviderConfig;
    private readonly algorithms: string[];
    private readonly audience: string[] | null;
    private readonly timeout: number;

    private metadata: OidcMetadata | null = null;
    private metadataPromise: Promise<OidcMetadata> | null = null;
    private metadataFailedAt = 0;
    private keys = new Map<string, KeyObject>();
    private keysFetchedAt = 0;
    private keysPromise: Promise<void> | null = null;
    private introspectionCache = new Map<string, { identity: ExternalIdentity | null; expiresAt: number }>();

    constructor(config: OidcProviderConfig) {
        this.config = config;
        this.name = config.name || 'oidc';
        this.link = config.link;
        this.algorithms = (config.algorithms || DEFAULT_ALGORITHMS).filter((a) => !/^(HS|none)/i.test(a));
        this.timeout = config.timeout ?? 5000;

        const audience = config.audience ?? config.clientId;
        this.audience = audience ? (Array.isArray(audience) ? audience : [audience]) : null;

        if (!config.issuer && !(config.endpoints?.authorization && config.endpoints?.token)) {
            throw new Error(`[Auth] OIDC provider "${this.name}" needs an issuer (or explicit authorization + token endpoints)`);
        }
        if (this.acceptsBearer && !this.audience) {
            Logger.warn(`Auth: OIDC provider "${this.name}" has no audience/clientId — bearer tokens from it will be rejected`);
        }
    }

    /** Whether bearer tokens from this IdP are accepted (requires an issuer and an expected audience) */
    private get acceptsBearer(): boolean {
        return this.config.acceptBearer !== false && !!this.config.issuer;
    }

    /** Whether the redirect login routes are enabled */
    get loginEnabled(): boolean {
        return !!this.config.clientId && this.config.login !== false;
    }

    /** Configured callback URL (otherwise the auth plugin derives one from PUBLIC_URL / the request) */
    get redirectUri(): string | undefined {
        return this.config.redirectUri;
    }

    async initialize(): Promise<void> {
        try {
            await this.getMetadata();
        } catch (err) {
            // Never block startup on the IdP — it is retried lazily on first use
            Logger.warn(`Auth: OIDC discovery failed for provider "${this.name}" — will retry on demand`, { error: (err as Error).message });
        }
    }

    // ── Metadata & keys ──────────────────────────────────────────────────────

    private async fetchJson(url: string, init: RequestInit = {}): Promise<any> {
        const response = await fetch(url, {
            ...init,
            headers: { Accept: 'application/json', ...(init.headers || {}) },
            signal: AbortSignal.timeout(this.timeout),
        });
        const text = await response.text();
        let body: any = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
        if (!response.ok) {
            const error = new Error(`${init.method || 'GET'} ${url} → ${response.status}${body?.error ? ` (${body.error})` : ''}`);
            (error as any).status = response.status;
            (error as any).body = body;
            throw error;
        }
        return body;
    }

    private async getMetadata(): Promise<OidcMetadata> {
        if (this.metadata) return this.metadata;
        if (this.metadataPromise) return this.metadataPromise;
        if (Date.now() - this.metadataFailedAt < METADATA_RETRY_MS && this.metadataFailedAt > 0) {
            throw new ErrorResponse(503, 'auth_provider_unavailable', { provider: this.name });
        }

        this.metadataPromise = (async () => {
            const { issuer, endpoints = {} } = this.config;
            let discovered: OidcMetadata = {};
            const needsDiscovery = issuer && !(endpoints.authorization && endpoints.token && endpoints.jwks);
            if (needsDiscovery) {
                discovered = await this.fetchJson(`${issuer!.replace(/\/$/, '')}/.well-known/openid-configuration`);
                // OIDC Discovery §4.3: the document's issuer MUST equal the configured issuer
                if (discovered.issuer !== issuer) {
                    throw new Error(`issuer mismatch: configured "${issuer}", discovery says "${discovered.issuer}"`);
                }
            }
            return {
                ...discovered,
                issuer: issuer ?? discovered.issuer,
                authorization_endpoint: endpoints.authorization ?? discovered.authorization_endpoint,
                token_endpoint: endpoints.token ?? discovered.token_endpoint,
                userinfo_endpoint: endpoints.userinfo ?? discovered.userinfo_endpoint,
                jwks_uri: endpoints.jwks ?? discovered.jwks_uri,
                introspection_endpoint: endpoints.introspection ?? discovered.introspection_endpoint,
            };
        })();

        try {
            this.metadata = await this.metadataPromise;
            return this.metadata;
        } catch (err) {
            this.metadataFailedAt = Date.now();
            Logger.error(`Auth: OIDC discovery failed for provider "${this.name}"`, { error: (err as Error).message });
            throw new ErrorResponse(503, 'auth_provider_unavailable', { provider: this.name });
        } finally {
            this.metadataPromise = null;
        }
    }

    private async loadKeys(): Promise<void> {
        if (this.keysPromise) return this.keysPromise;
        this.keysPromise = (async () => {
            const { jwks_uri } = await this.getMetadata();
            if (!jwks_uri) throw new Error('IdP publishes no jwks_uri');
            const jwks = await this.fetchJson(jwks_uri);
            const keys = new Map<string, KeyObject>();
            (jwks?.keys || []).forEach((jwk: Record<string, any>, index: number) => {
                if (jwk.use && jwk.use !== 'sig') return;
                if (jwk.kty !== 'RSA' && jwk.kty !== 'EC') return;
                try {
                    const key = (jwk.n || jwk.x)
                        ? crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' })
                        : new crypto.X509Certificate(`-----BEGIN CERTIFICATE-----\n${jwk.x5c?.[0]}\n-----END CERTIFICATE-----`).publicKey;
                    keys.set(jwk.kid ?? `#${index}`, key);
                } catch {
                    // Malformed key — skip it, the others may still verify
                }
            });
            this.keys = keys;
            this.keysFetchedAt = Date.now();
        })();
        try {
            await this.keysPromise;
        } catch (err) {
            Logger.error(`Auth: could not load signing keys for provider "${this.name}"`, { error: (err as Error).message });
            this.keysFetchedAt = Date.now(); // honour the cooldown on failures too
        } finally {
            this.keysPromise = null;
        }
    }

    private async candidateKeys(kid: string | undefined, alg: string): Promise<KeyObject[]> {
        if (this.keysFetchedAt === 0 || Date.now() - this.keysFetchedAt > JWKS_TTL_MS) {
            await this.loadKeys();
        }
        const pick = (): KeyObject[] => {
            if (kid) {
                const key = this.keys.get(kid);
                return key ? [key] : [];
            }
            const kty = alg.startsWith('ES') ? 'ec' : 'rsa';
            return [...this.keys.values()].filter((k) => k.asymmetricKeyType === kty);
        };
        let keys = pick();
        // Unknown kid → the IdP may have rotated its keys; refetch (rate-limited)
        if (keys.length === 0 && Date.now() - this.keysFetchedAt > JWKS_COOLDOWN_MS) {
            await this.loadKeys();
            keys = pick();
        }
        return keys;
    }

    /**
     * Verify a JWT issued by this IdP. Returns its claims, or null if anything is off.
     * `audience` null skips the audience check — only for tokens received directly from the
     * token endpoint in our own code exchange.
     */
    private async verifyJwt(token: string, audience: string[] | null): Promise<jwt.JwtPayload | null> {
        const decoded = jwt.decode(token, { complete: true });
        if (!decoded || typeof decoded.payload === 'string') return null;
        const { alg, kid } = decoded.header;
        if (!this.algorithms.includes(alg)) return null;

        for (const key of await this.candidateKeys(kid, alg)) {
            try {
                return jwt.verify(token, key, {
                    algorithms: [alg as jwt.Algorithm],
                    issuer: this.config.issuer,
                    ...(audience ? { audience: audience as [string, ...string[]] } : {}),
                    clockTolerance: this.config.clockTolerance ?? 30,
                }) as jwt.JwtPayload;
            } catch {
                // wrong key (no-kid case) or invalid token — try the next candidate
            }
        }
        return null;
    }

    // ── Resource server (bearer tokens) ──────────────────────────────────────

    ownsToken(_token: string, claims: Record<string, unknown> | null): boolean {
        if (!this.acceptsBearer) return false;
        if (claims) return claims.iss === this.config.issuer;
        return !!this.config.introspection;
    }

    async verifyToken(token: string): Promise<ExternalIdentity | null> {
        if (!this.acceptsBearer || !this.audience) return null;

        const looksLikeJwt = token.split('.').length === 3;
        if (!looksLikeJwt) {
            return this.config.introspection ? this.introspect(token) : null;
        }

        const claims = await this.verifyJwt(token, this.audience);
        if (!claims || !this.hasRequiredScopes(claims)) return null;
        // An id_token proves a login to a client app; it is not an access token for this API
        if (claims.typ === 'ID' || claims.token_use === 'id') return null;
        return this.toIdentity(claims);
    }

    private hasRequiredScopes(claims: Record<string, unknown>): boolean {
        const required = this.config.requiredScopes;
        if (!required?.length) return true;
        const granted = new Set([...scopeList(claims.scp), ...scopeList(claims.scope)]);
        return required.every((scope) => granted.has(scope));
    }

    private async introspect(token: string): Promise<ExternalIdentity | null> {
        const cacheKey = crypto.createHash('sha256').update(token).digest('base64url');
        const cached = this.introspectionCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.identity;

        const { introspection_endpoint } = await this.getMetadata();
        if (!introspection_endpoint || !this.config.clientId || !this.config.clientSecret) return null;

        let result: Record<string, unknown>;
        try {
            result = await this.fetchJson(introspection_endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Authorization: this.basicClientAuth(),
                },
                body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
            });
        } catch (err) {
            Logger.error(`Auth: token introspection failed for provider "${this.name}"`, { error: (err as Error).message });
            return null;
        }

        const now = Math.floor(Date.now() / 1000);
        const exp = typeof result.exp === 'number' ? result.exp : null;
        // Without `aud` a token could have been issued for ANY client of the IdP (confused
        // deputy) — then it must at least have been issued to one of our own clients
        const audienceOk = result.aud !== undefined
            ? toList(result.aud).some((a) => this.audience!.includes(a))
            : [result.client_id, result.azp].some((c) => typeof c === 'string' && this.audience!.includes(c));
        const valid = result.active === true
            && (exp === null || exp > now)
            && (result.iss === undefined || result.iss === this.config.issuer)
            && audienceOk
            && this.hasRequiredScopes(result);

        const identity = valid ? this.toIdentity(result) : null;
        const ttl = Math.min(INTROSPECTION_CACHE_TTL_MS, exp ? (exp - now) * 1000 : INTROSPECTION_CACHE_TTL_MS);
        if (ttl > 0) {
            if (this.introspectionCache.size >= INTROSPECTION_CACHE_MAX) {
                this.introspectionCache.delete(this.introspectionCache.keys().next().value!);
            }
            this.introspectionCache.set(cacheKey, { identity, expiresAt: Date.now() + ttl });
        }
        return identity;
    }

    // ── Redirect login (authorization code + PKCE) ───────────────────────────

    async beginLogin({ redirectUri }: { redirectUri: string }): Promise<{ url: string; state: string; flow: AuthFlowState }> {
        if (!this.loginEnabled) throw new ErrorResponse(404, 'auth_provider_not_found', { provider: this.name });
        const { authorization_endpoint } = await this.getMetadata();
        if (!authorization_endpoint) throw new ErrorResponse(503, 'auth_provider_unavailable', { provider: this.name });

        const state = base64url(crypto.randomBytes(32));
        const nonce = base64url(crypto.randomBytes(32));
        const verifier = base64url(crypto.randomBytes(32));
        const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());

        const url = new URL(authorization_endpoint);
        const params: Record<string, string> = {
            ...(this.config.authorizationParams || {}),
            response_type: 'code',
            client_id: this.config.clientId!,
            redirect_uri: redirectUri,
            scope: (this.config.scopes || ['openid', 'profile', 'email']).join(' '),
            state,
            nonce,
            code_challenge: challenge,
            code_challenge_method: 'S256',
        };
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

        return { url: url.toString(), state, flow: { nonce, verifier, redirectUri } };
    }

    async completeLogin(query: Record<string, string | undefined>, flow: AuthFlowState): Promise<ExternalIdentity> {
        if (query.error) {
            Logger.warn(`Auth: IdP returned an error for provider "${this.name}"`, { error: query.error, description: query.error_description });
            throw new ErrorResponse(401, 'auth_login_failed', { provider: this.name });
        }
        if (!query.code) throw new ErrorResponse(400, 'auth_login_failed', { provider: this.name });

        const metadata = await this.getMetadata();
        const tokens = await this.tokenRequest(metadata, {
            grant_type: 'authorization_code',
            code: query.code,
            redirect_uri: String(flow.redirectUri),
            code_verifier: String(flow.verifier),
        });

        let claims: Record<string, unknown> = {};
        if (tokens.id_token) {
            const idClaims = await this.verifyJwt(tokens.id_token, [this.config.clientId!]);
            if (!idClaims || idClaims.nonce !== flow.nonce) {
                Logger.warn(`Auth: id_token rejected for provider "${this.name}" (signature, issuer, audience, expiry or nonce)`);
                throw new ErrorResponse(401, 'auth_login_failed', { provider: this.name });
            }
            // Multiple audiences → the token must have been issued to us (OIDC Core §3.1.3.7)
            if (Array.isArray(idClaims.aud) && idClaims.aud.length > 1 && idClaims.azp !== this.config.clientId) {
                throw new ErrorResponse(401, 'auth_login_failed', { provider: this.name });
            }
            claims = idClaims;
        }

        if (metadata.userinfo_endpoint && tokens.access_token && (!tokens.id_token || this.config.userinfo)) {
            const info = await this.fetchJson(metadata.userinfo_endpoint, {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            }).catch((err) => {
                Logger.error(`Auth: userinfo request failed for provider "${this.name}"`, { error: (err as Error).message });
                throw new ErrorResponse(503, 'auth_provider_unavailable', { provider: this.name });
            });
            // OIDC Core §5.3.2: userinfo `sub` MUST match the id_token's
            if (claims.sub !== undefined && info?.sub !== claims.sub) {
                throw new ErrorResponse(401, 'auth_login_failed', { provider: this.name });
            }
            claims = { ...info, ...claims };
        } else if (!tokens.id_token) {
            // Neither an id_token nor a userinfo endpoint: nothing proves who logged in
            throw new ErrorResponse(401, 'auth_login_failed', { provider: this.name });
        }

        const identity = this.toIdentity(claims);
        if (!identity) throw new ErrorResponse(401, 'auth_login_failed', { provider: this.name });

        // Roles often live only in the ACCESS token (Keycloak realm roles, Entra app roles for
        // APIs). Merge them, or the same person would get different roles via SSO login than via
        // bearer tokens. Only a token that verifies against the IdP's keys, for the same subject,
        // counts; unverifiable ones (e.g. Entra tokens for Microsoft Graph) are simply skipped.
        if (tokens.access_token && tokens.access_token.split('.').length === 3) {
            const accessClaims = await this.verifyJwt(tokens.access_token, null);
            const access = accessClaims && accessClaims.sub === claims.sub ? this.toIdentity(accessClaims) : null;
            if (access) {
                identity.roles = [...new Set([...identity.roles, ...access.roles])];
                identity.groups = [...new Set([...identity.groups, ...access.groups])];
            }
        }
        return identity;
    }

    private basicClientAuth(): string {
        // RFC 6749 §2.3.1: client id and secret are form-urlencoded before base64
        const id = encodeURIComponent(this.config.clientId || '');
        const secret = encodeURIComponent(this.config.clientSecret || '');
        return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
    }

    private async tokenRequest(metadata: OidcMetadata, params: Record<string, string>): Promise<TokenResponse> {
        if (!metadata.token_endpoint) throw new ErrorResponse(503, 'auth_provider_unavailable', { provider: this.name });

        const body = new URLSearchParams(params);
        const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
        const methods = metadata.token_endpoint_auth_methods_supported;
        if (!this.config.clientSecret) {
            body.set('client_id', this.config.clientId!); // public client — PKCE carries the proof
        } else if (methods?.includes('client_secret_basic')) {
            headers.Authorization = this.basicClientAuth();
        } else {
            body.set('client_id', this.config.clientId!);
            body.set('client_secret', this.config.clientSecret);
        }

        try {
            return await this.fetchJson(metadata.token_endpoint, { method: 'POST', headers, body: body.toString() });
        } catch (err) {
            const status = (err as any).status;
            Logger.warn(`Auth: code exchange failed for provider "${this.name}"`, { error: (err as Error).message });
            // 4xx: bad/expired/replayed code — the login failed. Otherwise the IdP is down.
            throw status && status < 500
                ? new ErrorResponse(401, 'auth_login_failed', { provider: this.name })
                : new ErrorResponse(503, 'auth_provider_unavailable', { provider: this.name });
        }
    }

    // ── Claims → identity ────────────────────────────────────────────────────

    private toIdentity(claims: Record<string, any>): ExternalIdentity | null {
        const subject = str(claims[this.config.subjectClaim || 'sub']) ?? str(claims.sub) ?? str(claims.id);
        if (!subject) return null;

        const clientRoles = this.config.clientId ? claims.resource_access?.[this.config.clientId]?.roles : undefined;
        const name = str(claims.name)
            ?? ([claims.given_name, claims.family_name].filter((v) => typeof v === 'string').join(' ') || undefined);

        return {
            provider: this.name,
            subject,
            username: str(claims.preferred_username) ?? str(claims.upn) ?? str(claims.username) ?? str(claims.login),
            // An address the IdP explicitly marks unverified must not be used to link accounts
            email: claims.email_verified === false || claims.email_verified === 'false' ? undefined : str(claims.email),
            name,
            groups: toList(claims.groups),
            roles: [...new Set([...toList(claims.roles), ...toList(claims.realm_access?.roles), ...toList(clientRoles)])],
            claims,
        };
    }
}
