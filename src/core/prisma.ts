import { AsyncLocalStorage } from 'async_hooks';
import path from 'path';
import type { RLSVariables, DatabaseProvider, AclConfig } from '../types';
import * as dmmf from './dmmf';
import { Logger } from '../utils/Logger';
import { applyAclDefault } from './acl';
import { createAdapter } from './adapter';

export { createAdapter };

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

/** RLS namespace: variables are set as <namespace>.<name> */
const RLS_NAMESPACE = validateIdentifier(process.env.RLS_NAMESPACE || 'app', 'RLS_NAMESPACE');

// =====================================================
// BASE PRISMA CLIENTS
// =====================================================

const authConnection = createAdapter(process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL || '');
const baseConnection = createAdapter(process.env.DATABASE_URL || '');

export const dbProvider: DatabaseProvider = baseConnection.provider;

/**
 * Whether the API sets the RLS variables: PostgreSQL only, unless RLS_ENABLED=false. MySQL and
 * MariaDB have no row-level security — RLS_ENABLED does nothing there.
 */
export const rlsEnabled: boolean = dbProvider === 'postgresql' && process.env.RLS_ENABLED !== 'false';
if (dbProvider === 'mysql' && process.env.RLS_ENABLED === 'true') {
    Logger.warn('RLS_ENABLED=true has no effect: MySQL and MariaDB have no row-level security — restrict rows in src/config/acl.ts');
}

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
    // set_config(..., true) is transaction-local — equivalent to SET LOCAL, but batchable
    const calls = entries.map(([name, value]) =>
        `set_config('${RLS_NAMESPACE}.${validateIdentifier(name, name)}', '${sanitizeRLSValue(value)}', true)`);
    await tx.$queryRawUnsafe(`SELECT ${calls.join(', ')}`);
}

export async function resetRLSVariables(tx: any, variables: RLSVariables): Promise<void> {
    const names = Object.keys(variables);
    if (names.length === 0) return;

    try {
        // Custom GUCs default to '' — set_config(..., '', false) matches RESET, batchable
        const calls = names.map((name) => `set_config('${RLS_NAMESPACE}.${validateIdentifier(name, name)}', '', false)`);
        await tx.$queryRawUnsafe(`SELECT ${calls.join(', ')}`);
    } catch {
        // Ignore errors on reset
    }
}

/** Run with the request's RLS variables set — transaction-local, gone when it ends */
async function withRLSVariables<T>(tx: any, variables: RLSVariables, run: () => Promise<T>): Promise<T> {
    await setRLSVariables(tx, variables);
    return run();
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
                    return basePrisma.$transaction((tx: any) => withRLSVariables(tx, variables, () => query(args)));
                }

                return basePrisma.$transaction((tx: any) => withRLSVariables(tx, variables,
                    () => (model ? tx[model][operation](args) : tx[operation](args))));
            },
        },
    })
    : basePrisma;

/** Whether this request's queries carry RLS variables (each query then runs in its own transaction) */
export function rlsActive(): boolean {
    if (!rlsEnabled) return false;
    const variables = requestContext.getStore()?.variables;
    return !!variables && Object.keys(variables).length > 0;
}

// =====================================================
// TRANSACTION HELPERS
// =====================================================

export async function prismaTransaction(
    callback: ((tx: any) => Promise<any>) | Array<(tx: any) => Promise<any>>,
    options?: { timeout?: number }
): Promise<any> {
    const context = requestContext.getStore();

    return basePrisma.$transaction(async (tx: any) => {
        const run = async () => Array.isArray(callback)
            ? Promise.all(callback.map((fn: (tx: any) => Promise<any>) => fn(tx)))
            : callback(tx);
        const variables = context?.variables;
        if (rlsEnabled && variables && Object.keys(variables).length > 0) {
            return withRLSVariables(tx, variables, run);
        }
        return run();
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
        let code: AclConfig = { model: {} };
        let file: string | null = null;
        try {
            file = require.resolve('../config/acl');
        } catch {
            // No acl.ts — may be intentional (internal services); every model is then unrestricted
            Logger.warn('No src/config/acl.ts — ALL models are unrestricted. Add access control there, or set ACL_DEFAULT=deny.');
        }
        if (file) {
            // A broken acl.ts (syntax error, bad import) stops the API instead of dropping its rules
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const mod = require(file);
                code = mod.default || mod;
            } catch (error: any) {
                throw new Error(`src/config/acl failed to load — the API does not start without its access control: ${error?.message || error}`);
            }
        }
        // ACL_DEFAULT=deny closes every model without an entry
        _acl = applyAclDefault(code);
    }
    return _acl!;
}

export { PrismaClient, Prisma, dmmf };
