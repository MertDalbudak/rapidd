import fs from 'fs';
import os from 'os';
import path from 'path';
import { withPostgres, withMySQL, explain } from './checks';
import { readSchema, describeUserModel } from './project';
import type { UserModelInfo } from './project';
import { runAction, runPrisma } from './actions';
import type { ActionResult } from './actions';
import { writeSchema, SchemaEditError } from './schema';
import { loadCodeAcl } from './models';
import { listItems } from './catalog';
import type { Values } from './catalog';
import { linkFromEnv } from '../auth/identity';
import { detectProvider } from '../core/adapter';
import type { AclConfig, DMMF, DMMFField } from '../types';

/**
 * Indexes for the lookups the API makes — without one, each reads the whole table:
 * - foreign keys: includes, nested routes and filters find rows by them, and deleting a row
 *   checks the rows that reference it. PostgreSQL does not index them by itself; MySQL does,
 *   unless relationMode = "prisma" leaves the foreign keys out;
 * - the columns src/config/acl.ts filters every read by;
 * - sign-in: the user table's identifier columns, and the column external identities link by.
 *
 * A lookup counts as served when an index of the schema or of the database starts with its
 * columns. The SQL is Prisma's own (prisma migrate diff), under Prisma's index names, so the
 * schema, the migrations and the database stay in step.
 */

export type IndexReasonKind = 'foreign-key' | 'access' | 'sign-in' | 'schema';

export interface IndexReason {
    kind: IndexReasonKind;
    text: string;
}

/** An index of the database — usable when it serves lookups by its first columns (valid, complete, B-tree or single-column hash) */
export interface DbIndex {
    table: string;
    name: string;
    columns: string[];
    usable: boolean;
}

export interface DbTable {
    table: string;
    /** Estimated from the database's statistics */
    rows: number | null;
    /** Full-table reads since the statistics were reset (PostgreSQL) */
    seqScans: number | null;
}

export interface DbIndexes {
    tables: DbTable[];
    indexes: DbIndex[];
}

/** A lookup by these columns of a model */
export interface Lookup {
    model: string;
    fields: string[];
    reasons: IndexReason[];
}

export interface IndexSuggestion {
    /** <model>:<field>,<field> */
    id: string;
    model: string;
    table: string;
    fields: string[];
    columns: string[];
    reasons: IndexReason[];
    /** missing: neither the schema nor the database has it — schema: the schema lists it, the database lacks it */
    source: 'missing' | 'schema';
    rows: number | null;
    seqScans: number | null;
    impact: 'high' | 'medium' | 'low';
    /** Prisma's name and SQL for it (prisma migrate diff) */
    name?: string;
    statement?: string;
    /** Why it cannot be added */
    problem?: string;
}

export interface IndexAnalysis {
    provider: 'postgresql' | 'mysql' | null;
    /** migration: a new migration in prisma/migrations, deployed — database: built directly */
    via: 'migration' | 'database';
    database: { checked: boolean; error?: string };
    suggestions: IndexSuggestion[];
    notes: string[];
    error?: string;
}

// ── Lookups ─────────────────────────────────────────────────────────────

/** Columns worth an index of their own: not flags, enums, JSON, bytes or lists — too few distinct values, or none a B-tree orders */
function indexable(field: DMMFField): boolean {
    return field.kind === 'scalar' && !field.isList && !['Boolean', 'Json', 'Bytes'].includes(field.type);
}

/** Some index starts with these columns, in any order */
export function covers(indexes: string[][], wanted: string[]): boolean {
    return wanted.length > 0 && indexes.some((columns) => columns.length >= wanted.length && wanted.every((w) => columns.slice(0, wanted.length).includes(w)));
}

export interface LookupOptions {
    provider: string;
    relationMode: 'foreignKeys' | 'prisma';
    /** Per model: the fields src/config/acl.ts filters every read by */
    access?: Record<string, string[]>;
    signIn?: { model: string; field: string; text: string }[];
}

