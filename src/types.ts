import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// =====================================================
// USER & AUTH
// =====================================================

export interface RapiddUser {
    id: string | number;
    role: string;
    [key: string]: unknown;
}

export type AuthMethod = 'bearer' | 'basic' | 'cookie' | 'header';

export interface RouteAuthConfig {
    methods?: AuthMethod[];
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
    methods?: AuthMethod[];
    cookieName?: string;
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
}

export interface ListResponseBody<T = unknown> {
    data: T[];
    meta: {
        total?: number;
        count: number;
        limit: number;
        offset: number;
        hasMore?: boolean;
    };
}

export interface ErrorResponseBody {
    status_code: number;
    message: string;
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
    message: string;
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
    resetTime: number;
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
    [key: string]: unknown;
}

export interface GetManyResult<T = Record<string, unknown>> {
    data: T[];
    meta: { take: number; skip: number; total: number };
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
        getTranslation(key: string, data?: Record<string, unknown> | null, language?: string): string;
    }

    interface FastifyReply {
        sendList(data: unknown[], meta: ListMeta): FastifyReply;
        sendError(statusCode: number, message: string, data?: unknown): FastifyReply;
        sendResponse(statusCode: number, message: string, params?: unknown): FastifyReply;
    }
}

// =====================================================
// APP CONFIG
// =====================================================

export interface AppConfig {
    languages: string[];
    database?: Record<string, unknown>;
    services?: Record<string, unknown>;
    emails?: Record<string, unknown>;
}

export interface RapiddOptions {
    routesPath?: string;
    stringsPath?: string;
    publicPath?: string;
    config?: AppConfig;
    cors?: Record<string, unknown>;
    rateLimit?: boolean;
}
