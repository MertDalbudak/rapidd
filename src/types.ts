import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// =====================================================
// USER & AUTH
// =====================================================

export interface RapiddUser {
    // id and role are null only for the framework system user (identity-less, bypasses ACL).
    // Real users — the only ones ACL callbacks ever receive — always have both.
    id: string | number | null;
    role: string | null;
    [key: string]: unknown;
}

export type AuthStrategy = 'bearer' | 'basic' | 'cookie' | 'header';

export interface RouteAuthConfig {
    strategies?: AuthStrategy[];
    cookieName?: string;
    customHeaderName?: string;
}

export interface AuthOptions extends AuthConfig {
    userModel?: string;
    userSelect?: Record<string, boolean> | null;
    userInclude?: Record<string, boolean | object> | null;
    identifierFields?: string[];
    passwordField?: string;
    session?: { ttl?: number; store?: string };
    jwt?: {
        secret?: string;
        refreshSecret?: string;
        accessExpiry?: string;
        refreshExpiry?: string;
    };
    saltRounds?: number;
    strategies?: AuthStrategy[];
    cookieName?: string;
    cookieDomain?: string;
    cookieSameSite?: 'strict' | 'lax' | 'none';
    cookieSecure?: boolean;
    customHeaderName?: string;
}

// =====================================================
// AUTH PROVIDERS (identity sources)
// =====================================================

/**
 * An identity asserted by an auth provider (LDAP, OIDC, WebDAV, ...) before it is
 * mapped to an application user. Providers produce it; the identity resolver turns it
 * into a RapiddUser (see AuthConfig.resolveUser / link / roles).
 */
export interface ExternalIdentity {
    /** Name of the provider instance that authenticated the user (e.g. 'ldap', 'entra') */
    provider: string;
    /** Stable unique id at the provider: OIDC sub/oid, LDAP objectGUID/entryUUID/DN, WebDAV username */
    subject: string;
    username?: string;
    email?: string;
    name?: string;
    /** Group memberships: LDAP group CNs, the OIDC `groups` claim */
    groups: string[];
    /** Roles asserted by the identity provider: OIDC `roles`, Keycloak realm/client roles */
    roles: string[];
    /** Raw claims / directory attributes as returned by the provider */
    claims: Record<string, unknown>;
    /** Set by providers that authenticate against the app's own user table — already resolved */
    user?: RapiddUser;
}

/** State a redirect provider persists between the login redirect and its callback */
export type AuthFlowState = Record<string, unknown>;

/**
 * An identity source. Implement any subset of the capabilities:
 * - `authenticate`: username + password (local DB, LDAP/AD, WebDAV, custom)
 * - `ownsToken` + `verifyToken`: bearer tokens issued by an external IdP (resource-server mode)
 * - `beginLogin` + `completeLogin`: browser redirect login (OAuth2 / OpenID Connect)
 */
export interface AuthProvider {
    /** Unique instance name — appears in routes (/auth/:name/login) and ExternalIdentity.provider */
    readonly name: string;
    /** Provider kind: 'local' | 'ldap' | 'webdav' | 'oidc' | a custom string */
    readonly type: string;
    /** Per-provider identity → user mapping, overriding AuthConfig.link / AuthConfig.roles */
    readonly link?: AuthLinkConfig | false;
    readonly roles?: RoleMappingConfig;
    /** Startup hook (discovery, connectivity). Must not throw on transient outages. */
    initialize?(): Promise<void>;
    /** Verify username + password. Resolve null for wrong credentials; throw when the provider is unreachable. */
    authenticate?(username: string, password: string): Promise<ExternalIdentity | null>;
    /** Cheap pre-check: does this bearer token belong to this provider? `claims` is null for opaque tokens. */
    ownsToken?(token: string, claims: Record<string, unknown> | null): boolean;
    /** Validate a bearer token issued by this provider. Resolve null when invalid. */
    verifyToken?(token: string): Promise<ExternalIdentity | null>;
    /** Start a redirect login: the URL to send the browser to, plus state to hand back to completeLogin */
    beginLogin?(options: { redirectUri: string }): Promise<{ url: string; state: string; flow: AuthFlowState }>;
    /** Finish a redirect login from the callback query parameters */
    completeLogin?(query: Record<string, string | undefined>, flow: AuthFlowState): Promise<ExternalIdentity>;
    /**
     * Re-check at token refresh that the identity's account still exists and is enabled
     * (e.g. disabled in Active Directory). false ends the session; null = cannot tell.
     */
    revalidate?(identity: ExternalIdentity): Promise<boolean | null>;
    /** Release connections / timers */
    close?(): Promise<void>;
}

