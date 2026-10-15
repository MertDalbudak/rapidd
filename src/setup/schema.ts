import fs from 'fs';
import path from 'path';
import { detectProvider } from '../core/adapter';
import { withMySQL } from './checks';
import { writeEnvFile } from './envfile';
import type { DMMF, DMMFField, DMMFModel } from '../types';

/**
 * Refinements of an introspected schema, written into prisma/schema.prisma:
 * - relation names a person would choose. Introspection names relations after models
 *   (`other_employees`, `Follow_Follow_followerIdToUser`) — and they are the API's names, in
 *   `include=`, `fields=` and filters;
 * - JSON columns MariaDB stores as LONGTEXT with a json_valid() check. Prisma introspects them
 *   as String, so the API returned the JSON as text.
 */

/** A change the schema cannot take — the message says why */
export class SchemaEditError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SchemaEditError';
    }
}

type Style = 'camel' | 'snake';

/** authorId, author_id, AuthorID → ['author', 'id'] */
export function words(name: string): string[] {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map((w) => w.toLowerCase());
}

function join(parts: string[], style: Style): string {
    if (style === 'snake') return parts.join('_');
    return parts.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
}

/** employees → employee, categories → category, addresses → address (status stays) */
export function singular(word: string): string {
    if (/[^aeiou]ies$/.test(word)) return word.slice(0, -3) + 'y';
    if (/(sses|shes|ches|xes|zes)$/.test(word)) return word.slice(0, -2);
    if (/(ss|us|is)$/.test(word) || !word.endsWith('s')) return word;
    return word.slice(0, -1);
}

/** employee → employees, category → categories, status → statuses (a plural stays) */
export function plural(word: string): string {
    if (singular(word) !== word) return word;
    if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + 'ies';
    if (/(s|sh|ch|x|z)$/.test(word)) return word + 'es';
    return word + 's';
}

const lastWord = (parts: string[], fn: (w: string) => string) => [...parts.slice(0, -1), fn(parts[parts.length - 1])];

/** The naming of the model's own fields: first_name → snake, firstName → camel */
function styleOf(model: DMMFModel): Style {
    const scalars = model.fields.filter((f) => f.kind !== 'object').map((f) => f.name);
    if (scalars.some((n) => n.includes('_'))) return 'snake';
    if (scalars.some((n) => /[a-z][A-Z]/.test(n))) return 'camel';
    return /[A-Z]/.test(model.name) ? 'camel' : 'snake';
}

/** manager_id → ['manager'], authorId → ['author'], department_code → ['department'] */
function foreignKeyBase(field: string): string[] | null {
    const parts = words(field);
    return parts.length > 1 && /^(id|uuid|code|key|fk|no|nr|num|ref)$/.test(parts[parts.length - 1]) ? parts.slice(0, -1) : null;
}

export interface RelationField {
    name: string;
    /** The related model */
    target: string;
    list: boolean;
    /** The relation's foreign key fields — on this model when it holds them, else on the target */
    foreignKey: string[];
    /** This model holds the foreign key */
    owner: boolean;
    /** A clearer name, when there is one */
    suggestion: string | null;
}

function suggest(model: DMMFModel, field: DMMFField, foreignKey: string[], owner: boolean, ambiguous: boolean): string | null {
    const target = words(field.type);
    if (!target.length) return null;
    const one = lastWord(target, singular);
    const many = lastWord(target, plural);
    const base = foreignKey.length === 1 ? foreignKeyBase(foreignKey[0]) : null;
    const by = [...(field.isList ? many : one), 'by', ...foreignKey.flatMap(words)];
    let parts: string[] | null;
    if (owner) parts = base ?? (ambiguous ? by : one);
    // The other side of parent_id
    else if (field.type === model.name && field.isList && base?.join('_') === 'parent') parts = ['children'];
    else if (!ambiguous) parts = field.isList ? many : one;
    else parts = foreignKey.length ? by : null;
    return parts ? join(parts, styleOf(model)) : null;
}

/** The model's relation fields, each with a clearer name where introspection's is not one */
export function relationFields(dmmf: DMMF, model: DMMFModel): RelationField[] {
    const relations = model.fields.filter((f) => f.kind === 'object');
    const fields = relations.map((field): RelationField => {
        const target = dmmf.datamodel.models.find((m) => m.name === field.type);
        const opposite = target?.fields.find((f) => f.kind === 'object' && f.relationName === field.relationName && f !== field);
        const owner = (field.relationFromFields?.length ?? 0) > 0;
        const foreignKey = [...((owner ? field.relationFromFields : opposite?.relationFromFields) ?? [])];
        // Two relations to the same model (or one to itself) need the key in the name
        const ambiguous = field.type === model.name || relations.filter((r) => r.type === field.type).length > 1;
        return { name: field.name, target: field.type, list: field.isList, foreignKey, owner, suggestion: suggest(model, field, foreignKey, owner, ambiguous) };
    });
    // A suggestion must not take a name another field has or gets
    const used = new Set(model.fields.filter((f) => f.kind !== 'object').map((f) => f.name));
    for (const f of fields) if (!f.suggestion || f.suggestion === f.name) used.add(f.name);
    for (const f of fields) {
        if (!f.suggestion || f.suggestion === f.name) {
            f.suggestion = null;
        } else if (used.has(f.suggestion)) {
            f.suggestion = null;
            used.add(f.name);
        } else {
            used.add(f.suggestion);
        }
    }
    return fields;
}

