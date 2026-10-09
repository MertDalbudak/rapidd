/**
 * Rapidd Framework - Main exports
 *
 * @example
 * import { Model, QueryBuilder, prisma, Auth, ErrorResponse } from 'rapidd';
 *
 * class Users extends Model {
 *     constructor(options) {
 *         super('users', options);
 *     }
 * }
 */

// ── ORM ──────────────────────────────────────────────────────────────────────
export { Model } from './orm/Model';
export { QueryBuilder, PRISMA_WRITE_OPS, PRISMA_ERROR_MAP } from './orm/QueryBuilder';

// ── Database ─────────────────────────────────────────────────────────────────
export {
    prisma,
    authPrisma,
    prismaTransaction,
    getAcl,
    setRLSVariables,
    resetRLSVariables,
    requestContext,
    dbProvider,
    rlsEnabled
} from './core/prisma';

export * as dmmf from './core/dmmf';

// ── System / default user ────────────────────────────────────────────────────
export { createSystemUser, isSystemUser, getDefaultUser } from './core/user';

// ── Authentication ───────────────────────────────────────────────────────────
export { Auth, getAuth } from './auth/Auth';
export type { LoginResult } from './auth/Auth';
export { SessionStoreManager, createStore, MemoryStore, RedisStore } from './auth/stores';
export type { ISessionStore, SessionWriteOptions } from './auth/stores/ISessionStore';
export {
    LocalProvider,
    LdapProvider,
    WebdavProvider,
    OidcProvider,
    escapeFilterValue,
    escapeDnValue,
} from './auth/providers';
export { IdentityResolver } from './auth/identity';

// ── Access Control ───────────────────────────────────────────────────────────
export { applyAclDefault, auditAcl, DENY_ALL } from './core/acl';

// ── Configuration ────────────────────────────────────────────────────────────
export { getAppConfig, substituteEnv } from './core/config';
export { createRedisClient, isRedisConfigured } from './core/redis';
export { isOriginAllowed, safeRedirectTarget } from './core/origins';

// ── Errors & Responses ───────────────────────────────────────────────────────
export { ErrorResponse, ErrorBasicResponse, Response } from './core/errors';

// ── Internationalization ─────────────────────────────────────────────────────
export { LanguageDict } from './core/i18n';

// ── Middleware ───────────────────────────────────────────────────────────────
export { modelMiddleware } from './core/middleware';

// ── Utilities ────────────────────────────────────────────────────────────────
export { ApiClient, ApiClientError } from './utils/ApiClient';
export { Logger } from './utils/Logger';
export { env } from './utils';

// ── Environment ──────────────────────────────────────────────────────────────
export {
    validateEnv,
    getEnv,
    getAllEnv,
    isProduction,
    isDevelopment,
    isTest
} from './core/env';

// ── Plugins ──────────────────────────────────────────────────────────────────
export { uploadPlugin } from './plugins/upload';
export { default as requestPlugin } from './plugins/request';
export { default as responsePlugin } from './plugins/response';
export { default as apiPlugin } from './plugins/response'; // backward compat alias
export { default as authPlugin } from './plugins/auth';
export { default as languagePlugin } from './plugins/language';
export { default as securityPlugin } from './plugins/security';
export { default as rateLimitPlugin, RateLimiter, getRateLimiter } from './plugins/rateLimit';
export type { RateLimiterOptions } from './plugins/rateLimit';
export { default as rateLimiterPlugin } from './plugins/rateLimit'; // backward compat alias
export { default as rlsPlugin } from './plugins/rls';

// ── App Builder ──────────────────────────────────────────────────────────────
export { buildApp, installProcessHandlers, markShuttingDown, parseTrustProxy } from './app';
export { startServer } from './server';
export type { StartOptions } from './server';

// ── Types ────────────────────────────────────────────────────────────────────
export type {
    RapiddUser,
    AuthStrategy,
    AuthOptions,
    AuthConfig,
    AuthEventContext,
    AuthProvider,
    AuthProviderConfig,
    AuthLinkConfig,
    AuthFlowState,
    ExternalIdentity,
    LocalProviderConfig,
    LdapProviderConfig,
    OidcProviderConfig,
    WebdavProviderConfig,
    ResolveUserHelpers,
    RoleMappingConfig,
    RapiddPluginEntry,
    RouteAuthConfig,
    ModelOptions,
    GetManyOptions,
    GetManyResult,
    UpsertManyResult,
    UpsertManyOptions,
    ModelAcl,
    AclConfig,
    MiddlewareContext,
    MiddlewareHook,
    MiddlewareOperation,
    RapiddOptions,
    ListMeta,
    RLSVariables,
    RlsContextFn
} from './types';

export type {
    ServiceConfig,
    EndpointConfig,
    AuthConfig as ApiAuthConfig,
    RequestOptions,
    ApiResponse
} from './utils/ApiClient';

export type {
    UploadOptions,
    AllowedType,
    UploadedFile
} from './plugins/upload';

export type { EnvConfig } from './core/env';
export type { LogLevel, LogFormat, LogContext } from './utils/Logger';