/**
 * Link external identities to rows in the app's user table.
 * `field` is the user-table column, `from` the identity attribute it must equal
 * ('email' | 'username' | 'subject' | any claim name).
 */
export interface AuthLinkConfig {
    field: string;
    from: string;
}

/**
 * Derive a role from the identity's groups/roles (used when there is no user-table row
 * to take the role from, and offered to resolveUser/provision as `mapRole`).
 * `map` keys are IdP group/role names; the FIRST entry the identity holds wins, so list
 * the most privileged mapping first.
 */
export interface RoleMappingConfig {
    map?: Record<string, string>;
    /** Role when nothing matches (default null: identity has no role) */
    default?: string | null;
}

export interface ResolveUserHelpers {
    /** Find a user-table row (password field stripped) — null when there is no user table */
    findUser(where: Record<string, unknown>): Promise<RapiddUser | null>;
    /** Insert a user-table row and return it (password field stripped) */
    createUser(data: Record<string, unknown>): Promise<RapiddUser>;
    /** The role the configured role mapping assigns to this identity */
    mapRole(identity: ExternalIdentity): string | null;
}

interface BaseProviderConfig {
    /** Instance name (defaults to the type) — must be unique */
    name?: string;
    link?: AuthLinkConfig | false;
    roles?: RoleMappingConfig;
}

export interface LocalProviderConfig extends BaseProviderConfig {
    type: 'local';
}

export interface LdapProviderConfig extends BaseProviderConfig {
    type: 'ldap';
    /** ldap:// or ldaps:// URL; several are tried in order (failover) */
    url: string | string[];
    /** Direct bind without a service account: '{{username}}@corp.example.com' or 'uid={{username}},ou=people,dc=example,dc=com' */
    bindTemplate?: string;
    /** Service account for search-then-bind (recommended — supports login by email/sAMAccountName) */
    bindDN?: string;
    bindPassword?: string;
    /** Search base for user lookups (required for search-then-bind) */
    searchBase?: string;
    /** User lookup filter; {{username}} is RFC 4515-escaped. Default matches sAMAccountName, userPrincipalName, uid, mail */
    searchFilter?: string;
    /** Attribute names (defaults suit Active Directory and OpenLDAP) */
    attributes?: { username?: string; email?: string; name?: string; groups?: string };
    /** Resolve nested group membership (Active Directory only — LDAP_MATCHING_RULE_IN_CHAIN) */
    nestedGroups?: boolean;
    /** Search groups instead of reading memberOf (servers without the memberOf overlay) */
    groupSearchBase?: string;
    /** Group filter; {{dn}} and {{username}} are escaped. Default: (|(member={{dn}})(uniqueMember={{dn}})(memberUid={{username}})) */
    groupSearchFilter?: string;
    /** Upgrade ldap:// connections with StartTLS */
    startTLS?: boolean;
    /** TLS options (ca, rejectUnauthorized, ...) for ldaps:// and StartTLS */
    tlsOptions?: Record<string, unknown>;
    /** Operation timeout in ms (default 5000) */
    timeout?: number;
}

export interface WebdavProviderConfig extends BaseProviderConfig {
    type: 'webdav';
    /** WebDAV URL to authenticate against; may contain {{username}} (URL-encoded) */
    url: string;
    /** Request timeout in ms (default 5000) */
    timeout?: number;
}

