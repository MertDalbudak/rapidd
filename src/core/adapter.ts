import type { AdapterResult, DatabaseProvider } from '../types';

/**
 * Prisma driver adapters from a connection string. Side-effect free — unlike core/prisma,
 * importing this opens nothing, so the setup wizard can use it before the app is configured.
 */

/** postgresql://, postgres:// → postgresql; mysql://, mariadb:// → mysql */
export function detectProvider(connectionString: string): DatabaseProvider {
    if (!connectionString) return 'postgresql';
    if (connectionString.startsWith('mysql://') || connectionString.startsWith('mariadb://')) {
        return 'mysql';
    }
    return 'postgresql';
}

/** mysql://user:pass@host:port/db → mariadb driver options (credentials URL-decoded) */
export function parseMySQLConnectionString(connectionString: string): Record<string, unknown> {
    const url = new URL(connectionString);
    return {
        host: url.hostname,
        port: parseInt(url.port, 10) || 3306,
        // URL keeps them percent-encoded: a password with '@' is written as %40
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)),
        connectionLimit: 10,
    };
}

export function createAdapter(connectionString: string, provider: string | null = null): AdapterResult {
    const detectedProvider = (provider || process.env.DATABASE_PROVIDER || detectProvider(connectionString)) as DatabaseProvider;

    if (detectedProvider === 'mysql' || (detectedProvider as string) === 'mariadb') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
        const config = parseMySQLConnectionString(connectionString);
        const adapter = new PrismaMariaDb(config);
        return { adapter, pool: null, provider: 'mysql' };
    } else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { PrismaPg } = require('@prisma/adapter-pg');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString });
        const adapter = new PrismaPg(pool);
        return { adapter, pool, provider: 'postgresql' };
    }
}
