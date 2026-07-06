import { AsyncLocalStorage } from 'async_hooks';
import path from 'path';
import type { RLSVariables, DatabaseProvider, AdapterResult, AclConfig } from '../types';
import * as dmmf from './dmmf';
import { Logger } from '../utils/Logger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient, Prisma } = require(path.join(process.cwd(), 'prisma', 'client'));

/** Request context storage for RLS variables across async operations */
export const requestContext = new AsyncLocalStorage<{ variables: RLSVariables }>();

/** Validates that an RLS identifier contains only safe characters (letters, digits, underscores) */
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function validateIdentifier(value: string, name: string): string {
    if (!IDENTIFIER_RE.test(value)) {
        throw new Error(`[RLS] Invalid identifier for ${name}: "${value}". Only letters, numbers, and underscores allowed.`);
    }
    return value;
}

/** RLS namespace for SQL session variable prefix */
const RLS_NAMESPACE = validateIdentifier(process.env.RLS_NAMESPACE || 'app', 'RLS_NAMESPACE');

// =====================================================
// DATABASE ADAPTER FACTORY
// =====================================================

function detectProvider(connectionString: string): DatabaseProvider {
    if (!connectionString) return 'postgresql';
    if (connectionString.startsWith('mysql://') || connectionString.startsWith('mariadb://')) {
        return 'mysql';
    }
    return 'postgresql';
}

function parseMySQLConnectionString(connectionString: string): Record<string, unknown> {
    const url = new URL(connectionString);
    return {
        host: url.hostname,
        port: parseInt(url.port, 10) || 3306,
        user: url.username,
        password: url.password,
        database: url.pathname.slice(1),
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

// =====================================================
// BASE PRISMA CLIENTS
// =====================================================

const authConnection = createAdapter(process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL || '');
const baseConnection = createAdapter(process.env.DATABASE_URL || '');

export const dbProvider: DatabaseProvider = baseConnection.provider;

/** Whether RLS is enabled. Auto: true for PostgreSQL, false for MySQL. Override with RLS_ENABLED env var. */
export const rlsEnabled: boolean = process.env.RLS_ENABLED !== undefined
    ? process.env.RLS_ENABLED === 'true'
    : dbProvider === 'postgresql';

export const authPrisma = new PrismaClient({
    adapter: authConnection.adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

const basePrisma = new PrismaClient({
    adapter: baseConnection.adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

// =====================================================
// RLS HELPER FUNCTIONS
// =====================================================

function sanitizeRLSValue(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return '';
    return String(value).replace(/'/g, "''");
}

export async function setRLSVariables(tx: any, variables: RLSVariables): Promise<void> {
    const entries = Object.entries(variables).filter(([, value]) => value !== null && value !== undefined);
    if (entries.length === 0) return;

    // Batch all variables into ONE statement — RLS wraps every Prisma operation in a
    // transaction, so each extra round trip here is paid on every single query.
    if (dbProvider === 'mysql') {
        const assignments = entries.map(([name, value]) =>
            `@${RLS_NAMESPACE}_${validateIdentifier(name, name)} = '${sanitizeRLSValue(value)}'`);
        await tx.$executeRawUnsafe(`SET ${assignments.join(', ')}`);
    } else {
        // set_config(..., true) is transaction-local — equivalent to SET LOCAL, but batchable
        const calls = entries.map(([name, value]) =>
            `set_config('${RLS_NAMESPACE}.${validateIdentifier(name, name)}', '${sanitizeRLSValue(value)}', true)`);
        await tx.$queryRawUnsafe(`SELECT ${calls.join(', ')}`);
    }
}

export async function resetRLSVariables(tx: any, variables: RLSVariables): Promise<void> {
    const names = Object.keys(variables);
    if (names.length === 0) return;

    try {
        if (dbProvider === 'mysql') {
            const assignments = names.map((name) => `@${RLS_NAMESPACE}_${validateIdentifier(name, name)} = NULL`);
            await tx.$executeRawUnsafe(`SET ${assignments.join(', ')}`);
        } else {
            // Custom GUCs default to '' — set_config(..., '', false) matches RESET, batchable
            const calls = names.map((name) => `set_config('${RLS_NAMESPACE}.${validateIdentifier(name, name)}', '', false)`);
            await tx.$queryRawUnsafe(`SELECT ${calls.join(', ')}`);
        }
    } catch {
        // Ignore errors on reset
    }
}

// =====================================================
// EXTENDED PRISMA WITH AUTOMATIC RLS
// =====================================================

export const prisma = rlsEnabled
    ? basePrisma.$extends({
        query: {
            async $allOperations({ operation, args, query, model }: any) {
                const context = requestContext.getStore();
                const variables = context?.variables;

                if (!variables || Object.keys(variables).length === 0) {
                    return query(args);
                }

                if (operation === '$transaction') {
                    return basePrisma.$transaction(async (tx: any) => {
                        await setRLSVariables(tx, variables);
                        return query(args);
                    });
                }

                return basePrisma.$transaction(async (tx: any) => {
                    await setRLSVariables(tx, variables);

                    if (model) {
                        return tx[model][operation](args);
                    } else {
                        return tx[operation](args);
                    }
                });
            },
        },
    })
    : basePrisma;

// =====================================================
// TRANSACTION HELPERS
// =====================================================

export async function prismaTransaction(
    callback: ((tx: any) => Promise<any>) | Array<(tx: any) => Promise<any>>,
    options?: { timeout?: number }
): Promise<any> {
    const context = requestContext.getStore();

    return basePrisma.$transaction(async (tx: any) => {
        const variables = context?.variables;
        if (rlsEnabled && variables && Object.keys(variables).length > 0) {
            await setRLSVariables(tx, variables);
        }

        if (Array.isArray(callback)) {
            return await Promise.all(callback.map((fn: (tx: any) => Promise<any>) => fn(tx)));
        }
        return await callback(tx);
    }, options);
}

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

export async function disconnectAll(): Promise<void> {
    await authPrisma.$disconnect();
    await basePrisma.$disconnect();
    if (authConnection.pool && typeof (authConnection.pool as any).end === 'function') {
        await (authConnection.pool as any).end();
    }
    if (baseConnection.pool && typeof (baseConnection.pool as any).end === 'function') {
        await (baseConnection.pool as any).end();
    }
}

process.on('beforeExit', async () => {
    await disconnectAll();
});

// =====================================================
// INITIALIZATION
// =====================================================

export async function initializeDMMF(): Promise<any> {
    return dmmf.loadDMMF();
}

// Auto-initialize DMMF on module load
initializeDMMF();

// =====================================================
// LAZY ACL & MIDDLEWARE
// =====================================================

let _acl: AclConfig | null = null;
export function getAcl(): AclConfig {
    if (!_acl) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            _acl = require('../config/acl').default || require('../config/acl');
        } catch (error: any) {
            // ACL is FAIL-OPEN: an empty config grants unrestricted access to every model.
            // A missing config may be intentional (internal services), but a broken one
            // (syntax error, bad import) must be loud — otherwise a typo silently
            // disables all access control.
            _acl = { model: {} };
            if (error?.code === 'MODULE_NOT_FOUND') {
                Logger.warn('No ACL config found (src/config/acl) — ALL models are unrestricted. Add an acl.ts to enable access control.');
            } else {
                Logger.error(`ACL config failed to load — falling back to UNRESTRICTED access for all models: ${error?.message || error}`);
            }
        }
    }
    return _acl!;
}

export { PrismaClient, Prisma, dmmf };
