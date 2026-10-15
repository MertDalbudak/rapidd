import { withPostgres, explain } from './checks';
import { detectProvider } from '../core/adapter';
import type { ModelOverview } from './models';
import type { Values } from './catalog';

/**
 * Row-level security in PostgreSQL for the wizard: what the database enforces today (RLS
 * on/forced per table, policies, whether the API's role skips them), and policies built
 * from a structured description — the SQL is always generated here from names checked
 * against the schema, never taken from the browser.
 */

export interface RlsPolicy {
    name: string;
    command: string;
    permissive: boolean;
    roles: string[];
    using: string | null;
    check: string | null;
}

export interface RlsTable {
    model: string;
    table: string;
    exists: boolean;
    enabled: boolean;
    forced: boolean;
    owner: string | null;
    policies: RlsPolicy[];
}

export interface DbRole {
    user: string;
    superuser: boolean;
    bypassrls: boolean;
}

export interface RlsStatus {
    provider: string;
    /** PostgreSQL only — MySQL and MariaDB have no row-level security */
    supported: boolean;
    /** Whether the API sets the variables (RLS_ENABLED; default: on for PostgreSQL) */
    active: boolean;
    namespace: string;
    schema: string | null;
    connection: DbRole | null;
    /** The role of DATABASE_URL_ADMIN (sign-in queries); null when it is not set */
    admin: (DbRole & { error?: string }) | null;
    tables: RlsTable[];
    warnings: string[];
    error?: string;
}

export type PolicyCommand = 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface PolicySpec {
    model: string;
    /** Default: <table>_<command>_<variables> */
    name?: string;
    command: PolicyCommand;
    /** Rows whose field equals the variable (text comparison) */
    match: { field: string; variable: string }[];
    /** All conditions (default) or any of them */
    combine?: 'AND' | 'OR';
    /** Every row when this variable has this value — e.g. current_user_is_admin = true */
    bypass?: { variable: string; value: string } | null;
    /** Also turn RLS on for the table (default true) */
    enable?: boolean;
    /** Also FORCE it, so the policies bind the table owner too */
    force?: boolean;
}

export type RlsOperation =
    | { op: 'create'; policy: PolicySpec }
    | { op: 'drop'; model: string; name: string }
    | { op: 'enable' | 'disable' | 'force' | 'noforce'; model: string };

const COMMANDS: PolicyCommand[] = ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BYPASS_VALUE = /^[\w .@:-]{1,100}$/;

export class RlsSpecError extends Error {}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** RLS_ENABLED as the API reads it: PostgreSQL only, on unless false */
export function rlsActive(values: Values): boolean {
    return detectProvider(values.DATABASE_URL || '') === 'postgresql' && values.RLS_ENABLED !== 'false';
}

export function rlsNamespace(values: Values): string {
    return values.RLS_NAMESPACE || 'app';
}

function schemaOf(url: string): string {
    try {
        return new URL(url).searchParams.get('schema') || 'public';
    } catch {
        return 'public';
    }
}

const ROLE_SQL = 'SELECT current_user AS user, rolsuper AS superuser, rolbypassrls AS bypassrls FROM pg_roles WHERE rolname = current_user';

