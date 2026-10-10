import { Logger } from '../utils/Logger';

/**
 * Environment variable validation and access
 * Validates required variables at startup and provides typed access
 */

export interface EnvConfig {
    // Required
    DATABASE_URL: string;

    // Optional (auto-generated if auth is enabled)
    JWT_SECRET?: string;
    JWT_REFRESH_SECRET?: string;

    // Optional with defaults
    NODE_ENV: 'development' | 'production' | 'test';
    PORT: number;
    HOST: string;
    DATABASE_URL_ADMIN?: string;
    DATABASE_PROVIDER?: 'postgresql' | 'mysql';
    COOKIE_SECRET?: string;
    ALLOWED_ORIGINS?: string;

    // Auth
    /** Default: redis when REDIS_URL/REDIS_HOST is set, else memory */
    AUTH_SESSION_STORAGE?: 'redis' | 'memory';
    /** Identity providers, in order: local, ldap, oidc, webdav */
    AUTH_PROVIDERS?: string;
    /** Absolute session lifetime in seconds (0 = unlimited) */
    AUTH_SESSION_MAX_AGE?: number;
    /** Externally visible base URL (OIDC callback URLs) */
    PUBLIC_URL?: string;
    AUTH_SESSION_TTL: number;
    AUTH_SALT_ROUNDS: number;
    AUTH_ACCESS_TOKEN_EXPIRY: string;
    AUTH_REFRESH_TOKEN_EXPIRY: string;
    DB_USER_TABLE: string;

    // API
    API_RESULT_LIMIT: number;
    REQUEST_TIMEOUT: number;
    API_MAX_RETRIES: number;

    // Rate limiting
    RATE_LIMIT_ENABLED: boolean;
    RATE_LIMIT_WINDOW_MS: number;
    RATE_LIMIT_MAX_REQUESTS: number;

    // Redis
    REDIS_URL?: string;
    REDIS_HOST?: string;
    REDIS_PORT: number;
    REDIS_PASSWORD?: string;
    REDIS_DB_RATE_LIMIT: number;
    REDIS_DB_AUTH: number;

    // RLS
    RLS_ENABLED?: boolean;
    RLS_NAMESPACE: string;

    // Proxy
    TRUST_PROXY?: string;

    // Pagination
    PAGINATION_MODE: 'offset' | 'page';

    // Logging
    LOG_LEVEL: 'essential' | 'fine' | 'finest';
    LOG_FORMAT?: 'text' | 'json';
    LOG_DIR: string;

    // Access control & i18n
    ACL_DEFAULT?: 'allow' | 'deny';
    DEFAULT_LANGUAGE?: string;

    // Lifecycle
    SHUTDOWN_TIMEOUT_MS?: number;
    SHUTDOWN_DELAY_MS?: number;
}

const REQUIRED_VARS = [
    'DATABASE_URL'
] as const;

const DEFAULTS: Partial<Record<keyof EnvConfig, string | number | boolean>> = {
    NODE_ENV: 'development',
    PORT: 3000,
    HOST: '0.0.0.0',
    AUTH_SESSION_TTL: 86400,
    AUTH_SALT_ROUNDS: 10,
    AUTH_ACCESS_TOKEN_EXPIRY: '1d',
    AUTH_REFRESH_TOKEN_EXPIRY: '7d',
    DB_USER_TABLE: 'users',
    API_RESULT_LIMIT: 500,
    REQUEST_TIMEOUT: 10000,
    API_MAX_RETRIES: 2,
    RATE_LIMIT_ENABLED: true,
    RATE_LIMIT_WINDOW_MS: 900000,
    RATE_LIMIT_MAX_REQUESTS: 100,
    REDIS_PORT: 6379,
    REDIS_DB_RATE_LIMIT: 0,
    REDIS_DB_AUTH: 1,
    RLS_NAMESPACE: 'app',
    PAGINATION_MODE: 'offset',
    LOG_LEVEL: 'essential',
    LOG_DIR: 'logs',
};

/**
 * Validate that all required environment variables are set
 * @throws Error if required variables are missing
 */