export interface OidcProviderConfig extends BaseProviderConfig {
    type: 'oidc';
    /** Issuer URL — discovery is loaded from <issuer>/.well-known/openid-configuration */
    issuer?: string;
    /**
     * Explicit endpoints — override discovery, or replace it for plain OAuth2 servers
     * without OpenID Connect (then identities come from the userinfo endpoint)
     */
    endpoints?: { authorization?: string; token?: string; userinfo?: string; jwks?: string; introspection?: string };
    /** OAuth client id — required for redirect login, default expected audience */
    clientId?: string;
    /** Client secret (confidential clients; needed for token introspection) */
    clientSecret?: string;
    /** Expected `aud` of bearer access tokens (default: clientId) */
    audience?: string | string[];
    /** Scopes requested at login (default: openid profile email) */
    scopes?: string[];
    /** Scopes every accepted bearer token must carry (checked against `scp` / `scope`) */
    requiredScopes?: string[];
    /** Callback URL registered at the IdP (default: <PUBLIC_URL>/auth/<name>/callback) */
    redirectUri?: string;
    /** Accept access tokens issued by this IdP as bearer tokens (default: true) */
    acceptBearer?: boolean;
    /** Enable the redirect login routes (default: true when clientId is set) */
    login?: boolean;
    /** Validate opaque (non-JWT) bearer tokens via RFC 7662 introspection (needs clientSecret) */
    introspection?: boolean;
    /** Claim used as ExternalIdentity.subject (default 'sub'; Entra ID: 'oid' is stable across apps) */
    subjectClaim?: string;
    /** Also load the userinfo endpoint at login, even when an id_token is returned */
    userinfo?: boolean;
    /** Extra authorization request parameters (prompt, domain_hint, ...) */
    authorizationParams?: Record<string, string>;
    /** Accepted signature algorithms (default: RS*, PS*, ES*) */
    algorithms?: string[];
    /** Allowed clock skew in seconds (default 30) */
    clockTolerance?: number;
    /** Request timeout in ms for discovery/JWKS/token calls (default 5000) */
    timeout?: number;
}

export type AuthProviderConfig =
    | LocalProviderConfig
    | LdapProviderConfig
    | WebdavProviderConfig
    | OidcProviderConfig;

/**
 * App-level auth configuration — the default export of src/config/auth.ts.
 * Every field is optional; env vars (AUTH_PROVIDERS, LDAP_*, OIDC_*, WEBDAV_*) fill the gaps.
 */
export interface AuthConfig {
    /** Identity providers, tried in order for password logins. Default: AUTH_PROVIDERS env, else ['local'] */
    providers?: Array<AuthProviderConfig | AuthProvider>;
    /** Link external identities to user-table rows (default { field: 'email', from: 'email' }); false disables */
    link?: AuthLinkConfig | false;
    /** Group/role → app role mapping for identities without a user-table row */
    roles?: RoleMappingConfig;
    /** Create a user-table row for an unknown external identity; return the row data, or null to reject */
    provision?: (identity: ExternalIdentity) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
    /** Full control: map any external identity to an app user (null rejects the login) */
    resolveUser?: (identity: ExternalIdentity, helpers: ResolveUserHelpers) => Promise<RapiddUser | null> | RapiddUser | null;
    /** Where redirect logins land when no ?redirect= is given (default: AUTH_LOGIN_REDIRECT, else '/') */
    loginRedirect?: string;
    /**
     * Gate a user at login, at token refresh and when an external bearer token is first seen
     * (e.g. reject deactivated accounts). Throw an ErrorResponse, or return false for a
     * generic 403 `account_inactive`. A rejected refresh also revokes the session.
     */
    validateUser?: (user: RapiddUser, context: AuthEventContext) => void | boolean | Promise<void | boolean>;
    /** Runs after every successful login (audit trail, last-login timestamps). Errors are logged, never fail the login. */
    onLogin?: (user: RapiddUser, context: AuthEventContext) => void | Promise<void>;
}

export interface AuthEventContext {
    event: 'login' | 'refresh' | 'token';
    /** Name of the provider that authenticated the user */
    provider: string;
    /** The external identity (absent on refresh) */
    identity?: ExternalIdentity;
}

// =====================================================
// ACL
// =====================================================