/** Introspect the database: RLS per table of the schema, policies, and the roles the API uses */
export async function rlsStatus(values: Values, models: ModelOverview[], userModel: string | null = null): Promise<RlsStatus> {
    const url = values.DATABASE_URL || '';
    const provider = detectProvider(url);
    const status: RlsStatus = {
        provider, supported: provider === 'postgresql', active: rlsActive(values), namespace: rlsNamespace(values),
        schema: null, connection: null, admin: null, tables: [], warnings: [],
    };
    if (!url) return { ...status, error: 'Set the database connection first' };
    if (!status.supported) return status;
    status.schema = schemaOf(url);

    try {
        await withPostgres(url, async (client, schema) => {
            status.connection = (await client.query(ROLE_SQL)).rows[0] ?? null;
            const { rows: tables } = await client.query(
                `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner
                   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')`, [schema]);
            const { rows: policies } = await client.query(
                `SELECT tablename AS table, policyname AS name, permissive, roles::text[] AS roles, cmd AS command, qual AS using, with_check AS check
                   FROM pg_policies WHERE schemaname = $1 ORDER BY tablename, policyname`, [schema]);
            status.tables = models.map((m) => {
                const t = tables.find((row: any) => row.table === m.table);
                return {
                    model: m.name, table: m.table, exists: !!t, enabled: !!t?.enabled, forced: !!t?.forced, owner: t?.owner ?? null,
                    policies: policies.filter((p: any) => p.table === m.table).map((p: any) => ({
                        name: p.name, command: p.command, permissive: p.permissive === 'PERMISSIVE', roles: p.roles ?? [], using: p.using, check: p.check,
                    })),
                };
            });
        });
    } catch (err) {
        return { ...status, error: explain(err) };
    }

    if (values.DATABASE_URL_ADMIN && values.DATABASE_URL_ADMIN !== url) {
        try {
            status.admin = await withPostgres(values.DATABASE_URL_ADMIN, async (client) => (await client.query(ROLE_SQL)).rows[0]);
        } catch (err) {
            status.admin = { user: '?', superuser: false, bypassrls: false, error: explain(err) };
        }
    }
    status.warnings = rlsWarnings(status, userModel);
    return status;
}

/** What keeps the policies from protecting the data — or the API from working */
export function rlsWarnings(status: RlsStatus, userModel: string | null): string[] {
    const warnings: string[] = [];
    const protectedTables = status.tables.filter((t) => t.enabled);
    const role = status.connection;
    if (role?.superuser) warnings.push(`The API connects as ${role.user}, a superuser — PostgreSQL applies no policy to it. Connect the API (DATABASE_URL) as a regular role.`);
    else if (role?.bypassrls) warnings.push(`The API connects as ${role.user}, which has BYPASSRLS — no policy applies to it. Connect the API (DATABASE_URL) as a role without it.`);
    else if (role) {
        const owned = protectedTables.filter((t) => !t.forced && t.owner === role.user).map((t) => t.table);
        if (owned.length) warnings.push(`The API's role ${role.user} owns ${owned.join(', ')} — owners skip policies unless the table FORCEs row-level security.`);
    }
    if (!status.active && protectedTables.some((t) => t.policies.length > 0)) {
        warnings.push('RLS_ENABLED is off: the API sets no variables, so policies that read them hide every row from it.');
    }
    const noPolicy = protectedTables.filter((t) => t.policies.length === 0).map((t) => t.table);
    if (noPolicy.length) warnings.push(`Row-level security is on without a policy for ${noPolicy.join(', ')} — no row is visible to roles it binds.`);
    const userTable = status.tables.find((t) => t.model === userModel);
    if (userTable?.enabled && role && !role.superuser && !role.bypassrls) {
        const admin = status.admin;
        const adminBypasses = admin && !admin.error && (admin.superuser || admin.bypassrls || (admin.user === userTable.owner && !userTable.forced));
        if (!adminBypasses) {
            warnings.push(`Sign-in reads ${userTable.table} before any variable is set — set DATABASE_URL_ADMIN to a role that bypasses its policies (its owner without FORCE, or a role with BYPASSRLS).`);
        }
    }
    return warnings;
}

function modelOf(models: ModelOverview[], name: string): ModelOverview {
    const model = models.find((m) => m.name === name);
    if (!model) throw new RlsSpecError(`Unknown model: ${name}`);
    return model;
}

const variable = (name: string) => {
    if (!IDENTIFIER.test(name)) throw new RlsSpecError(`Variable names use letters, digits and _ (${name})`);
    return name;
};

