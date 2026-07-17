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

export interface AuthOptions {
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
    data?: Record<string, unknown>;
    id?: string | number;
    result?: unknown;
    query?: string | Record<string, unknown>;
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
    primaryKey?: { fields: string[] } | null;
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
    create(sessionId: string, data: Record<string, unknown>): Promise<void>;
    get(sessionId: string): Promise<Record<string, unknown> | null>;
    delete(sessionId: string): Promise<void>;
    refresh(sessionId: string): Promise<void>;
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
    /** Filter — the raw query string (?q=...) or a pre-built filter object */
    q?: string | Record<string, any>;
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
    failed: Array<{ record?: unknown; records?: unknown; error: Error }>;
    totalSuccess: number;
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
}