export interface ModelAcl {
    canCreate?: (user: RapiddUser, data?: Record<string, unknown>) => boolean;
    getAccessFilter?: (user: RapiddUser) => Record<string, unknown> | boolean;
    getUpdateFilter?: (user: RapiddUser) => Record<string, unknown> | boolean | false;
    getDeleteFilter?: (user: RapiddUser) => Record<string, unknown> | boolean | false;
    getOmitFields?: (user: RapiddUser) => string[];
    /**
     * Whitelist of fields the user may WRITE in create/update payloads.
     * Return null/undefined for no restriction. Non-writable fields are silently
     * stripped in the model layer (so backend logic keeps working); models constructed
     * with `strictWrites: true` (the REST edge) reject such payloads with 403 instead.
     * getOmitFields is always applied additionally — omitted fields are never writable.
     */
    getWritableFields?: (user: RapiddUser) => string[] | null;
}

export interface AclConfig {
    model: Record<string, ModelAcl>;
}

// =====================================================
// MIDDLEWARE
// =====================================================

export type MiddlewareHook = 'before' | 'after';
export type MiddlewareOperation =
    | 'create' | 'update' | 'upsert' | 'upsertMany'
    | 'delete' | 'get' | 'getMany' | 'count';

export interface MiddlewareContext {
    model: { name: string };
    operation: string;
    user: RapiddUser | null;
    timestamp: Date;
    abort: boolean;
    skip: boolean;
    softDelete: boolean;
    /**
     * Per-operation scratch space shared by the operation's `before` and `after` hooks —
     * e.g. capture the old row in `before`, diff against `ctx.result` in `after`.
     */
    state: Record<string, any>;
    data?: Record<string, unknown>;
    id?: string | number;
    result?: unknown;
    query?: string | Record<string, unknown>;
    /** getMany: the server-side scope (GetManyOptions.where) */
    where?: Record<string, unknown>;
    include?: string | Record<string, unknown>;
    take?: number;
    skip_offset?: number;
    sortBy?: string;
    sortOrder?: string;
    options?: Record<string, unknown>;
    fields?: string | null;
    unique_key?: string | string[];
    prismaOptions?: Record<string, unknown>;
    [key: string]: unknown;
}

export type MiddlewareFn = (context: MiddlewareContext) => Promise<MiddlewareContext | void> | MiddlewareContext | void;

// =====================================================
// API RESPONSES
// =====================================================

export interface ListMeta {
    take: number;
    skip: number;
    total?: number;
    page?: number;
    pageSize?: number;
    hasMore?: boolean;
}

export interface ListResponseBody<T = unknown> {
    data: T[];
    meta: {
        total?: number;
        count: number;
    } & (
        | { limit: number; offset: number; hasMore?: boolean }
        | { page: number; pageSize: number; totalPages?: number; hasNextPage: boolean }
    );
}

export interface ErrorResponseBody {
    status_code: number;
    /** Localized human-readable message */
    message: string;
    /** Machine-readable i18n key — stable across languages, switch on this */
    key?: string;
    /** Interpolation data for the message (field names, values, hints) */
    data?: Record<string, unknown>;
}

// =====================================================
// DMMF
// =====================================================

export interface DMMFField {
    name: string;
    kind: string;
    type: string;
    isList: boolean;
    isRequired: boolean;
    isId: boolean;
    isUnique: boolean;
    hasDefaultValue?: boolean;
    relationFromFields?: string[];
    relationToFields?: string[];
    relationName?: string;
    relationOnDelete?: string;
    [key: string]: unknown;
}

export interface DMMFModel {
    name: string;
    fields: DMMFField[];
    primaryKey?: { name?: string | null; fields: string[] } | null;
    uniqueIndexes?: { name?: string | null; fields: string[] }[];
    [key: string]: unknown;
}

