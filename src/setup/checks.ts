import net from 'net';
import tls from 'tls';
import { detectProvider, parseMySQLConnectionString, requireDriver } from '../core/adapter';
import { createRedisClient } from '../core/redis';
import { ldapConfigFromEnv, webdavConfigFromEnv, LdapProvider, WebdavProvider } from '../auth/providers';
import type { CheckName, Values } from './catalog';
import { checkSaml } from './saml';

/**
 * Connection tests for the setup wizard. They run against the values being edited (not
 * process.env), never throw, and explain failures in words an operator can act on.
 */

export interface CheckResult {
    ok: boolean;
    /** One-line outcome */
    message: string;
    /** Facts worth showing (server version, tables, endpoints, mapped identity, ...) */
    details?: Record<string, unknown>;
    /** Per-target outcomes (e.g. each LDAP server) */
    steps?: { target: string; ok: boolean; message: string }[];
}

export interface CheckOptions {
    /** Test credentials for a sign-in check (never stored) */
    username?: string;
    password?: string;
    timeoutMs?: number;
    /** The project, and its config files staged in the wizard (an uploaded SAML metadata file) */
    root?: string;
    files?: { samlIdp?: string };
}

const env = (values: Values): NodeJS.ProcessEnv => {
    const out: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') out[key] = value;
    return out;
};

