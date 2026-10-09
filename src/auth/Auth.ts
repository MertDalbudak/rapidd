import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { authPrisma, dbProvider } from '../core/prisma';
import { ErrorResponse } from '../core/errors';
import { createStore } from './stores';
import { loadDMMF, findUserModel, findIdentifierFields, findPasswordField, getPrimaryKey, getScalarFields } from '../core/dmmf';
import { Logger } from '../utils/Logger';
import { createProviders, providerConfigsFromEnv } from './providers';
import { IdentityResolver, linkFromEnv, rolesFromEnv } from './identity';
import type {
    RapiddUser, AuthOptions, AuthStrategy, ISessionStore, AuthConfig, AuthProvider,
    ExternalIdentity, AuthEventContext,
} from '../types';

/** Tokens issued by a login / refresh */
export interface LoginResult {
    user: RapiddUser;
    accessToken: string;
    refreshToken: string;
}

/** A replayed refresh token is tolerated this long after its rotation (concurrent tabs) */
const REFRESH_REUSE_GRACE_MS = 30 * 1000;
/** External bearer tokens: how long a validated token → user mapping is reused */
const TOKEN_CACHE_TTL_MS = 60 * 1000;
const TOKEN_CACHE_MAX = 10_000;
/** Redirect-login state and one-time login tickets */
const LOGIN_FLOW_TTL_S = 600;
const LOGIN_TICKET_TTL_S = 60;

const AUTH_CONFIG_KEYS = [
    'providers', 'link', 'roles', 'provision', 'resolveUser', 'loginRedirect', 'validateUser', 'onLogin',
] as const;

/**
 * Load src/config/auth.ts (optional). A missing file means "configure from env";
 * a file that fails to load must be loud — it may hold the only provider config.
 */
function loadAuthConfig(): AuthConfig {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('../config/auth');
        return (mod.default ?? mod) || {};
    } catch (err: any) {
        if (err?.code === 'MODULE_NOT_FOUND' && String(err.message).includes('config/auth')) return {};
        throw err;
    }
}

const refreshRecordKey = (sessionId: string) => `rt:${sessionId}`;
/** Per-user revocation cutoff: tokens issued before it are dead (see revokeUserSessions) */
const revocationKey = (userId: string | number) => `rvk:${userId}`;

interface RefreshRecord {
    jti: string;
    prev?: string;
    user: RapiddUser;
    provider: string;
    persisted: boolean;
    /** The external identity the session was opened with (re-validated / re-resolved at refresh) */
    identity?: ExternalIdentity;
    createdAt: number;
    rotatedAt: number;
}

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('base64url');
}

/** store.touch() with a fallback for custom stores written against the original interface */
async function touchEntry(store: ISessionStore, key: string): Promise<Record<string, unknown> | null> {
    if (typeof store.touch === 'function') return store.touch(key);
    const data = await store.get(key);
    if (data) await store.refresh(key);
    return data;
}

/** store.take() with a fallback for custom stores (not atomic there) */
async function takeEntry(store: ISessionStore, key: string): Promise<Record<string, unknown> | null> {
    if (typeof store.take === 'function') return store.take(key);
    const data = await store.get(key);
    if (data) await store.delete(key);
    return data;
}

/** Write only if the key still exists (false = it was deleted, e.g. revoked meanwhile) */
async function replaceEntry(store: ISessionStore, key: string, data: Record<string, unknown>, options: { ttl?: number; userId?: string | number | null }): Promise<boolean> {
    if (typeof store.replace === 'function') return store.replace(key, data, options);
    if (!await store.get(key)) return false;
    await store.create(key, data, options);
    return true;
}

/** Write only if the key does not exist yet (false = someone got there first) */
async function addEntry(store: ISessionStore, key: string, data: Record<string, unknown>, options: { ttl?: number; userId?: string | number | null }): Promise<boolean> {
    if (typeof store.add === 'function') return store.add(key, data, options);
    if (await store.get(key)) return false;
    await store.create(key, data, options);
    return true;
}

/** A jsonwebtoken `expiresIn` value ('7d', '15m', 3600) in seconds */
function ttlSeconds(expiresIn: string | number): number {
    const probe = jwt.decode(jwt.sign({}, 'probe', { expiresIn: expiresIn as any })) as jwt.JwtPayload;
    return Math.max(1, (probe.exp ?? 0) - (probe.iat ?? 0));
}

function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Authentication: identity providers, sessions and tokens.
 *
 * - **Providers** verify who a user is: the app's user table (`local`), LDAP / Active
 *   Directory, WebDAV, OpenID Connect / OAuth2 (bearer tokens and redirect login), or custom.
 * - **Identities** from external providers are mapped to app users (link, provision,
 *   claims, role mapping) — see IdentityResolver.
 * - **Sessions**: HS256 access/refresh JWTs bound to a server-side session (Redis or memory),
 *   with refresh-token rotation, reuse detection and per-user revocation.
 *
 * Auto-detects the user model, identifier fields and password field from the Prisma
 * schema. Without a user table and without external providers, auth is disabled.
 *
 * @example
 * const auth = new Auth();
 * await auth.initialize(); // Auto-detects config from DMMF
 * if (auth.isEnabled()) {
 *     const result = await auth.login(request.body);
 * }
 */