export interface DMMF {
    datamodel: {
        models: DMMFModel[];
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface RelationConfig {
    name: string;
    object: string;
    isList: boolean;
    field?: string;
    foreignKey?: string;
    fields?: string[];
    foreignKeys?: string[];
    relation?: RelationConfig[];
}

// =====================================================
// PRISMA / RLS
// =====================================================

export type RLSVariables = Record<string, string | number | null>;

export type RlsContextFn = (request: any) => RLSVariables | Promise<RLSVariables>;

export interface RLSConfig {
    namespace: string;
}

export type DatabaseProvider = 'postgresql' | 'mysql';

export interface AdapterResult {
    adapter: unknown;
    pool: unknown | null;
    provider: DatabaseProvider;
}

// =====================================================
// QUERY BUILDER
// =====================================================

export interface PrismaWhereClause {
    [key: string]: unknown;
}

export interface PrismaIncludeClause {
    [key: string]: boolean | PrismaIncludeContent;
}

export interface PrismaIncludeContent {
    include?: PrismaIncludeClause;
    where?: PrismaWhereClause;
    omit?: Record<string, boolean>;
}

export interface PrismaOrderBy {
    [key: string]: 'asc' | 'desc' | PrismaOrderBy;
}

export interface PrismaErrorInfo {
    status: number;
    message: string | null;
}

export interface QueryErrorResponse {
    status_code: number;
    /** Localized human-readable message */
    message: string;
    /** Machine-readable i18n key (absent for unclassified errors in development) */
    key?: string;
    /** Interpolation data for the message */
    data?: Record<string, unknown>;
}

// =====================================================
// RATE LIMITER
// =====================================================

export interface RateLimitPathConfig {
    maxRequests: number;
    windowMs: number;
    ignoreSuccessfulRequests?: boolean;
}

export interface RateLimitResult {
    allowed: boolean;
    count: number;
    /** Epoch milliseconds when the window resets, on the clock of whichever store produced it. */
    resetTime: number;
    /**
     * Milliseconds until the window resets, measured by the store's own clock. Kept separate
     * from `resetTime` because the Redis store reports Redis's clock: subtracting a local
     * `Date.now()` from it would reintroduce exactly the clock-skew dependency the Lua
     * script avoids.
     */
    retryAfterMs: number;
    /**
     * Identifies this request's entry in the store so it can be refunded later
     * (see `ignoreSuccessfulRequests`). Redis: the sorted-set member. Memory: the
     * window stamp, used to confirm the window hasn't rolled over before refunding.
     * Absent when the request was denied (nothing was recorded).
     */
    token?: string;
}

// =====================================================
// SESSION STORE
// =====================================================

export interface ISessionStore {
    create(sessionId: string, data: Record<string, unknown>, options?: { ttl?: number; userId?: string | number | null }): Promise<void>;
    get(sessionId: string): Promise<Record<string, unknown> | null>;
    delete(sessionId: string): Promise<void>;
    refresh(sessionId: string): Promise<void>;
    /** Read and extend in one operation (optional — falls back to get + refresh) */
    touch?(sessionId: string): Promise<Record<string, unknown> | null>;
    /** Read and delete in one operation (optional — falls back to get + delete) */
    take?(sessionId: string): Promise<Record<string, unknown> | null>;
    /** Write only if the key exists — true when written (optional — falls back to get + create) */
    replace?(sessionId: string, data: Record<string, unknown>, options?: { ttl?: number; userId?: string | number | null }): Promise<boolean>;
    /** Write only if the key does not exist — true when written (optional — falls back to get + create) */
    add?(sessionId: string, data: Record<string, unknown>, options?: { ttl?: number; userId?: string | number | null }): Promise<boolean>;
    /** Delete every entry written with this userId (optional — needed for revokeUserSessions) */
    deleteByUser?(userId: string | number): Promise<number>;
    isHealthy(): Promise<boolean>;
    destroy?(): void | Promise<void>;
}

// =====================================================
// MODEL
// =====================================================

export interface ModelOptions {
    user?: RapiddUser;
    /**
     * Reject write payloads containing non-writable fields (403) instead of silently
     * stripping them. Intended for models constructed at the REST edge — internal
     * models keep the default (false) so backend logic can pass protected fields.
     */
    strictWrites?: boolean;
    [key: string]: unknown;
}

export interface GetManyOptions {
    /**
     * Client filter — the query string (?q=...), or an object of field equality conditions
     * (`{ courseId: '5' }`, parsed by field type). Validated against the ACL either way.
     */
    q?: string | string[] | Record<string, any>;
    /**
     * Server-side scope: a Prisma where AND-ed with the client filter and the ACL — e.g. the
     * parent of a sub-route. Trusted as is: never put client input here unparsed.
     */
    where?: Record<string, unknown>;
    include?: string | Record<string, any>;
    limit?: number;
    offset?: number;
    /** null/undefined = no ordering (there is deliberately no default sort) */
    sortBy?: string | null;
    sortOrder?: string | null;
    fields?: string | null;
    pagination?: { page: number; pageSize: number };
    totalResults?: boolean;
}

export interface GetManyResult<T = Record<string, unknown>> {
    data: T[];
    meta: { take: number; skip: number; total?: number; page?: number; pageSize?: number; hasMore?: boolean };
}

export interface UpsertManyResult {
    created: number;
    updated: number;
    /** New records the bulk insert skipped on a unique conflict (not individually identifiable) */
    skipped: number;
    /** One entry per failed record — or per failed bulk insert, with all of its `records` */
    failed: Array<{ record?: unknown; records?: unknown; error: Error }>;
    totalSuccess: number;
    /** Records that failed (a failed bulk insert counts all of its records) */
    totalFailed: number;
}

export interface UpsertManyOptions {
    validateRelation?: boolean;
    transaction?: boolean;
    timeout?: number;
}

// =====================================================
// FASTIFY TYPE AUGMENTATION
// =====================================================

declare module 'fastify' {
    interface FastifyContextConfig {
        /** false exempts the route from rate limiting (health probes, webhooks) */
        rateLimit?: boolean;
        /** false keeps the route out of the access log */
        accessLog?: boolean;
    }

    interface FastifyRequest {
        user: RapiddUser | null;
        language: string;
        remoteAddress: string;
        model: import('./orm/Model').Model | null;
        getTranslation(key: string, data?: Record<string, unknown> | null, language?: string): string;
        parseListQuery(): GetManyOptions;
    }

    interface FastifyReply {
        sendList(data: unknown[], meta: ListMeta): FastifyReply;
        sendError(statusCode: number, message: string, data?: unknown): FastifyReply;
        handleError(error: any, data?: Record<string, unknown>): FastifyReply;
        sendResponse(statusCode: number, message: string, params?: unknown): FastifyReply;
    }
}

// =====================================================
// APP CONFIG
// =====================================================

/**
 * Programmatic overrides for buildApp — intended for tests and embedded use.
 * Deployed apps configure via env vars (ROUTES_PATH, STRINGS_PATH, PUBLIC_PATH,
 * ALLOWED_ORIGINS, RATE_LIMIT_*); every option here overrides its env counterpart.
 */
export interface RapiddOptions {
    /** Directory of route plugins to autoload (default: env ROUTES_PATH) */
    routesPath?: string;
    /** Locale dictionary directory (default: env STRINGS_PATH -> ROOT/locales) */
    stringsPath?: string;
    /** Public assets root — static files are served from `<publicPath>/static` (default: env PUBLIC_PATH) */
    publicPath?: string;
    /** Overrides merged over the env-derived @fastify/cors options */
    cors?: Record<string, unknown>;
    /** Set false to disable rate limiting (default: enabled in production) */
    rateLimit?: boolean;
    /**
     * Extra Fastify plugins, registered after the core plugins (auth, RLS, rate limiting)
     * and before the route loader. Pass `[plugin, options]` to give a plugin options.
     */
    plugins?: Array<RapiddPluginEntry>;
    /**
     * Called for every unexpected error (responses with status >= 500) and for process-level
     * crashes — hook up Sentry, Datadog, etc. here. Must not throw.
     */
    errorReporter?: (error: unknown, request?: FastifyRequest) => void;
    /** GET /health (liveness) and /health/ready (readiness); false disables. Env: HEALTH_ENABLED */
    health?: boolean;
    /** Auth options (providers, hooks, ...) — override src/config/auth.ts and env */
    auth?: AuthOptions;
    /** Install the uncaughtException/unhandledRejection logging handlers (default true) */
    processHandlers?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RapiddPluginEntry = ((...args: any[]) => any) | [(...args: any[]) => any, Record<string, unknown>];