/** Translate driver errors into something actionable */
export function explain(error: any): string {
    const code: string = error?.code ?? '';
    const message: string = error?.message ?? String(error);
    switch (code) {
        case 'ECONNREFUSED': return 'Connection refused — nothing is listening at that host and port';
        case 'ENOTFOUND': case 'EAI_AGAIN': return 'Host not found — check the host name';
        case 'ETIMEDOUT': case 'ESOCKETTIMEDOUT': return 'Timed out — the server is unreachable (firewall, wrong port?)';
        case 'ECONNRESET': return 'The connection was reset — TLS required, or a proxy in between?';
        case 'CERT_HAS_EXPIRED': case 'DEPTH_ZERO_SELF_SIGNED_CERT': case 'SELF_SIGNED_CERT_IN_CHAIN': case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
            return `TLS certificate not trusted (${code}) — provide the CA certificate`;
        case '28P01': case '28000': case 'ER_ACCESS_DENIED_ERROR': return 'Authentication failed — check user name and password';
        case '3D000': case 'ER_BAD_DB_ERROR': return 'The database does not exist — create it first';
        default: return message.split('\n')[0].slice(0, 300);
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${ms} ms`), { code: 'ETIMEDOUT' })), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

// ── Database ─────────────────────────────────────────────────────────────────

/** Tables of the connected database/schema */
export async function databaseInfo(url: string, timeoutMs = 5000): Promise<{ provider: string; version: string; database: string; tables: string[] }> {
    const provider = detectProvider(url);
    if (provider === 'mysql') {
        return withMySQL(url, async (conn) => {
            const [{ version }] = await conn.query('SELECT VERSION() AS version');
            const [{ db }] = await conn.query('SELECT DATABASE() AS db');
            const rows = await conn.query('SHOW TABLES');
            return { provider, version: String(version), database: String(db), tables: rows.map((r: any) => String(Object.values(r)[0])) };
        }, timeoutMs);
    }
    return withPostgres(url, async (client, schema) => {
        const { rows: [info] } = await client.query('SELECT version() AS version, current_database() AS database');
        // The catalog, not information_schema: that shows a role only the tables it has
        // privileges on — the API's own role would see none of the owner's
        const { rows } = await client.query(
            "SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY c.relname", [schema]);
        return {
            provider,
            version: String(info.version).split(' on ')[0],
            database: `${info.database} (schema ${schema})`,
            tables: rows.map((r: any) => r.table_name),
        };
    }, timeoutMs);
}

/** Run fn with a MySQL/MariaDB connection */
export async function withMySQL<T>(url: string, fn: (conn: any) => Promise<T>, timeoutMs = 5000): Promise<T> {
    const mariadb = requireDriver('mariadb');
    const config: Record<string, unknown> = { ...parseMySQLConnectionString(url), connectTimeout: timeoutMs };
    delete config.connectionLimit;
    const conn = await mariadb.createConnection(config);
    try {
        return await fn(conn);
    } finally {
        await conn.end().catch(() => undefined);
    }
}

/** Run fn with a PostgreSQL connection; `schema` is Prisma's ?schema= (default public) */
export async function withPostgres<T>(url: string, fn: (client: any, schema: string) => Promise<T>, timeoutMs = 5000, queryTimeoutMs = 30_000): Promise<T> {
    const { Client } = requireDriver('pg');
    // Prisma's ?schema= is not a libpq parameter — read it, and keep it away from pg
    const parsed = new URL(url);
    const schema = parsed.searchParams.get('schema') || 'public';
    parsed.searchParams.delete('schema');
    const client = new Client({ connectionString: parsed.toString(), connectionTimeoutMillis: timeoutMs, query_timeout: queryTimeoutMs });
    await client.connect();
    try {
        return await fn(client, schema);
    } finally {
        await client.end().catch(() => undefined);
    }
}

async function checkDatabase(values: Values, options: CheckOptions): Promise<CheckResult> {
    const url = values.DATABASE_URL;
    if (!url) return { ok: false, message: 'No connection string' };
    try {
        const info = await withTimeout(databaseInfo(url, options.timeoutMs), (options.timeoutMs ?? 5000) + 1000, 'Database connection');
        const steps = [{ target: 'DATABASE_URL', ok: true, message: `${info.version} · ${info.database}` }];
        if (values.DATABASE_URL_ADMIN) {
            try {
                await withTimeout(databaseInfo(values.DATABASE_URL_ADMIN, options.timeoutMs), (options.timeoutMs ?? 5000) + 1000, 'Admin connection');
                steps.push({ target: 'DATABASE_URL_ADMIN', ok: true, message: 'connected' });
            } catch (err) {
                steps.push({ target: 'DATABASE_URL_ADMIN', ok: false, message: explain(err) });
            }
        }
        return {
            ok: steps.every((s) => s.ok),
            message: `Connected to ${info.version}`,
            details: { provider: info.provider, database: info.database, tables: info.tables },
            steps,
        };
    } catch (err) {
        return { ok: false, message: explain(err) };
    }
}

// ── Redis ────────────────────────────────────────────────────────────────────

async function checkRedis(values: Values, options: CheckOptions): Promise<CheckResult> {
    if (!values.REDIS_URL && !values.REDIS_HOST) {
        return { ok: true, message: 'Not configured — sessions and rate limits use process memory' };
    }
    const client = createRedisClient({
        lazyConnect: true, connectTimeout: options.timeoutMs ?? 5000, maxRetriesPerRequest: 0,
        retryStrategy: () => null, enableOfflineQueue: false,
    }, env(values));
    client.on('error', () => undefined);
    try {
        await withTimeout(client.connect(), (options.timeoutMs ?? 5000) + 1000, 'Redis connection');
        await client.ping();
        const info = await client.info('server');
        const version = /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? 'unknown';
        return { ok: true, message: `Connected to Redis ${version}`, details: { version } };
    } catch (err: any) {
        const message = /WRONGPASS|NOAUTH|invalid username-password/i.test(err?.message ?? '')
            ? 'Authentication failed — check user name and password' : explain(err);
        return { ok: false, message };
    } finally {
        client.disconnect();
    }
}

// ── LDAP ─────────────────────────────────────────────────────────────────────

/** Reach one LDAP server: TCP (or TLS for ldaps://) connect */
function reach(url: string, timeoutMs: number, rejectUnauthorized: boolean): Promise<void> {
    const parsed = new URL(url);
    const secure = parsed.protocol === 'ldaps:';
    const port = Number(parsed.port) || (secure ? 636 : 389);
    return new Promise((resolve, reject) => {
        const socket = secure
            ? tls.connect({ host: parsed.hostname, port, servername: parsed.hostname, rejectUnauthorized, timeout: timeoutMs }, () => { socket.end(); resolve(); })
            : net.connect({ host: parsed.hostname, port, timeout: timeoutMs }, () => { socket.end(); resolve(); });
        socket.on('timeout', () => { socket.destroy(); reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
        socket.on('error', reject);
    });
}

async function checkLdap(values: Values, options: CheckOptions): Promise<CheckResult> {
    let provider: LdapProvider;
    let config: ReturnType<typeof ldapConfigFromEnv>;
    try {
        config = ldapConfigFromEnv(env(values));
        provider = new LdapProvider(config);
    } catch (err) {
        return { ok: false, message: (err as Error).message.replace(/^\[Auth\]\s*/, '') };
    }
    const timeoutMs = options.timeoutMs ?? config.timeout ?? 5000;
    const urls = Array.isArray(config.url) ? config.url : [config.url];
    const steps: CheckResult['steps'] = [];
    for (const url of urls) {
        try {
            await reach(url, timeoutMs, values.LDAP_TLS_REJECT_UNAUTHORIZED !== 'false');
            steps.push({ target: url, ok: true, message: 'reachable' });
        } catch (err) {
            steps.push({ target: url, ok: false, message: explain(err) });
        }
    }

    // Service account: bind and read the search base
    if (config.bindDN && steps.some((s) => s.ok)) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { Client } = require('ldapts');
            const url = urls[steps.findIndex((s) => s.ok)];
            const client = new Client({ url, timeout: timeoutMs, connectTimeout: timeoutMs, tlsOptions: config.tlsOptions });
            try {
                if (config.startTLS) await client.startTLS(config.tlsOptions ?? {});
                await client.bind(config.bindDN, config.bindPassword ?? '');
                if (config.searchBase) await client.search(config.searchBase, { scope: 'base', attributes: ['dn'] });
                steps.push({ target: 'service account', ok: true, message: config.searchBase ? 'bound and read the search base' : 'bound' });
            } finally {
                await client.unbind().catch(() => undefined);
            }
        } catch (err: any) {
            const message = err?.code === 49 || /invalid credentials/i.test(err?.message ?? '')
                ? 'Bind failed — check the service account DN and password'
                : err?.code === 32 ? 'The search base does not exist' : explain(err);
            steps.push({ target: 'service account', ok: false, message });
        }
    }

    // Optional test sign-in: shows what the directory returns for a real user
    if (options.username) {
        try {
            const identity = await provider.authenticate(options.username, options.password ?? '');
            steps.push(identity
                ? { target: `sign-in as ${options.username}`, ok: true, message: 'accepted' }
                : { target: `sign-in as ${options.username}`, ok: false, message: 'rejected — wrong user name or password' });
            if (identity) {
                return { ok: steps.every((s) => s.ok), message: 'Sign-in works', steps,
                    details: { identity: { username: identity.username, email: identity.email, name: identity.name, groups: identity.groups } } };
            }
        } catch (err) {
            steps.push({ target: `sign-in as ${options.username}`, ok: false, message: explain(err) });
        }
    }

    const ok = steps.length > 0 && steps.every((s) => s.ok);
    return { ok, message: ok ? 'Directory reachable' : 'Directory check failed', steps };
}

// ── OpenID Connect ───────────────────────────────────────────────────────────

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`);
    return response.json();
}