export class Auth {
    options: Required<Pick<AuthOptions, 'passwordField' | 'saltRounds'>> & AuthOptions & {
        identifierFields: string[];
        strategies: AuthStrategy[];
        cookieName: string;
        cookieDomain: string;
        cookieSameSite: 'strict' | 'lax' | 'none';
        cookieSecure: boolean;
        customHeaderName: string;
        session: { ttl: number; store?: string; maxAge: number };
        jwt: { secret?: string; refreshSecret?: string; accessExpiry: string; refreshExpiry: string };
    };

    /** Merged src/config/auth.ts + constructor options + env */
    readonly config: AuthConfig;

    private _userModel: any = null;
    private _sessionStore: ISessionStore | null = null;
    private _authDisabled = false;
    private _initPromise: Promise<void> | null = null;
    private _explicitIdentifierFields: boolean;
    private _explicitPasswordField: boolean;
    private _providers: AuthProvider[] | null = null;
    private _resolver: IdentityResolver | null = null;
    private _refreshTtl: number | null = null;
    private _tokenCache = new Map<string, { user: RapiddUser; expiresAt: number }>();

    constructor(options: AuthOptions = {}) {
        const envIdentifierFields = process.env.DB_USER_IDENTIFIER_FIELDS
            ?.split(',').map(s => s.trim()).filter(Boolean);

        this._explicitIdentifierFields = !!(
            (options.identifierFields && options.identifierFields.length > 0)
            || (envIdentifierFields && envIdentifierFields.length > 0)
        );
        this._explicitPasswordField = !!(options.passwordField || process.env.DB_USER_PASSWORD_FIELD);

        this.options = {
            ...options,
            userModel: options.userModel || process.env.DB_USER_TABLE,
            userSelect: options.userSelect || null,
            userInclude: options.userInclude || null,
            identifierFields: options.identifierFields || envIdentifierFields || ['email'],
            passwordField: options.passwordField || process.env.DB_USER_PASSWORD_FIELD || 'password',
            session: {
                ttl: parseInt(process.env.AUTH_SESSION_TTL || '86400', 10),
                maxAge: parseInt(process.env.AUTH_SESSION_MAX_AGE || '0', 10),
                ...options.session,
            },
            jwt: {
                secret: process.env.JWT_SECRET,
                refreshSecret: process.env.JWT_REFRESH_SECRET,
                accessExpiry: process.env.AUTH_ACCESS_TOKEN_EXPIRY || '1d',
                refreshExpiry: process.env.AUTH_REFRESH_TOKEN_EXPIRY || '7d',
                ...options.jwt,
            },
            saltRounds: options.saltRounds || parseInt(process.env.AUTH_SALT_ROUNDS || '10', 10),
            strategies: options.strategies
                || (process.env.AUTH_STRATEGIES?.split(',').map(s => s.trim()) as AuthStrategy[])
                || ['bearer'],
            cookieName: options.cookieName || process.env.AUTH_COOKIE_NAME || 'token',
            cookieDomain: options.cookieDomain || process.env.AUTH_COOKIE_DOMAIN || '',
            cookieSameSite: (options.cookieSameSite || process.env.AUTH_COOKIE_SAME_SITE || 'strict') as 'strict' | 'lax' | 'none',
            cookieSecure: options.cookieSecure ?? (process.env.AUTH_COOKIE_SECURE ? process.env.AUTH_COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production'),
            customHeaderName: options.customHeaderName || process.env.AUTH_CUSTOM_HEADER || 'X-Auth-Token',
        };

        // Config precedence: constructor options > src/config/auth.ts > env vars
        const config: AuthConfig = { ...loadAuthConfig() };
        for (const key of AUTH_CONFIG_KEYS) {
            if (options[key] !== undefined) (config as any)[key] = options[key];
        }
        if (config.link === undefined) {
            const envLink = linkFromEnv();
            if (envLink !== undefined) config.link = envLink;
        }
        config.roles ??= rolesFromEnv();
        config.loginRedirect ??= process.env.AUTH_LOGIN_REDIRECT || '/';
        this.config = config;

        // Bind methods for use as handlers
        this.login = this.login.bind(this);
        this.logout = this.logout.bind(this);
        this.refresh = this.refresh.bind(this);
        this.me = this.me.bind(this);
    }

    // ── Initialization ──────────────────────────────

    /**
     * Initialize auth by auto-detecting config from DMMF.
     * Must be called before using auth (the auth plugin calls this automatically).
     */
    async initialize(): Promise<void> {
        if (this._initPromise) return this._initPromise;

        this._initPromise = this._doInitialize();
        return this._initPromise;
    }

    private async _doInitialize(): Promise<void> {
        // Secrets first: they must be enforced even when schema auto-detection fails below
        this._ensureSecrets();

        try {
            await loadDMMF();
        } catch {
            Logger.warn('Auth: could not load DMMF, auto-detection skipped');
            return;
        }

        // Instantiate providers now so configuration errors surface at startup
        const providers = this.providers;
        const hasExternal = providers.some(p => p.type !== 'local');

        // Auto-detect user model from DMMF
        const userModel = findUserModel();
        if (!userModel && !this.options.userModel) {
            if (!hasExternal) {
                this._authDisabled = true;
                Logger.log('Auth: no user table detected, auth disabled');
                return;
            }
            Logger.log('Auth: no user table detected — external providers only, users come from identity claims');
        }

        const modelName = this.options.userModel || userModel?.name;

        if (modelName && !this.options.userModel) {
            this.options.userModel = modelName;
        }

        // Auto-detect identifier fields
        if (!this._explicitIdentifierFields && modelName) {
            const detected = findIdentifierFields(modelName);
            this.options.identifierFields = detected;
        }

        // Auto-detect password field
        if (!this._explicitPasswordField && modelName) {
            const detected = findPasswordField(modelName);
            if (detected) {
                this.options.passwordField = detected;
            }
        }

        this._warnOnBadLinkField(modelName);

        // Discovery, connectivity... providers never throw for transient outages
        await Promise.all(providers.map(async (provider) => {
            try {
                await provider.initialize?.();
            } catch (err) {
                Logger.warn(`Auth: provider "${provider.name}" failed to initialize`, { error: (err as Error).message });
            }
        }));
    }

    private _ensureSecrets(): void {
        // JWT secret handling: require explicit secrets in production
        if (!this.options.jwt.secret) {
            if (process.env.NODE_ENV === 'production') {
                throw new Error('[Auth] JWT_SECRET is required in production. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
            }
            this.options.jwt.secret = crypto.randomBytes(32).toString('hex');
            Logger.warn('Auth: no JWT_SECRET set, using auto-generated secret (sessions won\'t persist across restarts)');
        }
        if (!this.options.jwt.refreshSecret) {
            if (process.env.NODE_ENV === 'production') {
                throw new Error('[Auth] JWT_REFRESH_SECRET is required in production. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
            }
            this.options.jwt.refreshSecret = crypto.randomBytes(32).toString('hex');
        }
        if (process.env.NODE_ENV === 'production'
            && (this.options.jwt.secret.length < 32 || this.options.jwt.refreshSecret.length < 32)) {
            Logger.warn('Auth: JWT secrets shorter than 32 characters are brute-forceable — use 32+ random bytes');
        }
    }

    private _warnOnBadLinkField(modelName: string | undefined): void {
        if (!modelName || this.config.resolveUser) return;
        const links = [this.config.link, ...this.providers.map(p => p.link)]
            .filter((l): l is { field: string; from: string } => !!l && typeof l === 'object');
        try {
            const fields = getScalarFields(modelName);
            for (const link of links) {
                if (!fields[link.field]) {
                    Logger.warn(`Auth: link field "${link.field}" does not exist on user model "${modelName}" — external logins cannot be linked`);
                }
            }
        } catch {
            // DMMF helpers unavailable (tests / partial mocks)
        }
    }

    /**
     * Whether auth is enabled (user table found, or external providers configured)
     */
    isEnabled(): boolean {
        return !this._authDisabled;
    }

    // ── Providers ───────────────────────────────────

    /** Configured providers, in order (created on first access) */
    get providers(): AuthProvider[] {
        if (!this._providers) {
            this._providers = createProviders(this.config.providers ?? providerConfigsFromEnv(), this);
        }
        return this._providers;
    }

    getProvider(name: string): AuthProvider | undefined {
        return this.providers.find(p => p.name === name);
    }

    /** Public description of the enabled providers — lets login UIs render the right buttons */
    describeProviders(): Array<{ name: string; type: string; password: boolean; redirect: boolean }> {
        return this.providers.map(p => ({
            name: p.name,
            type: p.type,
            password: typeof p.authenticate === 'function',
            redirect: typeof p.beginLogin === 'function' && (p as { loginEnabled?: boolean }).loginEnabled !== false,
        }));
    }

    private get resolver(): IdentityResolver {
        if (!this._resolver) {
            this._resolver = new IdentityResolver(this, this.config, { caseInsensitiveEmail: dbProvider === 'postgresql' });
        }
        return this._resolver;
    }

    // ── User Model ──────────────────────────────────

    getUserModel(): any | null {
        if (this._userModel) return this._userModel;

        const modelName = this.options.userModel?.toLowerCase();
        const models = Object.keys(authPrisma).filter((k: string) => !k.startsWith('$') && !k.startsWith('_'));

        if (modelName) {
            const match = models.find((m: string) => m.toLowerCase() === modelName);
            if (match) {
                this._userModel = (authPrisma as any)[match];
                return this._userModel;
            }
            Logger.warn('Auth: userModel not found in Prisma models', { userModel: modelName });
        }

        for (const name of ['users', 'user', 'Users', 'User']) {
            if ((authPrisma as any)[name]) {
                this._userModel = (authPrisma as any)[name];
                return this._userModel;
            }
        }

        return null;
    }

    buildUserQuery(includePassword = false): Record<string, unknown> {
        const query: Record<string, unknown> = {};

        if (this.options.userSelect) {
            query.select = { ...this.options.userSelect };
            if (includePassword) {
                (query.select as Record<string, boolean>)[this.options.passwordField] = true;
            }
        } else if (this.options.userInclude) {
            query.include = { ...this.options.userInclude };
        }

        return query;
    }

    sanitizeUser(user: Record<string, unknown> | null): RapiddUser | null {
        if (!user) return null;
        const { [this.options.passwordField]: _, ...sanitized } = user;
        return sanitized as RapiddUser;
    }

    /** Re-read a user-table row (refresh) so role/status changes take effect. null if it is gone. */
    private async _reloadUser(user: RapiddUser): Promise<RapiddUser | null> {
        const User = this.getUserModel();
        if (!User) return user;

        let pk: string | string[] = 'id';
        try {
            pk = getPrimaryKey(this.options.userModel!) || 'id';
        } catch {
            // DMMF unavailable — fall back to the conventional 'id'
        }
        const fields = Array.isArray(pk) ? pk : [pk];
        const where = Object.fromEntries(fields.map((f) => [f, user[f] ?? (f === 'id' ? user.id : undefined)]));
        if (Object.values(where).some((v) => v === undefined || v === null)) return null;

        const row = await User.findFirst({ where, ...this.buildUserQuery(false) });
        return this.sanitizeUser(row);
    }

    // ── Session Store ───────────────────────────────

    getSessionStore(): ISessionStore {
        if (!this._sessionStore) {
            this._sessionStore = createStore({
                ttl: this.options.session.ttl,
                store: this.options.session.store,
                indexTtl: this.refreshTtlSeconds,
            });
        }
        return this._sessionStore;
    }

    setSessionStore(store: ISessionStore): void {
        this._sessionStore = store;
    }

    /** Lifetime of a refresh token in seconds (AUTH_REFRESH_TOKEN_EXPIRY, parsed the way jsonwebtoken does) */
    get refreshTtlSeconds(): number {
        if (this._refreshTtl === null) this._refreshTtl = ttlSeconds(this.options.jwt.refreshExpiry);
        return this._refreshTtl;
    }

    /** Lifetime of an access token in seconds (AUTH_ACCESS_TOKEN_EXPIRY) */
    get accessTtlSeconds(): number {
        return ttlSeconds(this.options.jwt.accessExpiry);
    }

    // ── JWT Helpers ─────────────────────────────────

    generateAccessToken(user: Record<string, unknown>, sessionId: string | null = null): string {
        if (!this.options.jwt.secret) {
            throw new Error('[Auth] JWT_SECRET is required');
        }

        const sanitizedUser = this.sanitizeUser(user);
        return jwt.sign(
            { sub: user.id, sessionId, user: sanitizedUser },
            this.options.jwt.secret,
            { algorithm: 'HS256', expiresIn: this.options.jwt.accessExpiry as any }
        );
    }

    /**
     * Sign a refresh token. Tokens issued by sessions carry `sid` (the session) and `jti`
     * (its position in the rotation chain); without them it is a legacy, unbound token.
     */
    generateRefreshToken(user: Record<string, unknown>, sessionId?: string, jti?: string): string {
        const secret = this.options.jwt.refreshSecret || this.options.jwt.secret;
        if (!secret) throw new Error('[Auth] JWT_SECRET is required');

        return jwt.sign(
            { sub: user.id, type: 'refresh', ...(sessionId ? { sid: sessionId, jti } : {}) },
            secret,
            { algorithm: 'HS256', expiresIn: this.options.jwt.refreshExpiry as any }
        );
    }

    verifyToken(token: string, isRefresh = false): any | null {
        try {
            const secret = isRefresh
                ? (this.options.jwt.refreshSecret || this.options.jwt.secret)
                : this.options.jwt.secret;
            if (!secret) return null;
            return jwt.verify(token, secret, { algorithms: ['HS256'] });
        } catch {
            return null;
        }
    }

    generateSessionId(): string {
        return crypto.randomUUID();
    }

    /**
     * The next jti in a session's rotation chain. Deterministic, so two concurrent refreshes
     * of the same token (e.g. two browser tabs) converge on the same successor instead of
     * forking the chain and tripping reuse detection.
     */
    private _nextJti(sessionId: string, jti: string): string {
        return crypto.createHmac('sha256', this.options.jwt.refreshSecret || this.options.jwt.secret!)
            .update(`${sessionId}:${jti}`).digest('base64url');
    }

    // ── Sessions ────────────────────────────────────

    /**
     * Create a server-side session for an authenticated user and issue its tokens.
     * `persisted` users (user-table rows) are re-read from the database on refresh.
     */
    async createSession(
        user: RapiddUser,
        context: { provider?: string; persisted?: boolean; identity?: ExternalIdentity } = {}
    ): Promise<LoginResult & { sessionId: string }> {
        const store = this.getSessionStore();
        const sessionId = this.generateSessionId();
        const jti = crypto.randomUUID();
        const now = Date.now();

        await store.create(sessionId, user as unknown as Record<string, unknown>, { userId: user.id });
        const { user: _resolved, ...identity } = context.identity ?? ({} as ExternalIdentity);
        const record: RefreshRecord = {
            jti,
            user,
            provider: context.provider ?? 'local',
            persisted: context.persisted ?? true,
            ...(context.identity && !context.identity.user ? { identity: identity as ExternalIdentity } : {}),
            createdAt: now,
            rotatedAt: now,
        };
        await store.create(refreshRecordKey(sessionId), record as unknown as Record<string, unknown>,
            { ttl: this._refreshRecordTtl(now), userId: user.id });

        return {
            user,
            sessionId,
            accessToken: this.generateAccessToken(user, sessionId),
            refreshToken: this.generateRefreshToken(user, sessionId, jti),
        };
    }

    private _refreshRecordTtl(createdAt: number): number {
        const maxAge = this.options.session.maxAge;
        if (!maxAge) return this.refreshTtlSeconds;
        const remaining = Math.ceil((createdAt + maxAge * 1000 - Date.now()) / 1000);
        return Math.max(1, Math.min(this.refreshTtlSeconds, remaining));
    }

    /** Revoke one session: its access session and its refresh chain */
    async revokeSession(sessionId: string): Promise<void> {
        if (!sessionId) return;
        const store = this.getSessionStore();
        await Promise.all([store.delete(sessionId), store.delete(refreshRecordKey(sessionId))]);
    }

    /**
     * Revoke every session of a user — on deactivation, password change, or "log out
     * everywhere". Returns the number of store entries removed.
     */
    async revokeUserSessions(userId: string | number): Promise<number> {
        const store = this.getSessionStore();
        if (typeof store.deleteByUser !== 'function') {
            throw new Error('[Auth] The session store does not support revoking sessions by user');
        }
        // Cutoff first: tokens that are not session-bound (legacy refresh tokens, tokens minted
        // without a session, IdP bearer tokens) die if they were issued before this moment
        await store.create(revocationKey(userId), { at: Date.now() },
            { ttl: Math.max(this.refreshTtlSeconds, this.accessTtlSeconds, 24 * 3600) });
        const removed = await store.deleteByUser(userId);
        // Cached external-token users may be the same person — drop them
        for (const [key, entry] of this._tokenCache) {
            if (String(entry.user.id) === String(userId)) this._tokenCache.delete(key);
        }
        return removed;
    }

    /** Was this user revoked (revokeUserSessions) at or after a token's issue time? */
    private async _revokedSince(userId: unknown, issuedAt: unknown): Promise<boolean> {
        if (userId === undefined || userId === null) return false;
        const record = await this.getSessionStore().get(revocationKey(userId as string | number)) as { at?: number } | null;
        if (!record?.at) return false;
        return typeof issuedAt !== 'number' || issuedAt * 1000 <= record.at;
    }

    // ── Authentication ──────────────────────────────

    private _passwordProviders(providerName?: string): AuthProvider[] {
        if (providerName) {
            const provider = this.getProvider(providerName);
            if (!provider?.authenticate) {
                throw new ErrorResponse(400, 'auth_provider_not_found', { provider: providerName });
            }
            return [provider];
        }
        return this.providers.filter(p => typeof p.authenticate === 'function');
    }

    /**
     * Verify username + password against the password providers, in order — the first that
     * accepts wins. Throws 401 invalid_credentials, or 503 when nobody accepted and at least
     * one provider was unreachable (so an LDAP outage isn't reported as a wrong password).
     */
    async authenticatePassword(
        identifier: string,
        password: string,
        providerName?: string
    ): Promise<{ identity: ExternalIdentity; provider: AuthProvider }> {
        let unavailable: unknown = null;
        for (const provider of this._passwordProviders(providerName)) {
            try {
                const identity = await provider.authenticate!(identifier, password);
                if (identity) return { identity, provider };
            } catch (err) {
                if (err instanceof ErrorResponse && err.status_code === 503) {
                    unavailable ??= err;
                    continue;
                }
                throw err;
            }
        }
        if (unavailable) throw unavailable;
        throw new ErrorResponse(401, 'invalid_credentials');
    }

    /** Map an external identity to an app user (null when it cannot be linked) */
    async resolveIdentity(identity: ExternalIdentity, provider?: AuthProvider): Promise<RapiddUser | null> {
        const resolved = await this.resolver.resolve(identity, provider ?? this.getProvider(identity.provider));
        return resolved?.user ?? null;
    }

    private async _validateUser(user: RapiddUser, context: AuthEventContext): Promise<void> {
        const hook = this.config.validateUser;
        if (!hook) return;
        if (await hook(user, context) === false) {
            throw new ErrorResponse(403, 'account_inactive');
        }
    }

    /** Resolve, gate and open a session for an identity a provider just authenticated */
    private async _completeLogin(identity: ExternalIdentity, provider: AuthProvider): Promise<LoginResult> {
        const resolved = await this.resolver.resolve(identity, provider);
        if (!resolved) {
            throw new ErrorResponse(401, 'account_not_linked', { provider: provider.name });
        }

        const context: AuthEventContext = { event: 'login', provider: provider.name, identity };
        await this._validateUser(resolved.user, context);

        const { user, accessToken, refreshToken } = await this.createSession(resolved.user, {
            provider: provider.name,
            persisted: resolved.persisted,
            identity,
        });

        if (this.config.onLogin) {
            try {
                await this.config.onLogin(user, context);
            } catch (err) {
                Logger.error(err as Error, { hook: 'onLogin' });
            }
        }
        return { user, accessToken, refreshToken };
    }

    /**
     * Authenticate a token from any transport (bearer header, cookie, custom header):
     * an access token issued by a configured external IdP, or a Rapidd session token.
     */
    async authenticateToken(token: string): Promise<{ user: RapiddUser; sessionId: string | null } | null> {
        if (!token) return null;

        const decoded = jwt.decode(token);
        const claims = decoded && typeof decoded === 'object' ? decoded as Record<string, unknown> : null;

        // Several providers may share an issuer (different audiences) — each gets its chance;
        // a token an IdP owns never falls through to session-token verification
        const owners = this.providers.filter(p => p.verifyToken && p.ownsToken?.(token, claims));
        if (owners.length > 0) {
            for (const owner of owners) {
                const user = await this._authenticateExternalToken(owner, token, claims);
                if (user) return { user, sessionId: null };
            }
            return null;
        }

        const verified = claims && this.verifyToken(token);
        // Refresh tokens are not access tokens — even when both secrets are the same
        if (!verified || verified.type === 'refresh') return null;

        if (verified.sessionId) {
            const session = await touchEntry(this.getSessionStore(), verified.sessionId);
            return session ? { user: session as unknown as RapiddUser, sessionId: verified.sessionId } : null;
        }

        // Session-less tokens (minted by app code) cannot be deleted — honour revocation cutoffs
        const subject = verified.user?.id ?? verified.sub;
        if (await this._revokedSince(subject, verified.iat)) return null;
        if (verified.user) return { user: verified.user, sessionId: null };
        if (verified.sub) return { user: { id: verified.sub, role: 'user' } as RapiddUser, sessionId: null };
        return null;
    }

    private async _authenticateExternalToken(
        provider: AuthProvider,
        token: string,
        claims: Record<string, unknown> | null
    ): Promise<RapiddUser | null> {
        const cacheKey = sha256(token);
        const cached = this._tokenCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return { ...cached.user };

        let identity: ExternalIdentity | null;
        try {
            identity = await provider.verifyToken!(token);
        } catch (err) {
            Logger.error(`Auth: token verification failed for provider "${provider.name}"`, { error: (err as Error).message });
            return null;
        }
        if (!identity) return null;

        const resolved = await this.resolver.resolve(identity, provider);
        if (!resolved) return null;
        try {
            await this._validateUser(resolved.user, { event: 'token', provider: provider.name, identity });
        } catch {
            return null;
        }
        // "Log out everywhere" also ends IdP tokens issued before it
        if (await this._revokedSince(resolved.user.id, claims?.iat)) return null;

        // Only successes are cached: a failure may be a transient IdP outage
        const exp = typeof claims?.exp === 'number' ? claims.exp * 1000 : Infinity;
        const ttl = Math.min(TOKEN_CACHE_TTL_MS, exp - Date.now());
        if (ttl > 0) {
            if (this._tokenCache.size >= TOKEN_CACHE_MAX) {
                this._tokenCache.delete(this._tokenCache.keys().next().value!);
            }
            this._tokenCache.set(cacheKey, { user: resolved.user, expiresAt: Date.now() + ttl });
        }
        return { ...resolved.user };
    }

    // ── Auth Handlers ───────────────────────────────

    async handleBasicAuth(credentials: string): Promise<RapiddUser | null> {
        try {
            const decoded = Buffer.from(credentials, 'base64').toString('utf-8');
            const colonIndex = decoded.indexOf(':');
            if (colonIndex === -1) return null;

            const identifier = decoded.substring(0, colonIndex);
            const password = decoded.substring(colonIndex + 1);
            if (!identifier || !password) return null;

            const { identity, provider } = await this.authenticatePassword(identifier, password);
            const resolved = await this.resolver.resolve(identity, provider);
            if (!resolved) return null;
            await this._validateUser(resolved.user, { event: 'token', provider: provider.name, identity });
            return resolved.user;
        } catch {
            return null;
        }
    }

    async handleBearerAuth(token: string): Promise<RapiddUser | null> {
        return (await this.authenticateToken(token))?.user ?? null;
    }

    async handleCookieAuth(cookieValue: string): Promise<RapiddUser | null> {
        if (!cookieValue) return null;
        return this.handleBearerAuth(cookieValue);
    }

    async handleCustomHeaderAuth(headerValue: string): Promise<RapiddUser | null> {
        if (!headerValue) return null;
        return this.handleBearerAuth(headerValue);
    }

    // ── Route Handlers (framework-agnostic) ─────────

    async login(body: { user: string; password: string; provider?: string }): Promise<LoginResult> {
        const { user: identifier, password, provider: providerName } = body || ({} as typeof body);

        if (!identifier || !password || typeof identifier !== 'string' || typeof password !== 'string') {
            throw new ErrorResponse(400, 'user_and_password_required');
        }

        const providers = this._passwordProviders(providerName);
        if (providers.every(p => p.type === 'local') && !this.getUserModel()) {
            throw new ErrorResponse(500, 'auth_not_configured');
        }

        const { identity, provider } = await this.authenticatePassword(identifier, password, providerName);
        return this._completeLogin(identity, provider);
    }

    async logout(authHeader: string | undefined): Promise<{ message: string }> {
        if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const decoded = this.verifyToken(token);
            if (decoded?.sessionId) {
                await this.revokeSession(decoded.sessionId);
            }
        }
        return { message: 'logged_out' };
    }

    /** Revoke the session a refresh token belongs to (logout for clients holding only that) */
    async revokeRefreshToken(refreshToken: string): Promise<void> {
        const decoded = this.verifyToken(refreshToken, true);
        if (decoded?.type === 'refresh' && decoded.sid) {
            await this.revokeSession(decoded.sid);
        }
    }

    async refresh(body: { refreshToken: string }): Promise<{
        accessToken: string;
        refreshToken: string;
    }> {
        const refreshToken = body?.refreshToken;

        if (!refreshToken) {
            throw new ErrorResponse(400, 'refresh_token_required');
        }

        const decoded = this.verifyToken(refreshToken, true);
        if (!decoded || decoded.type !== 'refresh') {
            throw new ErrorResponse(401, 'invalid_refresh_token');
        }

        if (!decoded.sid) return this._legacyRefresh(decoded, refreshToken);

        const sessionId: string = decoded.sid;
        const store = this.getSessionStore();
        const key = refreshRecordKey(sessionId);
        const record = await store.get(key) as RefreshRecord | null;

        if (!record) {
            throw new ErrorResponse(401, 'invalid_refresh_token');
        }

        if (record.jti !== decoded.jti) {
            const concurrent = record.prev === decoded.jti && Date.now() - record.rotatedAt < REFRESH_REUSE_GRACE_MS;
            if (!concurrent) {
                // An already-rotated token came back: it was stolen or leaked. Kill the session.
                await this.revokeSession(sessionId);
                Logger.warn('Auth: refresh token reuse detected — session revoked', { sessionId });
                throw new ErrorResponse(401, 'invalid_refresh_token');
            }
            // Concurrent refresh of the same token (two tabs): hand out the current pair
            return {
                accessToken: this.generateAccessToken(record.user, sessionId),
                refreshToken: this.generateRefreshToken(record.user, sessionId, record.jti),
            };
        }

        const maxAge = this.options.session.maxAge;
        if (maxAge && Date.now() - record.createdAt > maxAge * 1000) {
            await this.revokeSession(sessionId);
            throw new ErrorResponse(401, 'session_expired');
        }

        const provider = this.getProvider(record.provider);

        // Still a valid account at the source? (e.g. disabled in Active Directory)
        if (record.identity && provider?.revalidate) {
            if (await provider.revalidate(record.identity) === false) {
                await this.revokeSession(sessionId);
                throw new ErrorResponse(403, 'account_inactive');
            }
        }

        // A fresh user, so validateUser and the new tokens see current data
        let user: RapiddUser | null = record.user;
        if (record.persisted) {
            user = await this._reloadUser(record.user);
        } else if (record.identity) {
            user = (await this.resolver.resolve(record.identity, provider))?.user ?? null;
        }
        if (!user) {
            await this.revokeSession(sessionId);
            throw new ErrorResponse(401, 'user_not_found');
        }

        try {
            await this._validateUser(user, { event: 'refresh', provider: record.provider, identity: record.identity });
        } catch (err) {
            await this.revokeSession(sessionId);
            throw err;
        }

        const jti = this._nextJti(sessionId, record.jti);
        const next: RefreshRecord = { ...record, jti, prev: record.jti, rotatedAt: Date.now(), user };
        // Conditional write: a revocation that landed while we were busy must not be undone
        const ttl = this._refreshRecordTtl(record.createdAt);
        if (!await replaceEntry(store, key, next as unknown as Record<string, unknown>, { ttl, userId: user.id })) {
            throw new ErrorResponse(401, 'invalid_refresh_token');
        }
        // Recreate the access session with the fresh user snapshot (it may have idled out)
        await store.create(sessionId, user as unknown as Record<string, unknown>, { userId: user.id });
        // ...and if a revocation slipped in between the two writes, take the session back down
        const current = await store.get(key) as RefreshRecord | null;
        if (current?.jti !== jti) {
            await store.delete(sessionId);
            throw new ErrorResponse(401, 'invalid_refresh_token');
        }

        return {
            accessToken: this.generateAccessToken(user, sessionId),
            refreshToken: this.generateRefreshToken(user, sessionId, jti),
        };
    }

    /**
     * Refresh tokens issued before session binding (2.x): exchanged for a session-bound pair
     * exactly once, and dead when the user was revoked after they were issued.
     */
    private async _legacyRefresh(
        decoded: { sub: unknown; iat?: number; exp?: number },
        token: string
    ): Promise<{ accessToken: string; refreshToken: string }> {
        const User = this.getUserModel();
        if (!User) {
            throw new ErrorResponse(500, 'auth_not_configured');
        }

        const remaining = Math.max(1, (decoded.exp ?? 0) - Math.floor(Date.now() / 1000));
        const firstUse = await addEntry(this.getSessionStore(), `legacy:${sha256(token)}`, { at: Date.now() }, { ttl: remaining });
        if (!firstUse) {
            Logger.warn('Auth: legacy refresh token reused — rejected', { sub: decoded.sub });
            throw new ErrorResponse(401, 'invalid_refresh_token');
        }
        if (await this._revokedSince(decoded.sub, decoded.iat)) {
            throw new ErrorResponse(401, 'invalid_refresh_token');
        }

        const user = await this._reloadUser({ id: decoded.sub as string | number, role: null });
        if (!user) {
            throw new ErrorResponse(401, 'user_not_found');
        }
        await this._validateUser(user, { event: 'refresh', provider: 'local' });

        const { accessToken, refreshToken } = await this.createSession(user, { provider: 'local', persisted: true });
        return { accessToken, refreshToken };
    }

    async me(user: RapiddUser | null): Promise<{ user: RapiddUser }> {
        if (!user) {
            throw new ErrorResponse(401, 'not_authenticated');
        }
        return { user };
    }

    // ── Redirect Login (OAuth2 / OIDC) ──────────────

    /**
     * Start a redirect login: persists the flow state server-side (single use, 10 min) and
     * returns the IdP URL plus the `state` the caller must bind to the browser (cookie).
     */
    async beginRedirectLogin(
        providerName: string,
        options: { redirectUri: string; returnTo: string }
    ): Promise<{ url: string; state: string }> {
        const provider = this.getProvider(providerName);
        if (!provider?.beginLogin || !provider.completeLogin || (provider as { loginEnabled?: boolean }).loginEnabled === false) {
            throw new ErrorResponse(404, 'auth_provider_not_found', { provider: providerName });
        }
        const { url, state, flow } = await provider.beginLogin({ redirectUri: options.redirectUri });
        await this.getSessionStore().create(`flow:${state}`, {
            provider: provider.name, flow, returnTo: options.returnTo,
        }, { ttl: LOGIN_FLOW_TTL_S });
        return { url, state };
    }

    /**
     * Finish a redirect login. `browserState` is the state bound to the browser at
     * beginRedirectLogin — it must match the callback's (login-CSRF protection).
     */
    async completeRedirectLogin(
        providerName: string,
        query: Record<string, string | undefined>,
        browserState: string | undefined
    ): Promise<{ result: LoginResult; returnTo: string }> {
        const state = query.state;
        if (!state || !browserState || !safeEqual(state, browserState)) {
            throw new ErrorResponse(400, 'auth_login_failed', { provider: providerName });
        }

        const record = await takeEntry(this.getSessionStore(), `flow:${state}`) as
            { provider: string; flow: Record<string, unknown>; returnTo: string } | null;
        const provider = this.getProvider(providerName);
        if (!record || record.provider !== providerName || !provider?.completeLogin) {
            throw new ErrorResponse(400, 'auth_login_failed', { provider: providerName });
        }

        const identity = await provider.completeLogin(query, record.flow);
        const result = await this._completeLogin(identity, provider);
        return { result, returnTo: record.returnTo };
    }

    /** Park a login result behind a single-use ticket (60s) — redirect logins hand it to SPAs */
    async issueLoginTicket(result: LoginResult): Promise<string> {
        const ticket = crypto.randomBytes(32).toString('base64url');
        await this.getSessionStore().create(`ticket:${sha256(ticket)}`, result as unknown as Record<string, unknown>, { ttl: LOGIN_TICKET_TTL_S });
        return ticket;
    }

    async redeemLoginTicket(ticket: string): Promise<LoginResult> {
        if (!ticket || typeof ticket !== 'string') {
            throw new ErrorResponse(400, 'invalid_login_ticket');
        }
        const result = await takeEntry(this.getSessionStore(), `ticket:${sha256(ticket)}`);
        if (!result) throw new ErrorResponse(400, 'invalid_login_ticket');
        return result as unknown as LoginResult;
    }

    // ── Password Helpers ────────────────────────────

    async hashPassword(password: string): Promise<string> {
        return bcrypt.hash(password, this.options.saltRounds);
    }

    async comparePassword(password: string, hash: string): Promise<boolean> {
        return bcrypt.compare(password, hash);
    }

    // ── Lifecycle ───────────────────────────────────

    /** Close provider connections and the session store */
    async close(): Promise<void> {
        await Promise.all((this._providers || []).map((p) => p.close?.().catch(() => undefined)));
        await this._sessionStore?.destroy?.();
        this._tokenCache.clear();
    }
}

let _current: Auth | null = null;

/**
 * The Auth instance serving the most recently built app — for code outside a request
 * (model middleware, jobs): e.g. `getAuth()?.revokeUserSessions(user.id)` on deactivation.
 */
export function getAuth(): Auth | null {
    return _current;
}

/** @internal Called by the auth plugin */
export function setCurrentAuth(auth: Auth | null): void {
    _current = auth;
}