/** The lookups the API makes by columns — one per set of columns */
export function lookups(dmmf: DMMF, options: LookupOptions): Lookup[] {
    const found: Lookup[] = [];
    const add = (model: string, fields: string[], reason: IndexReason) => {
        const same = found.find((l) => l.model === model && l.fields.length === fields.length && l.fields.every((f) => fields.includes(f)));
        if (!same) found.push({ model, fields: [...fields], reasons: [reason] });
        else if (!same.reasons.some((r) => r.text === reason.text)) same.reasons.push(reason);
    };
    // MySQL indexes a foreign key's columns itself (InnoDB requires it)
    const foreignKeys = options.provider === 'postgresql' || options.relationMode === 'prisma';
    for (const model of dmmf.datamodel.models) {
        const field = (name: string) => model.fields.find((f) => f.name === name);
        if (foreignKeys) {
            for (const relation of model.fields) {
                const from = relation.relationFromFields ?? [];
                if (relation.kind !== 'object' || from.length === 0) continue;
                add(model.name, from, { kind: 'foreign-key', text: `References ${relation.type}: includes and nested routes find rows by it, and so does each delete in ${relation.type}` });
            }
        }
        for (const name of options.access?.[model.name] ?? []) {
            const f = field(name);
            if (f && indexable(f)) add(model.name, [name], { kind: 'access', text: 'src/config/acl.ts filters every read by it' });
        }
        for (const lookup of options.signIn ?? []) {
            const f = lookup.model === model.name ? field(lookup.field) : undefined;
            if (f && indexable(f)) add(model.name, [lookup.field], { kind: 'sign-in', text: lookup.text });
        }
    }
    return found.sort((a, b) => b.fields.length - a.fields.length);
}

/**
 * The fields src/config/acl.ts filters every read of a model by: getAccessFilter asked for a
 * regular user — the user table's columns with placeholder values, flags off
 */
export function accessFilterFields(acl: AclConfig, dmmf: DMMF, user: Record<string, unknown>): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const model of dmmf.datamodel.models) {
        const hook = (acl.model as Record<string, { getAccessFilter?: (user: any) => unknown }> | undefined)?.[model.name]?.getAccessFilter;
        if (typeof hook !== 'function') continue;
        let filter: unknown;
        try {
            filter = hook(user);
        } catch {
            // A hook that needs attributes this user lacks — its filter stays unknown
            continue;
        }
        const scalars = new Set(model.fields.filter((f) => f.kind !== 'object').map((f) => f.name));
        const fields = new Set<string>();
        filterColumns(filter, scalars, fields, 0);
        if (fields.size) out[model.name] = [...fields];
    }
    return out;
}

/** The model's own columns a Prisma where compares — through AND and OR (a NOT rarely uses an index) */
function filterColumns(where: unknown, scalars: Set<string>, out: Set<string>, depth: number): void {
    if (!where || typeof where !== 'object' || depth > 6) return;
    for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
        if (key === 'AND' || key === 'OR') {
            for (const item of Array.isArray(value) ? value : [value]) filterColumns(item, scalars, out, depth + 1);
        } else if (scalars.has(key)) {
            out.add(key);
        }
    }
}

/** A signed-in user to ask acl.ts with: the user table's columns with placeholder values, flags off */
export function sampleUser(dmmf: DMMF, userModel: string | null): Record<string, unknown> {
    const user: Record<string, unknown> = { groups: [], roles: [] };
    const enums = ((dmmf.datamodel as { enums?: { name: string; values: { name: string }[] }[] }).enums) ?? [];
    for (const f of dmmf.datamodel.models.find((m) => m.name === userModel)?.fields ?? []) {
        if (f.kind === 'object') continue;
        user[f.name] = f.isList ? []
            : f.kind === 'enum' ? enums.find((e) => e.name === f.type)?.values[0]?.name ?? null
            : f.type === 'Boolean' ? false
            : ['Int', 'BigInt', 'Float', 'Decimal'].includes(f.type) ? 1
            : f.type === 'DateTime' ? new Date(0)
            : f.type === 'Json' ? {}
            : 'x';
    }
    user.id = 1;
    return user;
}

/** Sign-in's lookups of the user table — password sign-in by its identifiers, external identities by the link column */
export function signInLookups(values: Values, user: UserModelInfo | null, provider: string): { lookups: { model: string; field: string; text: string }[]; notes: string[] } {
    const configured = listItems(values.AUTH_PROVIDERS);
    const providers = configured.length ? configured : ['local'];
    if (!user || providers.includes('none')) return { lookups: [], notes: [] };
    const found: { model: string; field: string; text: string }[] = [];
    const notes: string[] = [];
    if (providers.includes('local')) {
        for (const field of user.identifierFields) found.push({ model: user.model, field, text: 'Password sign-in finds users by it' });
    }
    const external = providers.filter((p) => p !== 'local');
    const link = linkFromEnv(values.AUTH_LINK) ?? { field: 'email', from: 'email' };
    if (external.length && link) {
        if (provider === 'postgresql' && link.from === 'email') {
            notes.push(`Sign-in through ${external.join(', ')} finds users by email case-insensitively — on PostgreSQL no plain index serves that`);
        } else {
            found.push({ model: user.model, field: link.field, text: `Sign-in through ${external.join(', ')} links accounts by it` });
        }
    }
    return { lookups: found, notes };
}

