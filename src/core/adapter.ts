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

const seconds = (value: string | null): number | undefined => {
    const n = value === null ? NaN : Number(value);
    return Number.isFinite(n) && n >= 0 ? n * 1000 : undefined;
};

/**
 * mysql://user:pass@host:port/db?… → mariadb driver options (credentials URL-decoded). Prisma's
 * MySQL URL parameters apply as for Prisma's CLI: connection_limit, connect_timeout and
 * socket_timeout (seconds), socket (Unix socket), sslaccept (strict | accept_invalid_certs) and
 * sslcert (CA file, relative to ./prisma) — plus ssl=true. MySQL 8 signs in with
 * caching_sha2_password: without TLS that needs the server's RSA key, which is fetched as Prisma's
 * CLI does — `allowPublicKeyRetrieval=false` turns it off (then use TLS).
 */
export function parseMySQLConnectionString(connectionString: string): Record<string, unknown> {
    const url = new URL(connectionString);
    const params = url.searchParams;
    const config: Record<string, unknown> = {
        host: url.hostname,
        port: parseInt(url.port, 10) || 3306,
        // URL keeps them percent-encoded: a password with '@' is written as %40
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)),
        connectionLimit: parseInt(params.get('connection_limit') || '', 10) || 10,
        allowPublicKeyRetrieval: params.get('allowPublicKeyRetrieval') !== 'false',
    };
    const connectTimeout = seconds(params.get('connect_timeout'));
    if (connectTimeout !== undefined) config.connectTimeout = connectTimeout;
    const socketTimeout = seconds(params.get('socket_timeout'));
    if (socketTimeout !== undefined) config.socketTimeout = socketTimeout;
    if (params.get('socket')) config.socketPath = params.get('socket');
    const sslcert = params.get('sslcert');
    if (params.get('ssl') === 'true' || params.has('sslaccept') || sslcert) {
        config.ssl = {
            rejectUnauthorized: params.get('sslaccept') !== 'accept_invalid_certs',
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            ...(sslcert ? { ca: require('fs').readFileSync(require('path').resolve(process.cwd(), 'prisma', sslcert)) } : {}),
        };
    }
    return config;
}

/**
 * Prisma's own parameters of a PostgreSQL URL — they are not libpq parameters, pg ignores them:
 * `schema` (the adapter must be told, else every query goes to `public`), `connection_limit`
 * (pool size, default 10) and `pool_timeout` (seconds to wait for a connection). Returns the
 * URL without them.
 */
export function splitPostgresSchema(connectionString: string): { connectionString: string; schema?: string; max?: number; connectionTimeoutMillis?: number } {
    let url: URL;
    try {
        url = new URL(connectionString);
    } catch {
        return { connectionString };
    }
    const params = url.searchParams;
    const schema = params.get('schema') || undefined;
    const max = parseInt(params.get('connection_limit') || '', 10) || undefined;
    const connectionTimeoutMillis = seconds(params.get('pool_timeout'));
    if (!schema && !max && connectionTimeoutMillis === undefined) return { connectionString };
    for (const key of ['schema', 'connection_limit', 'pool_timeout']) params.delete(key);
    return {
        connectionString: url.toString(), schema,
        ...(max ? { max } : {}),
        ...(connectionTimeoutMillis !== undefined ? { connectionTimeoutMillis } : {}),
    };
}

const DRIVER_DATABASE: Record<string, string> = {
    '@prisma/adapter-mariadb': 'MySQL/MariaDB', mariadb: 'MySQL/MariaDB',
    '@prisma/adapter-pg': 'PostgreSQL', pg: 'PostgreSQL',
};

/**
 * require() a database driver. A Docker image installs the driver of its schema's database only,
 * so a URL for the other database ends here — with that said instead of "Cannot find module".
 */
export function requireDriver(name: string): any {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require(name);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND' && (err as Error).message.includes(`'${name}'`)) {
            throw new Error(`${name} is not installed, so ${DRIVER_DATABASE[name] ?? name} databases can't be used. `
                + 'A Docker image includes the driver for the datasource provider in prisma/schema.prisma only — build it for this database.');
        }
        throw err;
    }
}

export function createAdapter(connectionString: string, provider: string | null = null): AdapterResult {
    const detectedProvider = (provider || process.env.DATABASE_PROVIDER || detectProvider(connectionString)) as DatabaseProvider;

    if (detectedProvider === 'mysql' || (detectedProvider as string) === 'mariadb') {
        const { PrismaMariaDb } = requireDriver('@prisma/adapter-mariadb');
        const config = parseMySQLConnectionString(connectionString);
        const adapter = new PrismaMariaDb(config);
        return { adapter, pool: null, provider: 'mysql' };
    } else {
        const { PrismaPg } = requireDriver('@prisma/adapter-pg');
        const { Pool } = requireDriver('pg');
        const { connectionString: url, schema, max, connectionTimeoutMillis } = splitPostgresSchema(connectionString);
        const pool = new Pool({ connectionString: url, ...(max ? { max } : {}), ...(connectionTimeoutMillis !== undefined ? { connectionTimeoutMillis } : {}) });
        const adapter = new PrismaPg(pool, schema ? { schema } : undefined);
        return { adapter, pool, provider: 'postgresql' };
    }
}