async function checkOidc(values: Values, options: CheckOptions): Promise<CheckResult> {
    const issuer = values.OIDC_ISSUER?.trim();
    if (!issuer) return { ok: false, message: 'No issuer' };
    const timeoutMs = options.timeoutMs ?? 5000;
    const steps: CheckResult['steps'] = [];
    try {
        const metadata = await fetchJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, timeoutMs);
        if (metadata.issuer !== issuer) {
            return { ok: false, message: `Issuer mismatch: the provider calls itself "${metadata.issuer}" — use exactly that value` };
        }
        steps.push({ target: 'discovery', ok: true, message: 'found' });
        let keys = 0;
        try {
            keys = (await fetchJson(metadata.jwks_uri, timeoutMs))?.keys?.length ?? 0;
            steps.push({ target: 'signing keys', ok: keys > 0, message: keys > 0 ? `${keys} key(s)` : 'no keys published' });
        } catch (err) {
            steps.push({ target: 'signing keys', ok: false, message: explain(err) });
        }
        if (values.OIDC_LOGIN !== 'false' && !metadata.authorization_endpoint) {
            steps.push({ target: 'browser login', ok: false, message: 'the provider publishes no authorization endpoint' });
        }
        const redirectUri = values.OIDC_REDIRECT_URI || (values.PUBLIC_URL ? `${values.PUBLIC_URL.replace(/\/$/, '')}/auth/oidc/callback` : null);
        return {
            ok: steps.every((s) => s.ok),
            message: steps.every((s) => s.ok) ? 'Identity provider reachable' : 'Identity provider check failed',
            steps,
            details: {
                authorization_endpoint: metadata.authorization_endpoint,
                token_endpoint: metadata.token_endpoint,
                ...(redirectUri ? { register_redirect_uri: redirectUri } : {}),
            },
        };
    } catch (err) {
        return { ok: false, message: explain(err) };
    }
}