// ── Against the schema and the database ─────────────────────────────────

interface SchemaIndex {
    model: string;
    type: string;
    fields: { name: string }[];
    dbName?: string | null;
}

const sameName = (a: string, b: string) => a === b || a.toLowerCase() === b.toLowerCase();

function impact(table: DbTable | undefined): IndexSuggestion['impact'] {
    if (!table || table.rows === null) return 'medium';
    if (table.rows < 1_000) return 'low';
    if (table.rows >= 100_000 || (table.rows >= 10_000 && (table.seqScans ?? 0) >= 100)) return 'high';
    return 'medium';
}

/**
 * The lookups no index serves. With the database's indexes known, the database decides: an
 * index the schema lists but the database lacks is a suggestion of its own (source: schema).
 */
export function suggestIndexes(dmmf: DMMF, found: Lookup[], db: DbIndexes | null): IndexSuggestion[] {
    const schemaIndexes = (((dmmf.datamodel as { indexes?: SchemaIndex[] }).indexes) ?? []).filter((i) => i.type !== 'fulltext');
    const out: IndexSuggestion[] = [];
    for (const model of dmmf.datamodel.models) {
        const table = (model.dbName as string | null | undefined) || model.name;
        const dbTable = db?.tables.find((t) => sameName(t.table, table));
        // No such table — not created yet, or a view
        if (db && !dbTable) continue;
        const columnOf = (name: string) => (model.fields.find((f) => f.name === name)?.dbName as string | null | undefined) || name;
        const own = schemaIndexes.filter((i) => i.model === model.name);
        const inSchema = own.map((i) => i.fields.map((f) => f.name));
        const inDb = db ? db.indexes.filter((i) => i.usable && sameName(i.table, table)).map((i) => i.columns) : null;
        const lookupsHere = found.filter((l) => l.model === model.name);
        const base = { model: model.name, table, rows: dbTable?.rows ?? null, seqScans: dbTable?.seqScans ?? null, impact: impact(dbTable) };

        if (inDb) {
            for (const index of own.filter((i) => i.type === 'normal')) {
                const fields = index.fields.map((f) => f.name);
                if (covers(inDb, fields.map(columnOf))) continue;
                const served = lookupsHere.filter((l) => covers([fields], l.fields)).flatMap((l) => l.reasons);
                out.push({
                    ...base, id: `${model.name}:${fields.join(',')}`, fields, columns: fields.map(columnOf), source: 'schema',
                    reasons: [{ kind: 'schema', text: 'prisma/schema.prisma lists it — the database does not have it' }, ...served],
                });
            }
        }
        // The lookups no index serves — in the schema: in the database too, or suggested above
        const unserved = lookupsHere.filter((lookup) => !(inDb && covers(inDb, lookup.fields.map(columnOf))) && !covers(inSchema, lookup.fields));
        // One index for those that start alike: the wider serves the narrower (and takes its reasons)
        const merged: Lookup[] = [];
        for (const lookup of [...unserved].sort((a, b) => b.fields.length - a.fields.length)) {
            const wider = merged.find((m) => covers([m.fields], lookup.fields));
            if (!wider) merged.push({ ...lookup, reasons: [...lookup.reasons] });
            else for (const r of lookup.reasons) if (!wider.reasons.some((x) => x.text === r.text)) wider.reasons.push(r);
        }
        for (const lookup of merged) {
            out.push({ ...base, id: `${model.name}:${lookup.fields.join(',')}`, fields: lookup.fields, columns: lookup.fields.map(columnOf), source: 'missing', reasons: lookup.reasons });
        }
    }
    const rank = { high: 0, medium: 1, low: 2 };
    return out.sort((a, b) => rank[a.impact] - rank[b.impact] || (b.rows ?? 0) - (a.rows ?? 0) || a.model.localeCompare(b.model));
}

const PG_INDEXES = `
SELECT t.relname AS table, i.relname AS name, am.amname AS method, ix.indisvalid AS valid, ix.indpred IS NOT NULL AS partial,
       ix.indnkeyatts AS keys,
       ARRAY(SELECT COALESCE(a.attname::text, '')
               FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, n)
               LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
              ORDER BY k.n) AS columns
  FROM pg_index ix
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_am am ON am.oid = i.relam
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = $1`;