export function validateEnv(): void {
    const missing: string[] = [];

    for (const key of REQUIRED_VARS) {
        if (!process.env[key]) {
            missing.push(key);
        }
    }

    if (missing.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}\n` +
            `Please check your .env file or environment configuration.`
        );
    }

    // Validate DATABASE_URL format
    const dbUrl = process.env.DATABASE_URL!;
    if (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://') &&
        !dbUrl.startsWith('mysql://') && !dbUrl.startsWith('mariadb://')) {
        throw new Error(
            `Invalid DATABASE_URL format. Must start with postgresql://, postgres://, mysql://, or mariadb://`
        );
    }

    for (const problem of findEnumProblems()) {
        Logger.warn(problem);
    }

    // An unknown zone would make every date filter throw — fail at startup instead
    if (process.env.API_TIMEZONE) {
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: process.env.API_TIMEZONE });
        } catch {
            throw new Error(`Invalid API_TIMEZONE "${process.env.API_TIMEZONE}" — use an IANA name such as Europe/Berlin or UTC`);
        }
    }
}

/** Env vars with a fixed set of values — a typo must be visible, not silently defaulted */
const ENUMS: Record<string, string[]> = {
    NODE_ENV: ['development', 'production', 'test'],
    LOG_LEVEL: ['essential', 'fine', 'finest'],
    LOG_FORMAT: ['text', 'json'],
    ACL_DEFAULT: ['allow', 'deny'],
    PAGINATION_MODE: ['offset', 'page'],
    AUTH_SESSION_STORAGE: ['redis', 'memory'],
    COOKIE_SAME_SITE: ['strict', 'lax', 'none'],
    AUTH_COOKIE_SAME_SITE: ['strict', 'lax', 'none'],
};

/** Messages for set-but-invalid enumerated env vars */
export function findEnumProblems(env: NodeJS.ProcessEnv = process.env): string[] {
    const problems: string[] = [];
    for (const [key, allowed] of Object.entries(ENUMS)) {
        const value = env[key];
        if (value !== undefined && value !== '' && !allowed.includes(value)) {
            problems.push(`Invalid ${key}="${value}" — expected one of: ${allowed.join(', ')}. The default is used instead.`);
        }
    }
    return problems;
}

/**
 * Get an environment variable with type coercion.
 * Parsed values are cached after first access.
 */
const _envCache = new Map<string, unknown>();
const _envSnapshot = new Map<string, string | undefined>();

export function getEnv<K extends keyof EnvConfig>(key: K): EnvConfig[K] {
    const envValue = process.env[key];
    if (_envCache.has(key) && _envSnapshot.get(key) === envValue) {
        return _envCache.get(key) as EnvConfig[K];
    }

    const value = process.env[key];
    const defaultValue = DEFAULTS[key];

    let result: unknown;

    if (value === undefined || value === '') {
        result = defaultValue !== undefined ? defaultValue : undefined;
    } else if (typeof defaultValue === 'number') {
        result = parseInt(value, 10);
    } else if (typeof defaultValue === 'boolean') {
        result = value.toLowerCase() === 'true';
    } else {
        result = value;
    }

    _envCache.set(key, result);
    _envSnapshot.set(key, envValue);
    return result as EnvConfig[K];
}

/**
 * Get all environment configuration
 */
export function getAllEnv(): Partial<EnvConfig> {
    const config: Partial<EnvConfig> = {};

    for (const key of Object.keys(DEFAULTS) as (keyof EnvConfig)[]) {
        (config as any)[key] = getEnv(key);
    }

    // Add required vars
    for (const key of REQUIRED_VARS) {
        (config as any)[key] = process.env[key];
    }

    return config;
}

/**
 * Check if running in production
 */
export function isProduction(): boolean {
    return getEnv('NODE_ENV') === 'production';
}

/**
 * Check if running in development
 */
export function isDevelopment(): boolean {
    return getEnv('NODE_ENV') === 'development';
}

/**
 * Check if running in test
 */
export function isTest(): boolean {
    return getEnv('NODE_ENV') === 'test';
}

export default {
    validate: validateEnv,
    get: getEnv,
    getAll: getAllEnv,
    isProduction,
    isDevelopment,
    isTest
};