// ── WebDAV ───────────────────────────────────────────────────────────────────

async function checkWebdav(values: Values, options: CheckOptions): Promise<CheckResult> {
    let provider: WebdavProvider;
    try {
        provider = new WebdavProvider(webdavConfigFromEnv(env(values)));
    } catch (err) {
        return { ok: false, message: (err as Error).message.replace(/^\[Auth\]\s*/, '') };
    }
    const timeoutMs = options.timeoutMs ?? 5000;
    const steps: CheckResult['steps'] = [];
    const probe = (values.WEBDAV_URL || '').replace('{{username}}', 'rapidd-setup-check');
    try {
        const response = await fetch(probe, { method: 'OPTIONS', signal: AbortSignal.timeout(timeoutMs) });
        steps.push({ target: new URL(probe).origin, ok: true, message: `reachable (HTTP ${response.status})` });
    } catch (err: any) {
        steps.push({ target: probe, ok: false, message: explain(err?.cause ?? err) });
    }
    if (options.username) {
        try {
            const identity = await provider.authenticate(options.username, options.password ?? '');
            steps.push({ target: `sign-in as ${options.username}`, ok: !!identity, message: identity ? 'accepted' : 'rejected — wrong user name or password' });
        } catch (err) {
            steps.push({ target: `sign-in as ${options.username}`, ok: false, message: explain(err) });
        }
    }
    const ok = steps.every((s) => s.ok);
    return { ok, message: ok ? 'WebDAV server reachable' : 'WebDAV check failed', steps };
}

const CHECKS: Record<CheckName, (values: Values, options: CheckOptions) => Promise<CheckResult>> = {
    database: checkDatabase,
    redis: checkRedis,
    ldap: checkLdap,
    oidc: checkOidc,
    saml: (values, options) => checkSaml(options.root ?? process.cwd(), values, options.files?.samlIdp, options.timeoutMs),
    webdav: checkWebdav,
};

export const CHECK_NAMES = Object.keys(CHECKS) as CheckName[];

/** Run one connection test against the given values */
export async function runCheck(name: CheckName, values: Values, options: CheckOptions = {}): Promise<CheckResult> {
    const check = CHECKS[name];
    if (!check) return { ok: false, message: `Unknown check "${name}"` };
    try {
        return await check(values, options);
    } catch (err) {
        return { ok: false, message: explain(err) };
    }
}