const PG_TABLES = `
SELECT c.relname AS table, c.reltuples::float8 AS estimate, s.n_live_tup::float8 AS live, s.seq_scan::float8 AS seq_scan
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')`;

/** The database's indexes and table sizes (PostgreSQL: the schema of ?schema=) */
export async function readDatabaseIndexes(url: string): Promise<DbIndexes> {
    if (detectProvider(url) === 'postgresql') {
        return withPostgres(url, async (client, schema) => {
            const { rows: indexes } = await client.query(PG_INDEXES, [schema]);
            const { rows: tables } = await client.query(PG_TABLES, [schema]);
            return {
                indexes: indexes.map((r: any) => {
                    // INCLUDE columns come after the key columns — they serve no lookup
                    const columns = (r.columns as string[]).slice(0, r.keys);
                    return { table: r.table, name: r.name, columns, usable: r.valid && !r.partial && (r.method === 'btree' || (r.method === 'hash' && columns.length === 1)) };
                }),
                tables: tables.map((r: any) => ({
                    table: r.table,
                    // reltuples is -1 (0 before PostgreSQL 14) until the table is first analyzed
                    rows: r.estimate > 0 ? Math.round(r.estimate) : r.live ?? (r.estimate === 0 ? 0 : null),
                    seqScans: r.seq_scan ?? null,
                })),
            };
        });
    }
    return withMySQL(url, async (conn) => {
        const parts: any[] = await conn.query(
            'SELECT TABLE_NAME AS t, INDEX_NAME AS name, COLUMN_NAME AS col, INDEX_TYPE AS type FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX');
        const tables: any[] = await conn.query(
            "SELECT TABLE_NAME AS t, TABLE_ROWS AS r FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
        const byName = new Map<string, DbIndex & { type: string }>();
        for (const p of parts) {
            const key = `${p.t}\u0000${p.name}`;
            let index = byName.get(key);
            if (!index) byName.set(key, index = { table: String(p.t), name: String(p.name), columns: [], usable: false, type: String(p.type).toUpperCase() });
            // A functional key part has no column
            index.columns.push(p.col == null ? '' : String(p.col));
        }
        return {
            indexes: [...byName.values()].map(({ type, ...index }) => ({ ...index, usable: type === 'BTREE' || (type === 'HASH' && index.columns.length === 1) })),
            tables: tables.map((r) => ({ table: String(r.t), rows: r.r == null ? null : Number(r.r), seqScans: null })),
        };
    });
}

// ── The schema text ─────────────────────────────────────────────────────

function modelBlock(lines: string[], model: string): { start: number; end: number } {
    const start = lines.findIndex((l) => new RegExp(`^\\s*model\\s+${model}\\s*\\{`).test(l));
    if (start === -1) throw new SchemaEditError(`prisma/schema.prisma has no model ${model}`);
    let end = start + 1;
    while (end < lines.length && !/^\s*\}/.test(lines[end])) end++;
    if (end >= lines.length) throw new SchemaEditError(`The model ${model} in prisma/schema.prisma is not closed`);
    return { start, end };
}

/** prisma/schema.prisma with these indexes in their models — @@index without a name, so Prisma names them */
export function schemaWithIndexes(source: string, additions: { model: string; fields: string[] }[]): string {
    const lines = source.split('\n');
    for (const { model, fields } of additions) {
        const { start, end } = modelBlock(lines, model);
        // Before @@map, @@schema and @@ignore, where Prisma writes indexes
        let at = end;
        for (let i = start + 1; i < end; i++) {
            if (/^\s*@@(map|schema|ignore)\b/.test(lines[i])) {
                at = i;
                break;
            }
        }
        const indent = /^\s*/.exec(lines.slice(start + 1, end).find((l) => l.trim()) ?? '')?.[0] || '  ';
        const insert = [`${indent}@@index([${fields.join(', ')}])`];
        // Block attributes follow the fields after an empty line
        const previous = lines[at - 1].trim();
        if (previous && !previous.startsWith('@@') && at - 1 !== start) insert.unshift('');
        lines.splice(at, 0, ...insert);
    }
    return lines.join('\n');
}

/** Split at commas outside parentheses: `a(sort: Desc, length: 10), b` → two */
function topLevel(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of text) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) parts.push(current);
    return parts.map((p) => p.trim()).filter(Boolean);
}

