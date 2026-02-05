import { AsyncLocalStorage } from 'async_hooks';
import path from 'path';
import type { RLSContext, RLSConfig, DatabaseProvider, AdapterResult, AclConfig } from '../types';
import * as dmmf from './dmmf';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient, Prisma } = require(path.join(process.cwd(), 'prisma', 'client'));

/** Request context storage for async operations */
export const requestContext = new AsyncLocalStorage<RLSContext>();

/** RLS configuration from environment variables */
const RLS_CONFIG: RLSConfig = {
    namespace: process.env.RLS_NAMESPACE || 'app',
    userId: process.env.RLS_USER_ID || 'current_user_id',
    userRole: process.env.RLS_USER_ROLE || 'current_user_role',
};

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

export async function setRLSVariables(tx: any, userId: string | number, userRole: string): Promise<void> {
    const { namespace, userId: userIdVar, userRole: userRoleVar } = RLS_CONFIG;
    const safeUserId = sanitizeRLSValue(userId);
    const safeUserRole = sanitizeRLSValue(userRole);

    if (dbProvider === 'mysql') {
        await tx.$executeRawUnsafe(`SET @${namespace}_${userIdVar} = '${safeUserId}'`);
        await tx.$executeRawUnsafe(`SET @${namespace}_${userRoleVar} = '${safeUserRole}'`);
    } else {
        await tx.$executeRawUnsafe(`SET LOCAL ${namespace}.${userIdVar} = '${safeUserId}'`);
        await tx.$executeRawUnsafe(`SET LOCAL ${namespace}.${userRoleVar} = '${safeUserRole}'`);
    }
}

export async function resetRLSVariables(tx: any): Promise<void> {
    const { namespace, userId: userIdVar, userRole: userRoleVar } = RLS_CONFIG;
    try {
        if (dbProvider === 'mysql') {
            await tx.$executeRawUnsafe(`SET @${namespace}_${userIdVar} = NULL`);
            await tx.$executeRawUnsafe(`SET @${namespace}_${userRoleVar} = NULL`);
        } else {
            await tx.$executeRawUnsafe(`RESET ${namespace}.${userIdVar}`);
            await tx.$executeRawUnsafe(`RESET ${namespace}.${userRoleVar}`);
        }
    } catch {
        // Ignore errors on reset
    }
}

// =====================================================
// EXTENDED PRISMA WITH AUTOMATIC RLS
// =====================================================

export const prisma = basePrisma.$extends({
    query: {
        async $allOperations({ operation, args, query, model }: any) {
            const context = requestContext.getStore();

            if (!context?.userId || !context?.userRole) {
                return query(args);
            }

            const { userId, userRole } = context;

            if (operation === '$transaction') {
                return basePrisma.$transaction(async (tx: any) => {
                    await setRLSVariables(tx, userId, userRole);
                    return query(args);
                });
            }

            return basePrisma.$transaction(async (tx: any) => {
                await setRLSVariables(tx, userId, userRole);

                if (model) {
                    return tx[model][operation](args);
                } else {
                    return tx[operation](args);
                }
            });
        },
    },
});

// =====================================================
// TRANSACTION HELPERS
// =====================================================

export async function prismaTransaction(
    callback: ((tx: any) => Promise<any>) | Array<(tx: any) => Promise<any>>,
    options?: { timeout?: number }
): Promise<any> {
    const context = requestContext.getStore();

    return basePrisma.$transaction(async (tx: any) => {
        if (context?.userId && context?.userRole) {
            await setRLSVariables(tx, context.userId, context.userRole);
        }

        if (Array.isArray(callback)) {
            return await Promise.all(callback.map((fn: (tx: any) => Promise<any>) => fn(tx)));
        }
        return await callback(tx);
    }, options);
}

// =====================================================
// CONTEXT HELPERS
// =====================================================

export function getRLSConfig(): RLSConfig {
    return RLS_CONFIG;
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
        } catch {
            _acl = { model: {} };
        }
    }
    return _acl!;
}

export { PrismaClient, Prisma, dmmf };
