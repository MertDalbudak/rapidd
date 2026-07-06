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

// ── Authentication ───────────────────────────────────────────────────────────
export { Auth } from './auth/Auth';
export { SessionStoreManager, createStore } from './auth/stores';
export type { ISessionStore } from './auth/stores/ISessionStore';

// ── Errors & Responses ───────────────────────────────────────────────────────
export { ErrorResponse, ErrorBasicResponse, Response } from './core/errors';

// ── Internationalization ─────────────────────────────────────────────────────
export { LanguageDict } from './core/i18n';

// ── Middleware ───────────────────────────────────────────────────────────────
export { modelMiddleware } from './core/middleware';

// ── Utilities ────────────────────────────────────────────────────────────────
export { ApiClient, ApiClientError } from './utils/ApiClient';
export { Mailer } from './utils/Mailer';
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
export { default as rateLimitPlugin, RateLimiter } from './plugins/rateLimit';
export { default as rateLimiterPlugin } from './plugins/rateLimit'; // backward compat alias
export { default as rlsPlugin } from './plugins/rls';

// ── App Builder ──────────────────────────────────────────────────────────────
export { buildApp } from './app';

// ── Types ────────────────────────────────────────────────────────────────────
export type {
    RapiddUser,
    AuthStrategy,
    AuthOptions,
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
    AuthConfig,
    RequestOptions,
    ApiResponse
} from './utils/ApiClient';

export type {
    EmailConfig,
    EmailOptions,
    EmailAttachment,
    EmailResult
} from './utils/Mailer';

export type {
    UploadOptions,
    AllowedType,
    UploadedFile
} from './plugins/upload';

export type { EnvConfig } from './core/env';
export type { LogLevel } from './utils/Logger';