/** Rewrite the field lines of one model block */
function editModel(source: string, model: string, edit: (line: string) => string): string {
    const lines = source.split('\n');
    const start = lines.findIndex((l) => new RegExp(`^model\\s+${model}\\s*\\{`).test(l));
    if (start === -1) throw new SchemaEditError(`prisma/schema.prisma has no model ${model}`);
    for (let i = start + 1; i < lines.length && !/^\}/.test(lines[i]); i++) {
        const trimmed = lines[i].trim();
        if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('@@')) lines[i] = edit(lines[i]);
    }
    return lines.join('\n');
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

export type Renames = Record<string, Record<string, string>>;

/** The schema with relation fields renamed: { model: { oldName: newName } } */
export function renameRelations(source: string, dmmf: DMMF, renames: Renames): string {
    let out = source;
    for (const [modelName, map] of Object.entries(renames)) {
        const model = dmmf.datamodel.models.find((m) => m.name === modelName);
        if (!model) throw new SchemaEditError(`There is no model ${modelName}`);
        const changes = Object.entries(map).filter(([from, to]) => from !== to);
        if (!changes.length) continue;
        for (const [from, to] of changes) {
            const field = model.fields.find((f) => f.name === from);
            if (field?.kind !== 'object') throw new SchemaEditError(`${modelName}.${from} is not a relation`);
            if (typeof to !== 'string' || !IDENTIFIER.test(to)) throw new SchemaEditError(`"${to}" is not a field name — letters, digits and _, starting with a letter`);
        }
        const names = model.fields.map((f) => map[f.name] ?? f.name);
        const twice = names.find((n, i) => names.indexOf(n) !== i);
        if (twice) throw new SchemaEditError(`${modelName} would have two fields named ${twice}`);
        out = editModel(out, modelName, (line) => {
            const m = /^(\s*)([A-Za-z]\w*)(\s+)/.exec(line);
            return m && map[m[2]] && map[m[2]] !== m[2] ? m[1] + map[m[2]] + m[3] + line.slice(m[0].length) : line;
        });
    }
    return out;
}

export interface JsonColumn {
    table: string;
    column: string;
}

/**
 * Columns with a json_valid() check — MariaDB's JSON type (LONGTEXT underneath). MySQL's JSON
 * is a type of its own, which Prisma reads as Json already.
 */
export async function jsonTextColumns(url: string): Promise<JsonColumn[]> {
    if (detectProvider(url) !== 'mysql') return [];
    return withMySQL(url, async (conn) => {
        let rows: { t: string; c: string }[];
        try {
            rows = await conn.query("SELECT TABLE_NAME AS t, CHECK_CLAUSE AS c FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CHECK_CLAUSE LIKE 'json\\_valid(%'");
        } catch (err: any) {
            // MySQL before 8.0.16 has no CHECK_CONSTRAINTS (and no check constraints)
            if (err?.errno === 1109) return [];
            throw err;
        }
        return rows
            .map((r) => ({ table: String(r.t), column: /^json_valid\(`?([^`)]+)`?\)$/i.exec(String(r.c).trim())?.[1] ?? '' }))
            .filter((r) => r.column);
    });
}

/** The schema with these columns typed Json where it has them as String; the changed fields */
export function typeJsonColumns(source: string, dmmf: DMMF, columns: JsonColumn[]): { source: string; fields: string[] } {
    const fields: string[] = [];
    let out = source;
    for (const model of dmmf.datamodel.models) {
        const table = (model.dbName as string | null | undefined) || model.name;
        const json = new Set(columns.filter((c) => c.table === table).map((c) => c.column));
        const names = model.fields
            .filter((f) => f.kind === 'scalar' && f.type === 'String' && !f.isList && json.has((f.dbName as string | null | undefined) || f.name))
            .map((f) => f.name);
        if (!names.length) continue;
        out = editModel(out, model.name, (line) => {
            const m = /^(\s*)([A-Za-z]\w*)(\s+)String(\?)?(?=\s|$)(.*)$/.exec(line);
            if (!m || !names.includes(m[2])) return line;
            // Json takes no text native type (LONGTEXT is what MariaDB's JSON is)
            return `${m[1]}${m[2]}${m[3]}Json${m[4] ?? ''}${m[5].replace(/\s*@db\.(Tiny|Medium|Long)?Text\b/, '')}`;
        });
        fields.push(...names.map((n) => `${model.name}.${n}`));
    }
    return { source: out, fields };
}

/** Format, validate and write prisma/schema.prisma — atomic, the previous version as .bak */
export async function writeSchema(root: string, source: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { formatSchema, getDMMF } = require('@prisma/internals');
    let formatted = source;
    try {
        formatted = (await formatSchema({ schemas: [['schema.prisma', source]] }))?.[0]?.[1] ?? source;
    } catch {
        // Formatting is cosmetic — validation below reports what is wrong
    }
    try {
        await getDMMF({ datamodel: formatted });
    } catch (err) {
        // eslint-disable-next-line no-control-regex
        throw new SchemaEditError((err as Error).message.replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(0, 8).join('\n'));
    }
    const file = path.join(root, 'prisma', 'schema.prisma');
    writeEnvFile(file, formatted);
    fs.chmodSync(file, 0o644);
}