/** prisma/schema.prisma without these @@index lines — matched by their fields and map name */
export function schemaWithoutIndexes(source: string, removals: { model: string; fields: string[]; name?: string | null }[]): string {
    const lines = source.split('\n');
    for (const removal of removals) {
        const { start, end } = modelBlock(lines, removal.model);
        let found = -1;
        for (let i = start + 1; i < end && found === -1; i++) {
            const m = /^\s*@@index\(\s*(?:fields\s*:\s*)?\[([^\]]*)\](.*)$/.exec(lines[i]);
            if (!m) continue;
            const fields = topLevel(m[1]).map((f) => f.replace(/\(.*$/, '').trim());
            const map = /\bmap\s*:\s*"([^"]*)"/.exec(m[2])?.[1] ?? null;
            if (fields.join(',') === removal.fields.join(',') && map === (removal.name ?? null)) found = i;
        }
        if (found === -1) throw new SchemaEditError(`@@index([${removal.fields.join(', ')}]) of ${removal.model} is not on a line of its own in prisma/schema.prisma`);
        lines.splice(found, 1);
    }
    return lines.join('\n');
}

// ── SQL ─────────────────────────────────────────────────────────────────

/** The statements of a prisma migrate diff script — refused when it holds more than CREATE INDEX */
export function indexStatements(sql: string): string[] {
    const statements = sql.split(';')
        .map((s) => s.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n').trim())
        .filter(Boolean);
    const other = statements.find((s) => !/^CREATE INDEX\s/i.test(s));
    if (other) throw new Error(`prisma migrate diff wants more than indexes: ${other.split('\n')[0]}`);
    return statements.map((s) => `${s};`);
}

/** CREATE INDEX "name" ON "table"("a", "b" DESC) → name, table, columns */
export function parseCreateIndex(statement: string): { name: string; table: string; columns: string[] } | null {
    const m = /^CREATE INDEX\s+[`"]([^`"]+)[`"]\s+ON\s+(?:[`"][^`"]+[`"]\.)?[`"]([^`"]+)[`"]\s*\(([\s\S]*)\)\s*;?$/i.exec(statement.trim());
    if (!m) return null;
    return { name: m[1], table: m[2], columns: topLevel(m[3]).map((c) => /[`"]([^`"]+)[`"]/.exec(c)?.[1] ?? c) };
}

/** Prisma's SQL from one schema to another (no database involved) */
async function migrateDiff(root: string, values: Values, from: string, to: string): Promise<string[]> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-indexes-'));
    try {
        const fromFile = path.join(dir, 'from.prisma');
        const toFile = path.join(dir, 'to.prisma');
        const out = path.join(dir, 'diff.sql');
        fs.writeFileSync(fromFile, from);
        fs.writeFileSync(toFile, to);
        const { code, output } = await runPrisma(['migrate', 'diff', '--from-schema', fromFile, '--to-schema', toFile, '--script', '--output', out], values, root, 60_000);
        if (code !== 0 || !fs.existsSync(out)) throw new Error(output.trim().split('\n').slice(-6).join('\n') || `prisma migrate diff failed (exit ${code})`);
        return indexStatements(fs.readFileSync(out, 'utf8'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function relationModeOf(source: string): 'foreignKeys' | 'prisma' {
    const datasource = /datasource\s+\w+\s*\{[^}]*\}/.exec(source)?.[0] ?? '';
    return /relationMode\s*=\s*"prisma"/.test(datasource) ? 'prisma' : 'foreignKeys';
}

// ── The wizard's analysis and its action ────────────────────────────────

const schemaFile = (root: string) => path.join(root, 'prisma', 'schema.prisma');

/** What the wizard shows: the lookups without an index, each with Prisma's SQL for it */
export async function analyzeIndexes(root: string, values: Values): Promise<IndexAnalysis> {
    const via = fs.existsSync(path.join(root, 'prisma', 'migrations')) ? 'migration' : 'database';
    const result: IndexAnalysis = { provider: null, via, database: { checked: false }, suggestions: [], notes: [] };
    const schema = await readSchema(root);
    if (!schema.dmmf) return { ...result, error: schema.exists ? 'Fix the errors in prisma/schema.prisma first' : 'prisma/schema.prisma does not exist' };
    const dmmf = schema.dmmf;
    const provider = schema.provider === 'postgresql' || schema.provider === 'postgres' ? 'postgresql' : schema.provider === 'mysql' ? 'mysql' : null;
    if (!provider) return { ...result, error: 'Indexes are analyzed for PostgreSQL, MySQL and MariaDB' };
    result.provider = provider;
    const source = fs.readFileSync(schemaFile(root), 'utf8');
    const relationMode = relationModeOf(source);
    if (provider === 'mysql') {
        result.notes.push(relationMode === 'prisma'
            ? 'relationMode = "prisma": without foreign keys, MySQL does not index the relation columns'
            : 'MySQL indexes foreign keys by itself');
    }

    let db: DbIndexes | null = null;
    const url = values.DATABASE_URL;
    if (!url) {
        result.database = { checked: false, error: 'No database connection is set' };
    } else if (detectProvider(url) !== provider) {
        result.database = { checked: false, error: `The database is not ${provider === 'mysql' ? 'MySQL / MariaDB' : 'PostgreSQL'}, as prisma/schema.prisma says` };
    } else {
        try {
            db = await readDatabaseIndexes(url);
            result.database = { checked: true };
        } catch (err) {
            result.database = { checked: false, error: explain(err) };
        }
    }

    const userModel = describeUserModel(dmmf, values);
    const { acl, error: aclError } = loadCodeAcl(root);
    if (aclError) result.notes.push(`src/config/acl.ts did not load (${aclError}) — the columns it filters by are not considered`);
    const access = acl ? accessFilterFields(acl, dmmf, sampleUser(dmmf, userModel?.model ?? null)) : {};
    const signIn = signInLookups(values, userModel, provider);
    result.notes.push(...signIn.notes);

    let suggestions = suggestIndexes(dmmf, lookups(dmmf, { provider, relationMode, access, signIn: signIn.lookups }), db);
    if (db) {
        const absent = dmmf.datamodel.models.filter((m) => !db!.tables.some((t) => sameName(t.table, (m.dbName as string | null | undefined) || m.name))).map((m) => m.name);
        if (absent.length) result.notes.push(`No table in the database for ${absent.join(', ')} — not analyzed`);
    }
    // With migrations, what the schema lists comes with them
    const behind = suggestions.filter((s) => s.source === 'schema');
    if (via === 'migration' && behind.length) {
        suggestions = suggestions.filter((s) => s.source === 'missing');
        result.notes.push(`The database lacks ${behind.length} index${behind.length === 1 ? '' : 'es'} prisma/schema.prisma lists — apply the migrations (prisma migrate deploy)`);
    }
    result.suggestions = suggestions;
    if (!suggestions.length) return result;

    // Prisma's SQL: from the schema without the indexes it lists but the database lacks, to the schema with the missing ones
    if (!url) {
        result.notes.push('Set the database connection to add them');
        return result;
    }
    try {
        const from = schemaWithoutIndexes(source, suggestions.filter((s) => s.source === 'schema').map((s) => ({
            model: s.model, fields: s.fields,
            name: (((dmmf.datamodel as { indexes?: SchemaIndex[] }).indexes) ?? []).find((i) => i.model === s.model && i.type === 'normal' && i.fields.map((f) => f.name).join(',') === s.fields.join(','))?.dbName ?? null,
        })));
        const to = schemaWithIndexes(source, suggestions.filter((s) => s.source === 'missing'));
        const statements = (await migrateDiff(root, values, from, to)).map((sql) => ({ sql, index: parseCreateIndex(sql) }));
        for (const s of suggestions) {
            const match = statements.find((x) => x.index && sameName(x.index.table, s.table) && x.index.columns.join(',') === s.columns.join(','));
            if (!match?.index) {
                s.problem = 'prisma migrate diff gives no SQL for it';
                continue;
            }
            s.name = match.index.name;
            s.statement = match.sql;
            const taken = db?.indexes.find((i) => sameName(i.name, s.name!) && (provider === 'postgresql' || sameName(i.table, s.table)));
            if (taken) s.problem = `The database has an index named ${taken.name} already (on ${taken.table}: ${taken.columns.filter(Boolean).join(', ') || 'an expression'})`;
        }
    } catch (err) {
        result.notes.push(`No SQL for them: ${(err as Error).message}`);
    }
    return result;
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/**
 * Build the indexes in the database — on PostgreSQL CONCURRENTLY, so reads and writes go on
 * while a large table is indexed (one statement at a time, outside a transaction); MySQL and
 * MariaDB build them online anyway. With DATABASE_URL_ADMIN when set: an index needs the
 * table's owner.
 */
async function buildIndexes(values: Values, provider: 'postgresql' | 'mysql', chosen: IndexSuggestion[]): Promise<{ suggestion: IndexSuggestion; sql: string; error?: string }[]> {
    const url = values.DATABASE_URL_ADMIN || values.DATABASE_URL!;
    const results: { suggestion: IndexSuggestion; sql: string; error?: string }[] = [];
    if (provider === 'postgresql') {
        await withPostgres(url, async (client, schema) => {
            await client.query(`SET search_path TO ${quote(schema)}`);
            for (const suggestion of chosen) {
                const sql = suggestion.statement!.replace(/^CREATE INDEX /i, 'CREATE INDEX CONCURRENTLY ');
                try {
                    await client.query(sql);
                    results.push({ suggestion, sql });
                } catch (err) {
                    // A failed concurrent build leaves an invalid index behind — never a valid one of someone else
                    const { rows } = await client.query(
                        `SELECT ix.indisvalid AS valid FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = i.relnamespace
                          WHERE n.nspname = $1 AND i.relname = $2`, [schema, suggestion.name]).catch(() => ({ rows: [] as any[] }));
                    if (rows[0] && rows[0].valid === false) {
                        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${quote(schema)}.${quote(suggestion.name!)}`).catch(() => undefined);
                    }
                    results.push({ suggestion, sql, error: explain(err) });
                }
            }
        }, 10_000, 0);
    } else {
        await withMySQL(url, async (conn) => {
            for (const suggestion of chosen) {
                try {
                    await conn.query(suggestion.statement!.replace(/;\s*$/, ''));
                    results.push({ suggestion, sql: suggestion.statement! });
                } catch (err) {
                    results.push({ suggestion, sql: suggestion.statement!, error: explain(err) });
                }
            }
        }, 10_000);
    }
    return results;
}

/** Drop those of these indexes that exist — what a migration that failed halfway had built */
async function dropIndexes(values: Values, provider: 'postgresql' | 'mysql', chosen: IndexSuggestion[]): Promise<string[]> {
    const url = values.DATABASE_URL_ADMIN || values.DATABASE_URL!;
    const dropped: string[] = [];
    if (provider === 'postgresql') {
        await withPostgres(url, async (client, schema) => {
            for (const suggestion of chosen) {
                if (!suggestion.name) continue;
                const { rows } = await client.query(
                    `SELECT 1 FROM pg_class i JOIN pg_namespace n ON n.oid = i.relnamespace WHERE n.nspname = $1 AND i.relname = $2 AND i.relkind = 'i'`,
                    [schema, suggestion.name]);
                if (rows.length === 0) continue;
                await client.query(`DROP INDEX IF EXISTS ${quote(schema)}.${quote(suggestion.name)}`);
                dropped.push(suggestion.name);
            }
        }, 10_000, 0);
    } else {
        await withMySQL(url, async (conn) => {
            for (const suggestion of chosen) {
                if (!suggestion.name) continue;
                const rows = await conn.query(
                    'SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1',
                    [suggestion.table, suggestion.name]);
                if (rows.length === 0) continue;
                await conn.query(`DROP INDEX \`${suggestion.name.replace(/`/g, '``')}\` ON \`${suggestion.table.replace(/`/g, '``')}\``);
                dropped.push(suggestion.name);
            }
        }, 10_000);
    }
    return dropped;
}

/** A migration of these statements in prisma/migrations, named as Prisma names them — its name */
function writeMigration(root: string, statements: string[]): string {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    for (let n = 1; ; n++) {
        // Another one this second gets a number
        const name = `${stamp}_add_indexes${n > 1 ? `_${n}` : ''}`;
        const dir = path.join(root, 'prisma', 'migrations', name);
        try {
            fs.mkdirSync(dir);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw err;
        }
        fs.writeFileSync(path.join(dir, 'migration.sql'), statements.map((s) => `-- CreateIndex\n${s}`).join('\n\n') + '\n');
        return name;
    }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : word.endsWith('x') ? 'es' : 's'}`;

/**
 * Add the chosen indexes — analyzed again, never taken from the browser. With
 * prisma/migrations: a migration of Prisma's SQL, deployed. Without: built in the database,
 * then added to prisma/schema.prisma. Either way the Prisma client is generated again.
 */
export function applyIndexes(root: string, values: Values, ids: string[]): Promise<ActionResult> {
    // One at a time: each analyzes what the one before left, and the schema is written once each
    const run = applying.then(() => addIndexes(root, values, ids));
    applying = run.catch(() => undefined);
    return run;
}

let applying: Promise<unknown> = Promise.resolve();

async function addIndexes(root: string, values: Values, ids: string[]): Promise<ActionResult> {
    const analysis = await analyzeIndexes(root, values);
    if (analysis.error) return { ok: false, message: analysis.error, output: '' };
    const chosen = analysis.suggestions.filter((s) => ids.includes(s.id));
    if (chosen.length === 0) return { ok: false, message: 'None of these indexes is missing any more', output: '' };
    const blocked = chosen.find((s) => !s.statement || s.problem);
    if (blocked) return { ok: false, message: `${blocked.model} (${blocked.fields.join(', ')}): ${blocked.problem ?? 'no SQL for it'}`, output: analysis.notes.join('\n') };
    const missing = chosen.filter((s) => s.source === 'missing');
    const source = fs.readFileSync(schemaFile(root), 'utf8');

    if (analysis.via === 'migration') {
        const migration = writeMigration(root, chosen.map((s) => s.statement!));
        try {
            await writeSchema(root, schemaWithIndexes(source, missing));
        } catch (err) {
            fs.rmSync(path.join(root, 'prisma', 'migrations', migration), { recursive: true, force: true });
            return { ok: false, message: (err as Error).message, output: '' };
        }
        const sql = fs.readFileSync(path.join(root, 'prisma', 'migrations', migration, 'migration.sql'), 'utf8');
        const deploy = await runAction('migrate', values, root);
        if (!deploy.ok) {
            // Undone: a failed migration left recorded would block every later deploy (P3009)
            const resolve = await runPrisma(['migrate', 'resolve', '--rolled-back', migration], { ...values, DATABASE_URL: values.DATABASE_URL_ADMIN || values.DATABASE_URL });
            // Its statements run one by one: those before the failing one have built their index
            let cleanup: string;
            try {
                const dropped = await dropIndexes(values, analysis.provider!, chosen);
                cleanup = dropped.length ? `Dropped what it had built: ${dropped.join(', ')}` : 'It had built none of the indexes';
            } catch (err) {
                cleanup = `Could not drop what it had built: ${explain(err)}`;
            }
            fs.rmSync(path.join(root, 'prisma', 'migrations', migration), { recursive: true, force: true });
            await writeSchema(root, source);
            return {
                ok: false,
                message: `prisma migrate deploy failed — the migration is removed again${values.DATABASE_URL_ADMIN ? '' : ' (an index needs the table\'s owner: set DATABASE_URL_ADMIN when the API\'s role isn\'t it)'}`,
                output: `prisma/migrations/${migration}/migration.sql\n${sql}\n$ prisma migrate deploy\n${deploy.output.trim()}\n\n$ prisma migrate resolve --rolled-back ${migration}\n${resolve.output.trim()}\n\n${cleanup}`,
            };
        }
        const generate = await runAction('generate', values, root);
        return {
            ok: generate.ok,
            message: `${plural(chosen.length, 'index')} added — migration ${migration}, deployed`,
            output: `prisma/migrations/${migration}/migration.sql\n${sql}\n$ prisma migrate deploy\n${deploy.output.trim()}\n\n$ prisma generate\n${generate.output.trim()}`,
        };
    }

    let results: Awaited<ReturnType<typeof buildIndexes>>;
    try {
        results = await buildIndexes(values, analysis.provider!, chosen);
    } catch (err) {
        return { ok: false, message: `Cannot reach the database: ${explain(err)}`, output: '' };
    }
    const built = results.filter((r) => !r.error).map((r) => r.suggestion);
    const failed = results.filter((r) => r.error);
    let output = results.map((r) => `${r.error ? '✗' : '✓'} ${r.sql}${r.error ? `\n  ${r.error}` : ''}`).join('\n');
    const toSchema = built.filter((s) => s.source === 'missing');
    let generated: ActionResult | null = null;
    if (toSchema.length) {
        await writeSchema(root, schemaWithIndexes(fs.readFileSync(schemaFile(root), 'utf8'), toSchema));
        generated = await runAction('generate', values, root);
        output += `\n\nprisma/schema.prisma: ${toSchema.map((s) => `${s.model} @@index([${s.fields.join(', ')}])`).join(', ')}\n\n$ prisma generate\n${generated.output.trim()}`;
    }
    const what = `${plural(built.length, 'index')} built`;
    return {
        ok: failed.length === 0 && (generated?.ok ?? true),
        message: failed.length === 0
            ? `${what}${toSchema.length ? ' and added to prisma/schema.prisma' : ''}`
            : `${what}, ${failed.length} failed — see the output`,
        output,
    };
}
