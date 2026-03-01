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
    AUTH_SESSION_STORAGE: 'redis' | 'memory';
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
    REDIS_HOST?: string;
    REDIS_PORT: number;
    REDIS_PASSWORD?: string;
    REDIS_DB_RATE_LIMIT: number;
    REDIS_DB_AUTH: number;

    // RLS
    RLS_ENABLED?: boolean;
    RLS_NAMESPACE: string;

    // Proxy
    TRUST_PROXY?: boolean;
}

const REQUIRED_VARS = [
    'DATABASE_URL'
] as const;

const DEFAULTS: Partial<Record<keyof EnvConfig, string | number | boolean>> = {
    NODE_ENV: 'development',
    PORT: 3000,
    HOST: '0.0.0.0',
    AUTH_SESSION_STORAGE: 'redis',
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
    RLS_NAMESPACE: 'app'
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
}

/**
 * Get an environment variable with type coercion
 */
export function getEnv<K extends keyof EnvConfig>(key: K): EnvConfig[K] {
    const value = process.env[key];
    const defaultValue = DEFAULTS[key];

    if (value === undefined || value === '') {
        if (defaultValue !== undefined) {
            return defaultValue as EnvConfig[K];
        }
        return undefined as EnvConfig[K];
    }

    // Type coercion based on default value type
    if (typeof defaultValue === 'number') {
        return parseInt(value, 10) as EnvConfig[K];
    }
    if (typeof defaultValue === 'boolean') {
        return (value.toLowerCase() === 'true') as EnvConfig[K];
    }

    return value as EnvConfig[K];
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