/** The SQL of an operation — generated from schema names only */
export function rlsStatements(operation: RlsOperation, models: ModelOverview[], values: Values): string[] {
    const schema = schemaOf(values.DATABASE_URL || '');
    const namespace = rlsNamespace(values);
    if (!IDENTIFIER.test(namespace)) throw new RlsSpecError('RLS_NAMESPACE uses letters, digits and _');
    const setting = (name: string) => `current_setting(${literal(`${namespace}.${variable(name)}`)}, true)`;

    if (operation.op === 'create') {
        const spec = operation.policy;
        const model = modelOf(models, spec.model);
        const table = `${quote(schema)}.${quote(model.table)}`;
        if (!COMMANDS.includes(spec.command)) throw new RlsSpecError(`Command: one of ${COMMANDS.join(', ')}`);
        const match = spec.match ?? [];
        if (match.length === 0 && !spec.bypass) throw new RlsSpecError('Add a condition — or rows for a variable value');
        const conditions = match.map(({ field, variable: v }) => {
            const column = model.fields.find((f) => f.name === field);
            if (!column || column.isList) throw new RlsSpecError(`${model.name} has no column ${field}`);
            return `${quote(column.column)}::text = ${setting(v)}`;
        });
        let expression = conditions.join(spec.combine === 'OR' ? ' OR ' : ' AND ');
        if (spec.bypass) {
            if (!BYPASS_VALUE.test(spec.bypass.value ?? '')) throw new RlsSpecError('The value uses letters, digits, spaces and . @ : - _');
            const bypass = `${setting(spec.bypass.variable)} = ${literal(spec.bypass.value)}`;
            expression = conditions.length ? `(${expression}) OR ${bypass}` : bypass;
        }
        const name = spec.name?.trim()
            || `${model.table}_${spec.command.toLowerCase()}_${[...match.map((m) => m.variable), ...(spec.bypass ? [spec.bypass.value] : [])].join('_')}`
                .replace(/[^A-Za-z0-9_]/g, '_').slice(0, 63);
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new RlsSpecError('Policy names use letters, digits and _ (63 at most)');
        const statements: string[] = [];
        if (spec.enable !== false) statements.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
        if (spec.force) statements.push(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
        const clauses = [`CREATE POLICY ${quote(name)} ON ${table}`, `    FOR ${spec.command}`];
        if (spec.command !== 'INSERT') clauses.push(`    USING (${expression})`);
        if (['ALL', 'INSERT', 'UPDATE'].includes(spec.command)) clauses.push(`    WITH CHECK (${expression})`);
        statements.push(`${clauses.join('\n')};`);
        return statements;
    }

    const model = modelOf(models, operation.model);
    const table = `${quote(schema)}.${quote(model.table)}`;
    switch (operation.op) {
        case 'drop':
            if (!operation.name) throw new RlsSpecError('Which policy?');
            return [`DROP POLICY ${quote(operation.name)} ON ${table};`];
        case 'enable': return [`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`];
        case 'disable': return [`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`];
        case 'force': return [`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`];
        case 'noforce': return [`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`];
        default: throw new RlsSpecError('Unknown operation');
    }
}

/**
 * Run the statements in one transaction — with DATABASE_URL_ADMIN when set (changing a
 * table's security needs its owner), else DATABASE_URL.
 */
export async function applyRls(statements: string[], values: Values): Promise<{ ok: boolean; message: string }> {
    const url = values.DATABASE_URL_ADMIN || values.DATABASE_URL;
    if (!url) return { ok: false, message: 'Set the database connection first' };
    if (detectProvider(url) !== 'postgresql') return { ok: false, message: 'Row-level security needs PostgreSQL' };
    try {
        await withPostgres(url, async (client) => {
            await client.query('BEGIN');
            try {
                for (const sql of statements) await client.query(sql);
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK').catch(() => undefined);
                throw err;
            }
        });
        return { ok: true, message: `Applied ${statements.length} statement${statements.length === 1 ? '' : 's'}` };
    } catch (err) {
        return { ok: false, message: explain(err) };
    }
}
