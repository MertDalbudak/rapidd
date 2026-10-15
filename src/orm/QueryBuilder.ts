import { prisma, prismaTransaction, getAcl, Prisma } from '../core/prisma';
import { ErrorResponse } from '../core/errors';
import { LanguageDict } from '../core/i18n';
import { Logger } from '../utils/Logger';
import { isSystemUser } from '../core/user';
import { guardAclFilter } from '../core/acl';
import * as dmmf from '../core/dmmf';
import { dayRange, filterTimeZone, startOfDay } from './dates';
import { PRISMA_WRITE_OPS, isRawOperation, linkRewritesRelated, secureNestedOperations } from './nestedOperations';
import { keyText, parseScalar } from './values';
import type {
    RelationConfig,
    DMMFField,
    DMMFModel,
    PrismaWhereClause,
    PrismaIncludeClause,
    PrismaOrderBy,
    QueryErrorResponse,
    AclConfig,
    RapiddUser,
    PrismaErrorInfo,
} from '../types';

const API_RESULT_LIMIT: number = parseInt(process.env.API_RESULT_LIMIT as string, 10) || 500;

// Row cap for included list relations (a hot parent row can't pull unbounded children).
// Defaults to API_RESULT_LIMIT; set API_INCLUDE_RESULT_LIMIT=0 to disable the cap.
const API_INCLUDE_RESULT_LIMIT: number = (() => {
    const parsed = parseInt(process.env.API_INCLUDE_RESULT_LIMIT as string, 10);
    return Number.isNaN(parsed) ? API_RESULT_LIMIT : parsed;
})();

const MAX_NESTING_DEPTH: number = 10;

// Cap array-valued filters ([a,b,c] / not:[...]) so one param can't emit an unbounded IN/OR clause
const MAX_FILTER_ARRAY_LENGTH: number = parseInt(process.env.MAX_FILTER_ARRAY_LENGTH as string, 10) || 1000;

// Cap the number of comma-separated conditions in a single filter string
const MAX_FILTER_CONDITIONS: number = parseInt(process.env.MAX_FILTER_CONDITIONS as string, 10) || 100;

// Cap relation-path depth in filter/sort keys (a.b.c...) — schema bounds this, but stop abuse early
const MAX_FILTER_PATH_DEPTH: number = 10;

// Cap nesting depth of boolean filter groups (OR(AND(OR(...)))) to bound recursion
const MAX_FILTER_GROUP_DEPTH: number = 10;

// Raw Prisma nested-write operations (connect, deleteMany, ...) — see ./nestedOperations
export { PRISMA_WRITE_OPS };

// Prisma scalar types whose filter values must parse as numbers
const NUMERIC_FIELD_TYPES = new Set(['Int', 'BigInt', 'Float', 'Decimal']);

// Tracks which to-one include ACL warnings have been emitted (one per parent.relation per process)
const warnedToOneAclIncludes = new Set<string>();

// Pre-compiled regex patterns for better performance
const FILTER_PATTERNS = {
    // Split on comma, but not inside brackets
    FILTER_SPLIT: /,(?![^\[]*\])/,
    // ISO date format: 2024-01-01 or 2024-01-01T00:00:00
    ISO_DATE: /^\d{4}-\d{2}-\d{2}(T.*)?$/,
    // Date without time component: 2024-01-01
    DATE_ONLY: /^\d{4}-\d{2}-\d{2}$/,
    // Pure number (integer or decimal, optionally negative)
    PURE_NUMBER: /^-?\d+(\.\d+)?$/,
    // Numeric operators
    NUMERIC_OPS: ['lt:', 'lte:', 'gt:', 'gte:', 'eq:', 'ne:', 'between:'] as const,
    // Date operators
    DATE_OPS: ['before:', 'after:', 'from:', 'to:', 'on:', 'between:'] as const,
};

/**
 * Prisma error code mappings
 * Maps Prisma error codes to HTTP status codes and user-friendly messages
 */
const PRISMA_ERROR_MAP: Record<string, PrismaErrorInfo> = {
    // Connection errors
    P1001: { status: 500, message: 'db_connection_failed' },

    // Query errors (4xx - client errors)
    P2000: { status: 400, message: 'value_too_long' },
    P2001: { status: 404, message: 'record_not_found' },
    P2002: { status: 409, message: null }, // Dynamic message for duplicates
    P2003: { status: 400, message: 'foreign_key_constraint_failed' },
    P2004: { status: 400, message: 'database_constraint_failed' },
    P2005: { status: 400, message: 'invalid_stored_value' },
    P2006: { status: 400, message: 'invalid_value' },
    P2007: { status: 400, message: 'data_validation_error' },
    P2008: { status: 400, message: 'query_parse_failed' },
    P2009: { status: 400, message: 'query_validation_failed' },
    P2010: { status: 500, message: 'raw_query_failed' },
    P2011: { status: 400, message: 'null_constraint_violation' },
    P2012: { status: 400, message: 'missing_required_value' },
    P2013: { status: 400, message: 'missing_required_argument' },
    P2014: { status: 400, message: 'required_relation_violation' },
    P2015: { status: 404, message: 'related_record_not_found' },
    P2016: { status: 400, message: 'query_interpretation_error' },
    P2017: { status: 400, message: 'records_not_connected' },
    P2018: { status: 404, message: 'required_connected_records_not_found' },
    P2019: { status: 400, message: 'input_error' },
    P2020: { status: 400, message: 'value_out_of_range' },
    P2021: { status: 404, message: 'table_not_found' },
    P2022: { status: 404, message: 'column_not_found' },
    P2023: { status: 400, message: 'inconsistent_column_data' },
    P2024: { status: 408, message: 'connection_pool_timeout' },
    P2025: { status: 404, message: 'required_records_not_found' },
    P2026: { status: 400, message: 'feature_not_supported' },
    P2027: { status: 500, message: 'multiple_query_errors' },
    P2028: { status: 500, message: 'transaction_api_error' },
    P2030: { status: 404, message: 'fulltext_index_not_found' },
    P2033: { status: 400, message: 'number_exceeds_range' },
    P2034: { status: 409, message: 'transaction_write_conflict' },
};

/** Prisma's filter operators — reported as "argument" in validation errors, but not fields */
const PRISMA_OPERATORS = new Set(['equals', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'not',
    'has', 'hasSome', 'hasEvery', 'isEmpty', 'mode', 'some', 'every', 'none', 'is', 'isNot', 'AND', 'OR', 'NOT', 'where', 'data', 'select', 'include']);

/**
 * The timezone a date-only filter value is read in: DATE columns hold calendar days (Prisma
 * represents them as UTC midnight) — UTC; timestamps — API_TIMEZONE, else the server's zone.
 */
function dateZone(field?: DMMFField): string | undefined {
    return isDateColumn(field) ? 'UTC' : filterTimeZone();
}

/**
 * A date-only value ("2026-01-15") written to a DateTime field: Prisma accepts full ISO
 * datetimes only. A DATE column gets that day; a timestamp the start of the day in the filter
 * timezone (API_TIMEZONE, else the server's) — as date-only filters read it.
 */
function writeDate(field: DMMFField, value: unknown): unknown {
    if (field.type !== 'DateTime' || typeof value !== 'string') return value;
    const day = dayRange(value, isDateColumn(field) ? 'UTC' : filterTimeZone());
    return day ? day.gte : value;
}

/** `DateTime @db.Date` — a calendar day without a time */
function isDateColumn(field?: DMMFField): boolean {
    return Array.isArray(field?.nativeType) && String(field!.nativeType[0]).toLowerCase() === 'date';
}

/** Unique-constraint field from a driver adapter's report: `sku`, or MySQL's index name `Post_slug_key` → `slug` */
function uniqueFieldName(target: string, modelName: string): string {
    return target.replace(new RegExp(`^${modelName}_`), '').replace(/_key$/, '');
}

/**
 * The model and fields of a duplicate-key error. Prisma names the constraint by its fields —
 * or, through driver adapters, by the database's index name: a name the schema maps
 * (`@unique(map: "setting_key")`), Prisma's default `<table>_pkey` / `<table>_<columns>_key`, or
 * MySQL's `PRIMARY` (the key of the model written — of the table when MySQL names it).
 */
function duplicateTarget(error: any, body: Record<string, unknown> = {}): { model: string; fields: string[] } {
    const constraint = error?.meta?.driverAdapterError?.cause?.constraint;
    const target = error?.meta?.target ?? constraint?.fields ?? constraint?.index;
    const written = String(error?.meta?.modelName || '');
    // An error handler that throws hides the error — no schema, no mapping
    const schema = typeof dmmf.getDMMFSync === 'function' ? dmmf.getDMMFSync() : null;
    const models = (schema?.datamodel.models ?? []) as DMMFModel[];
    const tableOf = (model: DMMFModel): string => (model as { dbName?: string | null }).dbName || model.name;
    const columnOf = (model: DMMFModel, field: string): string =>
        (model.fields.find((f: DMMFField) => f.name === field) as { dbName?: string | null } | undefined)?.dbName || field;

    if (Array.isArray(target)) {
        // Field names — or the database's column names behind @map
        const model = models.find((m: DMMFModel) => m.name === written);
        const fields = target.map((name: unknown) => {
            const field = model?.fields.find((f: DMMFField) => f.name === name || (f as { dbName?: string | null }).dbName === name);
            return field?.name ?? String(name);
        });
        return { model: written, fields };
    }
    if (typeof target !== 'string' || target === '') return { model: written, fields: [] };

    const indexes = (schema?.datamodel.indexes ?? []) as { model: string; type: string; dbName?: string | null; fields: { name: string }[] }[];
    const keys = indexes.filter((index) => index.type === 'id' || index.type === 'unique');
    const of = (index: { model: string; fields: { name: string }[] }) => ({ model: index.model, fields: index.fields.map((f) => f.name) });
    const named = keys.find((index) => index.dbName === target);
    if (named) return of(named);
    const primary = /^(?:(.+)\.)?PRIMARY$/.exec(target);
    // MariaDB names no table: the key of the model written — unless the body doesn't carry it,
    // when the clash is a nested row's: the one nested model whose items carry their key
    const primaryModel = primary && !primary[1] ? primaryOwner(models, written, body) : null;
    if (primary && !primary[1] && !primaryModel) return { model: written, fields: [] };
    for (const index of keys) {
        const model = models.find((m: DMMFModel) => m.name === index.model);
        if (!model || index.dbName) continue;
        const table = tableOf(model);
        if (index.type === 'id' && (target === `${table}_pkey` || (primary && (primary[1] ? primary[1] === table : model.name === primaryModel)))) return of(index);
        if (index.type === 'unique' && target === `${table}_${index.fields.map((f) => columnOf(model, f.name)).join('_')}_key`) return of(index);
    }
    return { model: written, fields: [uniqueFieldName(target, written)] };
}

/** The model whose primary key a bare `PRIMARY` clash is on: the one written, or a nested one */
function primaryOwner(models: DMMFModel[], written: string, body: Record<string, unknown>): string | null {
    const keyOf = (name: string): string[] | null => {
        try {
            const key = dmmf.getPrimaryKey(name);
            return Array.isArray(key) ? key : [key];
        } catch {
            return null; // no schema loaded — nothing to tell
        }
    };
    const carries = (name: string, row: Record<string, unknown>) => keyOf(name)?.every((field) => row[field] != null) ?? false;
    if (carries(written, body)) return written;
    const found = new Set<string>();
    const walk = (name: string, row: Record<string, unknown>, depth: number): void => {
        const model = models.find((m: DMMFModel) => m.name === name);
        if (!model || depth > MAX_NESTING_DEPTH) return;
        for (const field of model.fields) {
            const value = row[field.name];
            if (field.kind !== 'object' || !value || typeof value !== 'object') continue;
            for (const item of Array.isArray(value) ? value : [value]) {
                if (!item || typeof item !== 'object') continue;
                if (carries(field.type, item as Record<string, unknown>)) found.add(field.type);
                walk(field.type, item as Record<string, unknown>, depth + 1);
            }
        }
    };
    walk(written, body, 0);
    return found.size === 1 ? [...found][0] : null;
}

/**
 * Database errors Prisma passes on unclassified (driver adapters report check constraints,
 * invalid values and row-level security rejections as DriverAdapterError): they are client
 * errors, not 500s.
 */
function databaseErrorInfo(cause: any): PrismaErrorInfo | null {
    if (!cause || typeof cause !== 'object') return null;
    const code = String(cause.code ?? cause.originalCode ?? '');
    if (cause.kind === 'postgres') {
        // 42501: a row-level security policy (WITH CHECK) or a missing grant refused the write
        if (code === '42501') return { status: 403, message: 'no_permission' };
        if (code === '23P01') return { status: 409, message: 'database_constraint_failed' };
        if (code === '23502') return { status: 400, message: 'null_constraint_violation' };
        if (code.startsWith('23')) return { status: 400, message: 'database_constraint_failed' };
        if (code === '22001') return { status: 400, message: 'value_too_long' };
        if (code === '22003') return { status: 400, message: 'value_out_of_range' };
        if (code.startsWith('22')) return { status: 400, message: 'invalid_value' };
        if (code === '40001' || code === '40P01') return { status: 409, message: 'transaction_write_conflict' };
    }
    if (cause.kind === 'mysql') {
        switch (Number(code)) {
            case 3819: return { status: 400, message: 'database_constraint_failed' };
            case 1048: case 1364: return { status: 400, message: 'null_constraint_violation' };
            case 1406: return { status: 400, message: 'value_too_long' };
            case 1264: case 1690: return { status: 400, message: 'value_out_of_range' };
            case 1292: case 1366: return { status: 400, message: 'invalid_value' };
            case 1213: case 1205: return { status: 409, message: 'transaction_write_conflict' };
        }
    }
    return null;
}

/**
 * QueryBuilder - Builds Prisma queries with relation handling, filtering, and ACL support
 *
 * A comprehensive query builder that translates simplified API requests into valid Prisma queries.
 * Handles nested relations, field validation, filtering with operators, and access control.
 *
 * @example
 * const qb = new QueryBuilder('users');
 * const filter = qb.filter('name=%John%,age=gt:18');
 * const include = qb.include('posts.comments', user);
 */
class QueryBuilder {
    name: string;
    _relationshipsCache: RelationConfig[] | null;
    _relatedFieldsCache: Record<string, Record<string, DMMFField>>;
    _relatedByName: Map<string, RelationConfig> | null;
    _relatedByField: Map<string, RelationConfig> | null;

    /**
     * Initialize QueryBuilder with model name and configuration
     * The caches below assume the Prisma schema (DMMF) is immutable for the process lifetime.
     * @param name - The Prisma model name (e.g., 'users', 'company_profiles')
     */
    constructor(name: string) {
        this.name = name;
        this._relationshipsCache = null;
        this._relatedFieldsCache = {};
        this._relatedByName = null;
        this._relatedByField = null;
    }

    /**
     * Get all fields for this model from DMMF (including relation fields)
     */
    get fields(): Record<string, DMMFField> {
        return dmmf.getFields(this.name);
    }

    /**
     * Get only scalar fields (non-relation) for this model from DMMF
     */
    get scalarFields(): Record<string, DMMFField> {
        return dmmf.getScalarFields(this.name);
    }

    /**
     * Get relationships configuration for this model from DMMF
     * Builds relationships dynamically from Prisma schema
     */
    get relatedObjects(): RelationConfig[] {
        if (this._relationshipsCache) {
            return this._relationshipsCache;
        }

        this._relationshipsCache = dmmf.buildRelationships(this.name);
        this._relatedByName = null;
        this._relatedByField = null;
        return this._relationshipsCache;
    }

    /** O(1) lookup of relation by name */
    getRelationByName(name: string): RelationConfig | undefined {
        if (!this._relatedByName) {
            const map = new Map<string, RelationConfig>();
            for (const rel of this.relatedObjects) {
                map.set(rel.name, rel);
            }
            this._relatedByName = map;
        }
        return this._relatedByName.get(name);
    }

    /** O(1) lookup of relation by field (foreign key column — each column of a composite one) */
    getRelationByField(field: string): RelationConfig | undefined {
        if (!this._relatedByField) {
            const map = new Map<string, RelationConfig>();
            for (const rel of this.relatedObjects) {
                for (const column of rel.fields ?? (rel.field ? [rel.field] : [])) map.set(column, rel);
            }
            this._relatedByField = map;
        }
        return this._relatedByField.get(field);
    }

    /**
     * Get DMMF model object by name
     */
    getDmmfModel(name: string = this.name): DMMFModel | undefined {
        return dmmf.getModel(name);
    }

    /**
     * Get primary key field(s) for a given model
     */
    getPrimaryKey(modelName: string = this.name): string | string[] {
        return dmmf.getPrimaryKey(modelName);
    }

    /** A model's fields — this model's own, or a related one's */
    #fieldsOf(modelName: string): Record<string, any> {
        return modelName === this.name ? this.fields : this.#getRelatedModelFields(modelName);
    }

    /**
     * Get fields for a related model (cached for performance)
     */
    #getRelatedModelFields(modelName: string): Record<string, DMMFField> {
        if (!this._relatedFieldsCache[modelName]) {
            this._relatedFieldsCache[modelName] = dmmf.getFields(modelName);
        }
        return this._relatedFieldsCache[modelName];
    }

    /**
     * Check if a field exists on a model
     */
    #fieldExistsOnModel(modelName: string, fieldName: string): boolean {
        const fields = this.#getRelatedModelFields(modelName);
        return fields[fieldName] != null;
    }

    /**
     * Ensure a relation object has its nested relations populated.
     * If relatedObject.relation is undefined, dynamically builds it from DMMF.
     * This enables deep relationship processing beyond 2 levels.
     */
    #ensureRelations(relatedObject: RelationConfig): RelationConfig {
        if (!relatedObject.relation && relatedObject.object) {
            const targetRelations = dmmf.getRelations(relatedObject.object);
            if (targetRelations.length > 0) {
                relatedObject.relation = targetRelations.map((nested: DMMFField) => dmmf.relationConfig(nested));
            }
        }
        return relatedObject;
    }

    /**
     * Build select object for specified fields
     */
    select(fields: string[] | null = null): Record<string, boolean> {
        if (fields == null) {
            const result: Record<string, boolean> = {};
            for (const key in this.fields) {
                result[key] = true;
            }
            return result;
        } else {
            return fields.reduce((acc: Record<string, boolean>, curr: string) => {
                acc[curr] = true;
                return acc;
            }, {});
        }
    }

    /**
     * Parse filter string into Prisma where conditions.
     *
     * Two syntaxes, auto-detected:
     * - Legacy: comma-separated conditions combined with implicit AND
     *     name=%max%,status=not:inactive
     * - Boolean groups (when a top-level OR(/AND( token is present): explicit prefix
     *   operators, nestable, case-insensitive:
     *     OR(AND(OR(name=%foo%,author.name=%acme%),status=not:inactive),status=active)
     *   → { OR: [ { AND: [ { OR: [...] }, ... ] }, ... ] }
     *
     * Leaf conditions in both modes share the same type-aware parsing, relation
     * navigation, and ACL-omit enforcement. When a user is provided, fields hidden by
     * the ACL (getOmitFields) are rejected with 403 so a client can't infer restricted
     * values through filter probing (e.g. price=gt:100000).
     *
     * Also accepted: an object of field equality conditions (`{ courseId: '5' }` — values
     * taken literally, parsed by field type, same ACL checks) and an array of filter
     * strings (`?q=a&q=b`), combined with AND.
     */
    filter(q: string | string[] | Record<string, unknown>, user: any = null): Record<string, unknown> {
        if (Array.isArray(q)) {
            q = q.filter((part) => typeof part === 'string' && part.trim() !== '').join(',');
        } else if (q && typeof q === 'object') {
            return this.#equalityFilter(q, user);
        }
        if (typeof q !== 'string' || q.trim() === '') {
            return {};
        }

        // Detect boolean-group syntax via a lenient (non-throwing) top-level scan
        const topParts = this.#splitTopLevel(q, false);
        const hasGroup = topParts.some((p: string) => /^(or|and)\s*\(/i.test(p.trim()));

        if (hasGroup) {
            const fragments = topParts
                .map((p: string) => p.trim())
                .filter((p: string) => p.length > 0)
                .map((p: string) => this.#parseFilterExpression(p, user, 0, { count: 0 }));
            // Multiple top-level expressions combine with implicit AND
            return fragments.length === 1 ? fragments[0] : { AND: fragments };
        }

        // Legacy path — comma-separated implicit AND, flat-merged onto one object
        const result: Record<string, unknown> = {};
        const filterParts = q.split(FILTER_PATTERNS.FILTER_SPLIT);

        if (filterParts.length > MAX_FILTER_CONDITIONS) {
            throw new ErrorResponse(400, "too_many_filter_conditions", { max: MAX_FILTER_CONDITIONS, received: filterParts.length });
        }

        for (const part of filterParts) {
            // Skip invalid filter parts without '='
            if (part.indexOf('=') === -1) continue;
            this.#applyLeafCondition(result, part, user, false);
        }

        return result;
    }

    /**
     * Recursively parse a boolean-group expression into a Prisma where fragment.
     * A group is `OR(...)` / `AND(...)` (case-insensitive); anything else is a leaf condition.
     */
    #parseFilterExpression(part: string, user: any, depth: number, leaves: { count: number }): Record<string, any> {
        if (depth > MAX_FILTER_GROUP_DEPTH) {
            throw new ErrorResponse(400, "filter_group_too_deep", { max: MAX_FILTER_GROUP_DEPTH });
        }

        const groupMatch = part.match(/^(or|and)\s*\(([\s\S]*)\)$/i);
        if (!groupMatch && /^(or|and)\s*\(/i.test(part)) {
            throw new ErrorResponse(400, "unbalanced_filter_group", { condition: part.slice(0, 100) });
        }
        if (groupMatch) {
            const op = groupMatch[1].toLowerCase() === 'or' ? 'OR' : 'AND';
            const inner = groupMatch[2];
            const childParts = this.#splitTopLevel(inner, true)
                .map((p: string) => p.trim())
                .filter((p: string) => p.length > 0);

            if (childParts.length === 0) {
                throw new ErrorResponse(400, "empty_filter_group", { operator: op });
            }

            const children = childParts.map((cp: string) => this.#parseFilterExpression(cp, user, depth + 1, leaves));
            return { [op]: children };
        }

        // Leaf condition
        if (++leaves.count > MAX_FILTER_CONDITIONS) {
            throw new ErrorResponse(400, "too_many_filter_conditions", { max: MAX_FILTER_CONDITIONS });
        }
        if (part.indexOf('=') === -1) {
            throw new ErrorResponse(400, "invalid_filter_condition", { condition: part });
        }
        const fragment: Record<string, any> = {};
        this.#applyLeafCondition(fragment, part, user, true);
        return fragment;
    }

    /**
     * Apply a single `key=value` leaf condition onto the given filter object
     * (navigates relation paths, enforces path depth, applies the typed/ACL-checked value).
     *
     * @param inGroup true when this leaf is inside a boolean OR()/AND() group.
     *
     * Empty values: a bare `field=` skips the condition ONLY for a top-level scalar in the
     * legacy comma list (a documented convenience for optional query params). An empty value
     * on a relation path (`tags.name=`) or inside a boolean group is rejected — otherwise it
     * would silently collapse to a match-all condition (`{tags:{some:{}}}` or `{}`), which is
     * especially dangerous inside an OR.
     */
    #applyLeafCondition(rootFilter: Record<string, any>, part: string, user: any, inGroup: boolean): void {
        // Split only on first '=' to handle values containing '='
        const eqIndex = part.indexOf('=');
        const key = part.substring(0, eqIndex);
        const value = part.substring(eqIndex + 1);
        const relationPath = key.split('.').map((e: string) => e.trim());
        if (relationPath.length > MAX_FILTER_PATH_DEPTH) {
            throw new ErrorResponse(400, "filter_path_too_deep", { max: MAX_FILTER_PATH_DEPTH, field: key });
        }
        const fieldName = relationPath.pop()!;
        const trimmedValue = value?.trim() ?? null;

        // Guard empty values (see doc above) before navigating — navigation would otherwise
        // leave a dangling relation filter even though the value contributes nothing.
        if (!trimmedValue) {
            if (inGroup || relationPath.length > 0) {
                throw new ErrorResponse(400, "empty_filter_value", { field: key });
            }
            return; // legacy top-level scalar: skip this optional condition
        }

        const { filter: filterContext, modelName } = this.#navigateToFilterContext(rootFilter, relationPath, user);
        // Into its own object first: a field filtered here already is ANDed, not overwritten
        const leaf: Record<string, any> = {};
        this.#applyFilterValue(leaf, fieldName, trimmedValue, modelName, user);
        for (const [key, condition] of Object.entries(leaf)) {
            this.#mergeCondition(filterContext, key, condition);
        }
    }

    /**
     * Split a string on top-level commas, respecting () and [] nesting.
     * @param strict when true, throws on unbalanced parentheses/brackets; when false,
     *   clamps depth at 0 so stray delimiters in legacy values can't corrupt detection.
     */
    #splitTopLevel(str: string, strict: boolean): string[] {
        const parts: string[] = [];
        let depth = 0;
        let current = '';
        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            if (ch === '(' || ch === '[') {
                depth++;
            } else if (ch === ')' || ch === ']') {
                depth--;
                if (depth < 0) {
                    if (strict) throw new ErrorResponse(400, "unbalanced_filter_group", { value: str });
                    depth = 0;
                }
            }
            if (ch === ',' && depth === 0) {
                parts.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        if (strict && depth !== 0) {
            throw new ErrorResponse(400, "unbalanced_filter_group", { value: str });
        }
        parts.push(current);
        return parts;
    }

    /**
     * Object filter: field equality conditions. Values are literal (no operator syntax, so
     * nothing can be injected through them), parsed by field type; null matches null.
     */
    #equalityFilter(q: Record<string, unknown>, user: any): Record<string, unknown> {
        const where: Record<string, unknown> = {};
        for (const [fieldName, value] of Object.entries(q)) {
            const field = this.fields[fieldName];
            if (!field || field.kind === 'object') {
                throw new ErrorResponse(400, "invalid_filter_field", { field: fieldName, modelName: this.name });
            }
            this.#assertQueryableField(fieldName, this.name, user);
            if (value === null) {
                where[fieldName] = null;
                continue;
            }
            const scalar = typeof value !== 'object' || value instanceof Date;
            const parsed = scalar && field.type !== 'Json' && field.type !== 'Bytes' ? parseScalar(field, value) : undefined;
            if (parsed === undefined) {
                throw new ErrorResponse(400, "invalid_filter_value", { field: fieldName, value: String(value).slice(0, 100), expected: field.type });
            }
            where[fieldName] = parsed;
        }
        return where;
    }

    /**
     * Reject querying (filter/sort) through fields the ACL hides from this user.
     * System users bypass, matching the write-control convention.
     */
    #assertQueryableField(fieldName: string, modelName: string, user: any): void {
        if (!user || isSystemUser(user)) return;
        const omit = this.getRelatedOmit(modelName, user);
        if (omit[fieldName]) {
            throw new ErrorResponse(403, "field_not_filterable", { field: fieldName, modelName });
        }
    }

    /**
     * Navigate through relation path and return the filter context object and current model name.
     * Related rows count only where their model's access rule lets this user read them — a filter
     * through a relation can't probe rows the user can't see; through a model the rule denies, it
     * is refused.
     */
    #navigateToFilterContext(rootFilter: Record<string, any>, relationPath: string[], user: any = null): { filter: Record<string, any>; modelName: string } {
        let filter: Record<string, any> = rootFilter;
        let currentModelName = this.name;

        for (const relationName of relationPath) {
            // Omitted relations must not be traversable either
            this.#assertQueryableField(relationName, currentModelName, user);

            // Resolve relations for the model at this depth (supports paths beyond 2 levels)
            const relations: RelationConfig[] = currentModelName === this.name
                ? this.relatedObjects
                : dmmf.buildRelationships(currentModelName);
            const rel = relations.find((r: RelationConfig) => r.name === relationName);

            if (!rel) {
                throw new ErrorResponse(400, "relation_not_exist", {
                    relation: relationName,
                    modelName: currentModelName,
                });
            }

            const isListRel = rel.isList || dmmf.isListRelation(currentModelName, rel.name);
            const existing = filter[rel.name];
            // A relation filtered here already (posts.title=a,posts.body=b) — the same related row;
            // not one tested for existence (posts=#NULL: { none: {} }, author=#NULL: { is: null })
            const reusable = existing && typeof existing === 'object' && (isListRel
                ? existing.some && typeof existing.some === 'object'
                : !('is' in existing) && !('isNot' in existing));
            if (reusable) {
                filter = isListRel ? existing.some : existing;
            } else {
                const context: Record<string, any> = {};
                const access = this.#relationAccess(rel.object, relationName, currentModelName, user);
                if (access) context.AND = [access];
                this.#mergeCondition(filter, rel.name, isListRel ? { some: context } : context);
                filter = context;
            }

            currentModelName = rel.object;
        }

        return { filter, modelName: currentModelName };
    }

    /**
     * The access rule of a model reached through a relation in a filter or sort: null when it
     * doesn't restrict this user; a model the rule denies can't be queried through (403).
     */
    #relationAccess(model: string, relationName: string, parentModel: string, user: any): Record<string, any> | null {
        const { accessFilter } = this.#resolveAclContext(model, user);
        if (accessFilter === false) {
            throw new ErrorResponse(403, "field_not_filterable", { field: relationName, modelName: parentModel });
        }
        return accessFilter && typeof accessFilter === 'object' && Object.keys(accessFilter).length > 0 ? accessFilter : null;
    }

    /** Write a condition into a where object — a key set there already is ANDed with it, not overwritten */
    #mergeCondition(target: Record<string, any>, key: string, condition: any): void {
        if (!(key in target)) {
            target[key] = condition;
            return;
        }
        const list = (value: any): any[] => (value == null ? [] : Array.isArray(value) ? value : [value]);
        if (key === 'AND' || key === 'NOT') {
            // Lists of conditions that all apply
            target[key] = [...list(target[key]), ...list(condition)];
            return;
        }
        // The same field twice (id=gt:3,id=lt:6): both apply
        target.AND = [...list(target.AND), { [key]: condition }];
    }

    /**
     * Apply a filter value to a field in the filter context
     */
    #applyFilterValue(filter: Record<string, any>, fieldName: string, value: string | null, modelName: string = this.name, user: any = null): void {
        // Resolve field metadata from the correct model
        const fields = modelName === this.name ? this.fields : this.#getRelatedModelFields(modelName);
        let field = fields[fieldName];

        // Reject filters on fields that don't exist on the resolved model
        if (!field) {
            throw new ErrorResponse(400, "invalid_filter_field", { field: fieldName, modelName });
        }

        // Reject filters on fields the ACL hides from this user (value inference)
        this.#assertQueryableField(fieldName, modelName, user);

        const isRelation = field.kind === 'object';

        // Handle explicit null filter tokens
        if (value === '#NULL') {
            if (isRelation) {
                // To-one relations use { is: null }; list relations can't be null — "no related rows"
                // is { none: {} }, counting only rows the user can read
                filter[fieldName] = field.isList ? { none: this.#relationAccess(field.type, fieldName, modelName, user) ?? {} } : { is: null };
            } else if (field.isRequired) {
                // Non-nullable scalar fields can never be null — reject the filter
                throw new ErrorResponse(400, "field_not_nullable", { field: fieldName });
            } else {
                filter[fieldName] = this.#nullCondition(field, false);
            }
            return;
        }
        if (value === 'not:#NULL') {
            if (isRelation) {
                filter[fieldName] = field.isList ? { some: this.#relationAccess(field.type, fieldName, modelName, user) ?? {} } : { isNot: null };
            } else if (field.isRequired) {
                // Non-nullable scalar fields are always not-null — skip (always true)
                return;
            } else {
                filter[fieldName] = this.#nullCondition(field, true);
            }
            return;
        }

        // Skip empty/null values — don't filter on empty strings
        if (!value) {
            return;
        }

        // Filtering a relation by a scalar value — rewrite to the FK column when one exists
        if (isRelation) {
            const fkField = field.relationFromFields?.length === 1 ? field.relationFromFields[0] : null;
            if (!fkField || !fields[fkField]) {
                throw new ErrorResponse(400, "cannot_filter_relation_directly", {
                    field: fieldName,
                    hint: `Use '${fieldName}.<field>=...' to filter on the relation's fields`,
                });
            }
            fieldName = fkField;
            field = fields[fkField];
            // The rewritten FK column must be queryable too
            this.#assertQueryableField(fieldName, modelName, user);
        }

        // Scalar list columns (PostgreSQL arrays) are tested by element: tags=a holds a,
        // tags=[a,b] holds any of them; not: negates
        if (field.isList && field.kind !== 'object') {
            const negated = value.startsWith('not:');
            const raw = negated ? value.substring(4) : value;
            const type = this.#resolveFilterType(field);
            const condition = raw.startsWith('[') && raw.endsWith(']')
                ? { hasSome: this.#coerceArrayValues(this.#parseArrayValue(raw, type === 'Number'), fieldName, type, field) }
                : { has: this.#coerceArrayValues([raw], fieldName, type, field)[0] };
            if (negated) filter.NOT = (filter.NOT || []).concat([{ [fieldName]: condition }]);
            else filter[fieldName] = condition;
            return;
        }

        // Handle not: prefix (negation)
        if (value.startsWith('not:')) {
            this.#applyNegatedFilter(filter, fieldName, value.substring(4), field);
            return;
        }

        // Apply typed filter based on the field's declared type
        this.#applyTypedFilter(filter, fieldName, value, field);
    }

    /**
     * A column is (not) null. In a Json column null is the database's NULL or JSON's null — a
     * null the API wrote — both of which Prisma matches with AnyNull only.
     */
    #nullCondition(field: DMMFField, negated: boolean): Record<string, any> {
        const anyNull = field.type === 'Json' ? Prisma?.AnyNull : undefined;
        if (anyNull) return negated ? { not: anyNull } : { equals: anyNull };
        return negated ? { not: { equals: null } } : { equals: null };
    }

    /**
     * Map a DMMF field to its filter type group.
     * Returns null for types where value-based detection is the best we can do (Json, Bytes, ...).
     */
    #resolveFilterType(field?: DMMFField): 'Number' | 'DateTime' | 'Boolean' | 'String' | 'Enum' | null {
        if (!field) return null;
        if (field.kind === 'enum') return 'Enum';
        if (field.kind !== 'scalar') return null;
        if (NUMERIC_FIELD_TYPES.has(field.type)) return 'Number';
        if (field.type === 'DateTime') return 'DateTime';
        if (field.type === 'Boolean') return 'Boolean';
        if (field.type === 'String') return 'String';
        return null;
    }

    /**
     * Apply a negated filter (not:value)
     */
    #applyNegatedFilter(filter: Record<string, any>, fieldName: string, value: string, field?: DMMFField): void {
        // Skip empty negation values (e.g. "field=not:")
        if (!value) {
            return;
        }

        // not:#NULL (defensive — normally handled by the caller)
        if (value === '#NULL') {
            if (field?.kind === 'object') {
                filter[fieldName] = field.isList ? { some: {} } : { isNot: null };
                return;
            }
            // Non-nullable scalar fields are always not-null — skip (always true)
            if (field?.isRequired) {
                return;
            }
            filter[fieldName] = { not: { equals: null } };
            return;
        }

        const fieldType = this.#resolveFilterType(field);
        const decimal = field?.type === 'Decimal';

        // not:[array]
        if (value.startsWith('[') && value.endsWith(']')) {
            const arr = this.#parseArrayValue(value, fieldType === 'Number');
            if ((fieldType === 'String' || fieldType === null) && arr.some((v: unknown) => typeof v === 'string' && v.includes('%'))) {
                // Append — assignment would clobber a previous field's not:[...] group.
                // Prisma NOT arrays AND their entries, which is the right semantics here.
                if (!filter.NOT) filter.NOT = [];
                filter.NOT.push(...arr.map((v: unknown) => ({ [fieldName]: this.#filterString(String(v), fieldType === null) })));
            } else {
                filter[fieldName] = { notIn: this.#coerceArrayValues(arr, fieldName, fieldType, field) };
            }
            return;
        }

        // not:between:
        if (value.startsWith('between:')) {
            this.#applyNotBetween(filter, fieldName, value.substring(8), fieldType, dateZone(field), decimal);
            return;
        }

        switch (fieldType) {
            case 'Number': {
                const numFilter = this.#filterNumber(value, decimal);
                if (!numFilter) {
                    throw new ErrorResponse(400, "invalid_filter_value", { field: fieldName, value, expected: 'number' });
                }
                filter[fieldName] = { not: numFilter };
                return;
            }
            case 'DateTime':
                filter[fieldName] = { not: this.#buildDateCondition(fieldName, value, field) };
                return;
            case 'Boolean':
                filter[fieldName] = { not: this.#parseBooleanValue(fieldName, value) };
                return;
            case 'String':
                filter[fieldName] = { not: this.#filterString(value, false) };
                return;
            case 'Enum':
                filter[fieldName] = { not: { equals: this.#enumValue(fieldName, field, value) } };
                return;
        }

        // Unknown field type (Json, Bytes, ...) — fall back to value-based detection
        const dateFilter = this.#filterDateTime(value);
        if (dateFilter) {
            filter[fieldName] = { not: dateFilter };
            return;
        }
        if (this.#looksLikeNumber(value)) {
            const numFilter = this.#filterNumber(value);
            filter[fieldName] = numFilter ? { not: numFilter } : { not: Number(value) };
            return;
        }
        filter[fieldName] = { not: this.#filterString(value) };
    }

    /**
     * Apply not:between: filter
     */
    #applyNotBetween(filter: Record<string, any>, fieldName: string, rangeValue: string, fieldType: string | null = null, zone: string | undefined = filterTimeZone(), decimal: boolean = false): void {
        const [start, end] = rangeValue.split(';').map((v: string) => v.trim());

        if (!start || !end) {
            throw new ErrorResponse(400, "between_requires_two_values");
        }

        const treatAsNumber = fieldType === 'Number' ||
            (fieldType === null && FILTER_PATTERNS.PURE_NUMBER.test(start) && FILTER_PATTERNS.PURE_NUMBER.test(end));

        if (treatAsNumber) {
            const startNum = this.#parseNumericValue(start, decimal);
            const endNum = this.#parseNumericValue(end, decimal);
            if (startNum == null || endNum == null) {
                throw new ErrorResponse(400, "invalid_filter_value", { field: fieldName, value: rangeValue, expected: 'number' });
            }
            filter.NOT = (filter.NOT || []).concat([{
                AND: [
                    { [fieldName]: { gte: startNum } },
                    { [fieldName]: { lte: endNum } },
                ],
            }]);
        } else if (fieldType === 'DateTime' || fieldType === null) {
            // The same days as between: — date-only values in the filter timezone
            let startDate: Date;
            let endDate: Date;
            try {
                startDate = this.#parseDate(start, zone);
                endDate = this.#parseDate(end, zone);
            } catch {
                throw new ErrorResponse(400, "invalid_date_range", { start, end });
            }
            filter.NOT = (filter.NOT || []).concat([{
                AND: [
                    { [fieldName]: { gte: startDate } },
                    { [fieldName]: { lte: endDate } },
                ],
            }]);
        } else {
            // between: makes no sense on Boolean/String/Enum columns
            throw new ErrorResponse(400, "invalid_filter_value", { field: fieldName, value: rangeValue, expected: 'number or date range' });
        }
    }

    /**
     * Apply a typed filter based on the field's declared type.
     * Falls back to value-based detection when the type isn't filterable by group (Json, Bytes, ...).
     */
    #applyTypedFilter(filter: Record<string, any>, fieldName: string, value: string, field?: DMMFField): void {
        const fieldType = this.#resolveFilterType(field);
        const decimal = field?.type === 'Decimal';

        // Arrays are handled per type so values can be coerced to the column type
        if (value.startsWith('[') && value.endsWith(']')) {
            const arr = this.#parseArrayValue(value, fieldType === 'Number');
            if ((fieldType === 'String' || fieldType === null) && arr.some((v: unknown) => typeof v === 'string' && v.includes('%'))) {
                // Each field's wildcard list is its own OR group nested under AND —
                // a shared top-level OR would merge groups across fields:
                // name=[%a%,%b%],title=[%c%,%d%] must mean (a OR b) AND (c OR d)
                const orGroup = arr.map((v: unknown) => ({ [fieldName]: this.#filterString(String(v), fieldType === null) }));
                if (!filter.AND) filter.AND = [];
                filter.AND.push({ OR: orGroup });
            } else {
                filter[fieldName] = { in: this.#coerceArrayValues(arr, fieldName, fieldType, field) };
            }
            return;
        }

        switch (fieldType) {
            case 'Number': {
                const numFilter = this.#filterNumber(value, decimal);
                if (!numFilter) {
                    throw new ErrorResponse(400, "invalid_filter_value", { field: fieldName, value, expected: 'number' });
                }
                filter[fieldName] = numFilter;
                return;
            }
            case 'DateTime':
                filter[fieldName] = this.#buildDateCondition(fieldName, value, field);
                return;
            case 'Boolean':
                filter[fieldName] = { equals: this.#parseBooleanValue(fieldName, value) };
                return;
            case 'String':
                filter[fieldName] = this.#filterString(value, false);
                return;
            case 'Enum':
                // Wildcards aren't supported on enum columns — exact match only
                filter[fieldName] = { equals: this.#enumValue(fieldName, field, value) };
                return;
        }

        // A JSON column matches a JSON value — Prisma has no wildcards for it
        if (field?.type === 'Json' && /^%|%$/.test(value)) {
            throw new ErrorResponse(400, "invalid_filter_value", { field: fieldName, value, expected: 'a JSON value or #NULL' });
        }

        // Unknown field type — value-based detection (legacy behavior)
        const hasDateOperator = FILTER_PATTERNS.DATE_OPS.some((op: string) => value.startsWith(op));
        const isIsoDate = FILTER_PATTERNS.ISO_DATE.test(value);
        const isBetweenWithDates = value.startsWith('between:') && this.#looksLikeDateRange(value);

        if (hasDateOperator || isIsoDate || isBetweenWithDates) {
            const dateFilter = this.#filterDateTime(value);
            if (dateFilter) {
                filter[fieldName] = dateFilter;
                return;
            }
        }

        if (this.#looksLikeNumber(value)) {
            const numFilter = this.#filterNumber(value);
            if (numFilter) {
                filter[fieldName] = numFilter;
                return;
            }
            // Plain number
            if (!isNaN(value as unknown as number)) {
                filter[fieldName] = { equals: Number(value) };
                return;
            }
        }

        filter[fieldName] = this.#filterString(value);
    }

    /**
     * Build a Prisma condition for a DateTime column.
     * Supports date operators (before:/after:/from:/to:/on:/between:), plain datetimes,
     * and date-only values (which match the entire day).
     */
    #buildDateCondition(fieldName: string, value: string, field?: DMMFField): Record<string, any> {
        const zone = dateZone(field);
        const opFilter = this.#filterDateTime(value, zone);
        if (opFilter) {
            return opFilter;
        }

        // A date operator was present but produced no filter (e.g. between: with two numbers)
        if (FILTER_PATTERNS.DATE_OPS.some((op: string) => value.startsWith(op))) {
            throw new ErrorResponse(400, "invalid_date_format", { field: fieldName, value });
        }

        let date: Date;
        try {
            date = this.#parseDate(value, zone);
        } catch {
            throw new ErrorResponse(400, "invalid_filter_value", { field: fieldName, value, expected: 'date' });
        }

        // Date-only values match the entire day (same semantics as 'on:')
        if (FILTER_PATTERNS.DATE_ONLY.test(value)) {
            return this.#calendarDay(value, date, zone);
        }
        return { equals: date };
    }

    /**
     * Parse a boolean filter value, rejecting anything that isn't a boolean literal
     */
    #parseBooleanValue(fieldName: string, value: string): boolean {
        if (value === 'true' || value === '1') return true;
        if (value === 'false' || value === '0') return false;
        throw new ErrorResponse(400, "invalid_filter_value", { field: fieldName, value, expected: 'boolean' });
    }

    /**
     * Coerce array filter values ([a,b,c] / not:[a,b,c]) to the column type
     */
    #coerceArrayValues(arr: any[], fieldName: string, fieldType: string | null, field?: DMMFField): any[] {
        switch (fieldType) {
            case 'Number':
                return arr.map((v: any) => {
                    const parsed = this.#parseNumericValue(String(v), field?.type === 'Decimal');
                    if (parsed == null) {
                        throw new ErrorResponse(400, "invalid_filter_value", { field: fieldName, value: String(v), expected: 'number' });
                    }
                    return parsed;
                });
            case 'DateTime':
                return arr.map((v: any) => {
                    try {
                        return this.#parseDate(String(v));
                    } catch {
                        throw new ErrorResponse(400, "invalid_filter_value", { field: fieldName, value: String(v), expected: 'date' });
                    }
                });
            case 'Boolean':
                return arr.map((v: any) => typeof v === 'boolean' ? v : this.#parseBooleanValue(fieldName, String(v)));
            case 'String':
                return arr.map((v: any) => typeof v === 'string' ? this.#safeDecode(v) : String(v));
            case 'Enum':
                return arr.map((v: any) => this.#enumValue(fieldName, field, String(v)));
            default:
                return arr;
        }
    }

    /** A value of an enum column: one of its values (400 otherwise — not Prisma's validation text) */
    #enumValue(fieldName: string, field: DMMFField | undefined, value: string): string {
        const decoded = this.#safeDecode(value);
        const values = field ? dmmf.getEnumValues?.(field.type) : null;
        if (values && !values.includes(decoded)) {
            throw new ErrorResponse(400, "invalid_filter_value", { field: fieldName, value: decoded.slice(0, 100), expected: values.join(', ') });
        }
        return decoded;
    }

    /**
     * Decode a URL-encoded value, tolerating literal '%' characters that aren't valid escapes
     */
    #safeDecode(value: string): string {
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }

    /**
     * Check if value looks like a number or numeric operator
     */
    #looksLikeNumber(value: string): boolean {
        return !isNaN(value as unknown as number) || FILTER_PATTERNS.NUMERIC_OPS.some((op: string) => value.startsWith(op));
    }

    /**
     * Check if between: value contains dates
     */
    #looksLikeDateRange(value: string): boolean {
        const rangeValue = value.substring(8); // Remove 'between:'
        return (value.includes('-') && value.includes('T')) ||
            rangeValue.split(';').some((part: string) => FILTER_PATTERNS.ISO_DATE.test(part.trim()));
    }

    /**
     * Parse array value from string. `numeric`: elements stay text, to be read by the column's
     * type — JSON would round 12345678901234.5678 and integers past 2^53.
     */
    #parseArrayValue(value: string, numeric: boolean = false): any[] {
        let arr: any[];
        try {
            const parsed = numeric ? null : JSON.parse(value);
            arr = Array.isArray(parsed) ? parsed : value.slice(1, -1).split(',').map((v: string) => v.trim());
        } catch {
            arr = value.slice(1, -1).split(',').map((v: string) => v.trim());
        }

        // Bound the array so a single param can't produce an unbounded IN/OR clause
        if (arr.length > MAX_FILTER_ARRAY_LENGTH) {
            throw new ErrorResponse(400, "filter_array_too_large", { max: MAX_FILTER_ARRAY_LENGTH, received: arr.length });
        }

        // Reject non-primitive elements — JSON.parse would otherwise let a client smuggle
        // structured objects/arrays (e.g. [{"gt":5}]) into the query on untyped columns
        for (const el of arr) {
            if (el !== null && typeof el === 'object') {
                throw new ErrorResponse(400, "invalid_filter_value", { field: '', value: String(value), expected: 'array of scalar values' });
            }
        }

        return arr;
    }

    /**
     * Parse numeric filter operators
     */
    #filterNumber(value: string, decimal: boolean = false): Record<string, number | bigint | string> | null {
        const foundOperator = FILTER_PATTERNS.NUMERIC_OPS.find((op: string) => value.startsWith(op));
        let numValue: string = value;
        let prismaOp = 'equals';

        if (foundOperator) {
            numValue = value.substring(foundOperator.length);
            switch (foundOperator) {
                case 'lt:': prismaOp = 'lt'; break;
                case 'lte:': prismaOp = 'lte'; break;
                case 'gt:': prismaOp = 'gt'; break;
                case 'gte:': prismaOp = 'gte'; break;
                case 'eq:': prismaOp = 'equals'; break;
                case 'ne:': prismaOp = 'not'; break;
                case 'between:': {
                    const parts = numValue.split(';').map((v: string) => v.trim());
                    const [startStr, endStr] = parts;
                    // Require exactly two values — a clean 400, mirroring not:between: (was a 500 crash)
                    if (!startStr || !endStr) {
                        throw new ErrorResponse(400, "between_requires_two_values");
                    }
                    const start = this.#parseNumericValue(startStr, decimal);
                    const end = this.#parseNumericValue(endStr, decimal);
                    if (start == null || end == null) return null;
                    return { gte: start, lte: end };
                }
            }
        }

        const parsed = this.#parseNumericValue(numValue, decimal);
        if (parsed == null) return null;

        return { [prismaOp]: parsed };
    }

    /**
     * Parse a numeric string, returning BigInt for integers beyond safe range — and for a
     * Decimal column the number's text: a float would round 12345678901234.5678
     */
    #parseNumericValue(value: string, decimal: boolean = false): number | bigint | string | null {
        if (value == null) return null;
        if (decimal) {
            const text = value.trim();
            return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text) ? text : null;
        }
        if (value.includes('.')) {
            const num = parseFloat(value);
            return isNaN(num) ? null : num;
        }
        const num = Number(value);
        if (isNaN(num)) return null;
        if (!Number.isSafeInteger(num)) {
            try { return BigInt(value); } catch { return null; }
        }
        return num;
    }

    /**
     * Parse date/datetime filter operators
     */
    #filterDateTime(value: string, zone: string | undefined = filterTimeZone()): Record<string, Date | Record<string, Date>> | null {
        const foundOperator = FILTER_PATTERNS.DATE_OPS.find((op: string) => value.startsWith(op));
        if (!foundOperator) {
            return null;
        }

        const operatorValue = value.substring(foundOperator.length);

        try {
            // Map operators to Prisma comparison operators
            const simpleOperatorMap: Record<string, string> = {
                'before:': 'lt',
                'after:': 'gt',
                'from:': 'gte',
                'to:': 'lte',
            };

            // Handle simple date operators
            if (simpleOperatorMap[foundOperator]) {
                const date = this.#parseDate(operatorValue, zone);
                return { [simpleOperatorMap[foundOperator]]: date };
            }

            // Handle 'on:' - match entire day
            if (foundOperator === 'on:') {
                return this.#calendarDay(operatorValue, this.#parseDate(operatorValue, zone), zone);
            }

            // Handle 'between:'
            if (foundOperator === 'between:') {
                const [start, end] = operatorValue.split(';').map((d: string) => d.trim());
                if (!start || !end) {
                    throw new ErrorResponse(400, "between_requires_two_values");
                }

                // If both values are pure numbers, let #filterNumber handle it
                if (FILTER_PATTERNS.PURE_NUMBER.test(start) && FILTER_PATTERNS.PURE_NUMBER.test(end)) {
                    return null;
                }

                const startDate = this.#parseDate(start, zone);
                const endDate = this.#parseDate(end, zone);
                return { gte: startDate, lte: endDate };
            }

            return null;
        } catch (error: any) {
            if (error instanceof ErrorResponse) throw error;
            throw new ErrorResponse(400, "invalid_date_format", { value, error: error.message });
        }
    }

    /**
     * Parse a date string and validate it. With a zone (API_TIMEZONE, or UTC for DATE columns),
     * a date-only value means the start of that day in the zone (instead of UTC midnight).
     */
    #parseDate(dateStr: string, zone: string | undefined = filterTimeZone()): Date {
        if (zone) {
            const day = dayRange(dateStr, zone);
            if (day) return day.gte;
        }
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) {
            throw new Error(`Invalid date: ${dateStr}`);
        }
        return date;
    }

    /**
     * The calendar day a filter value names, as a [gte, lt) range. A date-only value is read
     * from the string itself; a datetime selects the day that contains it — both in
     * API_TIMEZONE when set, else in the server's timezone.
     */
    #calendarDay(value: string, parsed: Date, zone: string | undefined = filterTimeZone()): { gte: Date; lt: Date } {
        const fromString = dayRange(value, zone);
        if (fromString) return fromString;
        if (!zone) {
            return {
                gte: startOfDay(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate(), undefined),
                lt: startOfDay(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate() + 1, undefined),
            };
        }
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed);
        return dayRange(parts, zone)!;
    }

    /**
     * Parse string filters with wildcard support and URL decoding.
     * Boolean literals are only interpreted when the field type is unknown (legacy detection);
     * on String columns "true"/"false" stay strings.
     */
    #filterString(value: string, allowBooleanLiterals: boolean = true): Record<string, string> | boolean {
        // Handle boolean literals (value-based detection only)
        if (allowBooleanLiterals) {
            if (value === 'true') return true;
            if (value === 'false') return false;
        }

        const startsWithWildcard = value.startsWith('%');
        const endsWithWildcard = value.endsWith('%');

        // %value% -> contains
        if (startsWithWildcard && endsWithWildcard) {
            return { contains: this.#safeDecode(value.slice(1, -1)) };
        }
        // %value -> endsWith
        if (startsWithWildcard) {
            return { endsWith: this.#safeDecode(value.slice(1)) };
        }
        // value% -> startsWith
        if (endsWithWildcard) {
            return { startsWith: this.#safeDecode(value.slice(0, -1)) };
        }
        // exact match
        return { equals: this.#safeDecode(value) };
    }

    /**
     * Build base include content with omit fields and ACL filter.
     * Returns denied=true when ACL explicitly denies access (returns false).
     *
     * ACL `where` enforcement on includes:
     * - list relations: supported (rows are filtered out)
     * - OPTIONAL to-one relations: supported — the relation returns null when the filter doesn't match
     * - REQUIRED to-one relations: Prisma cannot filter these (the payload type guarantees the row),
     *   so a row-level ACL access filter CANNOT be enforced here (field-level omit still applies).
     *   A warning is logged once per relation; enforce required-to-one row rules in the parent
     *   model's access filter or via middleware.
     */
    #buildBaseIncludeContent(
        relation: RelationConfig,
        user: any,
        parentModel: string
    ): { content: Record<string, any>; hasContent: boolean; denied: boolean } {
        const acl = getAcl();
        const content: Record<string, any> = {};
        let hasContent = false;
        const isListRelation = this.#isListRelation(parentModel, relation.name);

        // Cap included list relations so one parent row can't pull unbounded children
        if (isListRelation && API_INCLUDE_RESULT_LIMIT > 0) {
            content.take = API_INCLUDE_RESULT_LIMIT;
            hasContent = true;
        }

        // Check ACL access for the related model (system users bypass — never run the
        // app's access-filter builder with the null-id system identity)
        if (!isSystemUser(user) && relation.object && acl.model[relation.object]?.getAccessFilter) {
            const accessFilter = guardAclFilter(acl.model[relation.object].getAccessFilter!(user), relation.object, 'getAccessFilter');

            // ACL explicitly denies access — skip this relation entirely
            if (accessFilter === false) {
                return { content: {}, hasContent: false, denied: true };
            }

            // Prisma accepts where on list includes and on optional to-one includes.
            // Optionality must be explicit (isRequired === false) — when the relation field
            // metadata is unavailable we treat it as required rather than risk an invalid query.
            const parentRelField = this.#getRelatedModelFields(parentModel)[relation.name];
            const isOptionalToOne = !isListRelation && parentRelField?.isRequired === false;

            if ((isListRelation || isOptionalToOne) && accessFilter && typeof accessFilter === 'object') {
                // The related model's rule as it is — including conditions through the relation
                // back to this parent: the parent row passed the parent's rule, not this one
                const cleanedFilter = this.cleanFilter(accessFilter);
                if (cleanedFilter && typeof cleanedFilter === 'object' && Object.keys(cleanedFilter).length > 0) {
                    content.where = cleanedFilter;
                    hasContent = true;
                }
            } else if (!isListRelation && !isOptionalToOne && accessFilter && typeof accessFilter === 'object') {
                const cleanedFilter = this.cleanFilter(accessFilter);
                if (cleanedFilter && typeof cleanedFilter === 'object' && Object.keys(cleanedFilter).length > 0) {
                    const warnKey = `${parentModel}.${relation.name}`;
                    if (!warnedToOneAclIncludes.has(warnKey)) {
                        warnedToOneAclIncludes.add(warnKey);
                        Logger.warn(`ACL access filter for '${relation.object}' cannot be enforced on required to-one include '${warnKey}' (Prisma cannot filter required to-one relations) — only field-level omit applies`);
                    }
                }
            }
        }

        // Add omit fields for this relation if available
        const omitFields = this.getRelatedOmit(relation.object, user);
        if (Object.keys(omitFields).length > 0) {
            content.omit = omitFields;
            hasContent = true;
        }

        return { content, hasContent, denied: false };
    }

    /**
     * Check if include content has meaningful properties
     */
    #hasIncludeContent(content: Record<string, any>): boolean {
        return content.omit || content.where || content.take != null ||
            (content.include && Object.keys(content.include).length > 0);
    }

    /**
     * Get relationships configuration for a specific model
     */
    #getRelationshipsForModel(modelName: string): RelationConfig[] {
        return modelName ? dmmf.buildRelationships(modelName) : [];
    }

    /**
     * Build top-level only relationship include (no deep relations).
     * Returns null when ACL denies access to the relation.
     */
    #includeTopLevelOnly(
        relation: RelationConfig,
        user: any,
        parentModel: string | null = null
    ): Record<string, any> | true | null {
        const currentParent = parentModel || this.name;
        const { content, hasContent, denied } = this.#buildBaseIncludeContent(relation, user, currentParent);
        if (denied) return null;
        return hasContent ? content : true;
    }

    /**
     * Build selective deep relationship include based on dot notation paths
     */
    #includeSelectiveDeepRelationships(
        relation: RelationConfig,
        user: any,
        deepPaths: string[],
        parentModel: string | null = null
    ): Record<string, any> | true | null {
        const currentParent = parentModel || this.name;
        const { content, denied } = this.#buildBaseIncludeContent(relation, user, currentParent);
        if (denied) return null;
        content.include = {};

        // Process deep paths if any
        if (deepPaths?.length > 0) {
            // Group paths by first-level relation
            const pathsByRelation = this.#groupPathsByFirstLevel(deepPaths);
            const childRelationships = this.#getRelationshipsForModel(relation.object);

            for (const [relationName, paths] of Object.entries(pathsByRelation)) {
                const childRelation = childRelationships.find((r: RelationConfig) => r.name === relationName);
                if (!childRelation) {
                    throw new ErrorResponse(400, "relation_not_exist", { relation: relationName, modelName: relation.object });
                }

                const childPaths = (paths as string[]).filter((p: string) => p !== '');
                const childInclude = childPaths.length > 0
                    ? this.#includeSelectiveDeepRelationships(childRelation, user, childPaths, relation.object)
                    : this.#includeTopLevelOnly(childRelation, user, relation.object);

                // Skip denied child relations
                if (childInclude !== null) {
                    content.include[relationName] = childInclude;
                }
            }
        }

        return this.#hasIncludeContent(content) ? content : true;
    }

    /**
     * Group dot-notation paths by their first level
     */
    #groupPathsByFirstLevel(paths: string[]): Record<string, string[]> {
        const grouped: Record<string, string[]> = {};
        for (const path of paths) {
            const parts = path.split('.');
            const firstLevel = parts[0];
            if (!grouped[firstLevel]) {
                grouped[firstLevel] = [];
            }
            grouped[firstLevel].push(parts.length > 1 ? parts.slice(1).join('.') : '');
        }
        return grouped;
    }

    /**
     * Build include object for related data with access controls
     */
    include(
        include: string | { query?: string; rule?: Record<string, unknown> } = "ALL",
        user: any
    ): Record<string, unknown> {
        const include_query = typeof include === 'string' ? include : typeof include === 'object' ? include.query : null;
        const exclude_rule = typeof include === 'object' ? include.rule : null;
        if (include_query) {
            let includeRelated: Record<string, any> = {};

            if (include_query === "ALL") {
                // Load all first-level relationships only (no deep nesting to avoid endless relation loading)
                includeRelated = this.relatedObjects.reduce((acc: Record<string, any>, curr: RelationConfig) => {
                    let rel: any = this.#includeTopLevelOnly(curr, user);
                    // Skip relations where ACL denies access
                    if (rel === null) return acc;
                    if (exclude_rule && exclude_rule[curr.name]) {
                        if (typeof rel === 'object' && rel !== null) {
                            // Merge with an existing ACL where instead of overwriting it
                            rel.where = rel.where ? { AND: [rel.where, exclude_rule[curr.name]] } : exclude_rule[curr.name];
                        } else {
                            rel = { where: exclude_rule[curr.name] };
                        }
                    }
                    acc[curr.name] = rel;
                    return acc;
                }, {});
            } else {
                // Parse dot notation includes (e.g., "author.profile,tags")
                const includeList = include_query.split(',').map((item: string) => item.trim());
                const topLevelIncludes = new Set<string>();
                const deepIncludes: Record<string, string[]> = {};

                // Separate top-level and deep includes
                includeList.forEach((item: string) => {
                    const parts = item.split('.');
                    const topLevel = parts[0];
                    topLevelIncludes.add(topLevel);

                    if (parts.length > 1) {
                        if (!deepIncludes[topLevel]) {
                            deepIncludes[topLevel] = [];
                        }
                        deepIncludes[topLevel].push(parts.slice(1).join('.'));
                    }
                });

                // A misspelt relation must not silently return less than asked for
                for (const name of topLevelIncludes) {
                    if (!this.relatedObjects.some((r: RelationConfig) => r.name === name)) {
                        throw new ErrorResponse(400, "relation_not_exist", { relation: name, modelName: this.name });
                    }
                }

                // Build include object for each top-level relation
                this.relatedObjects.forEach((curr: RelationConfig) => {
                    if (topLevelIncludes.has(curr.name)) {
                        let rel: any;

                        if (deepIncludes[curr.name]) {
                            // Build selective deep relationships
                            rel = this.#includeSelectiveDeepRelationships(curr, user, deepIncludes[curr.name]);
                        } else {
                            // Only include top-level (no deep relationships)
                            rel = this.#includeTopLevelOnly(curr, user);
                        }

                        // Skip relations where ACL denies access
                        if (rel === null) return;

                        if (exclude_rule && exclude_rule[curr.name]) {
                            if (typeof rel === 'object' && rel !== null) {
                                // Merge with an existing ACL where instead of overwriting it
                                rel.where = rel.where ? { AND: [rel.where, exclude_rule[curr.name]] } : exclude_rule[curr.name];
                            } else {
                                rel = { where: exclude_rule[curr.name] };
                            }
                        }
                        includeRelated[curr.name] = rel;
                    }
                });
            }

            return includeRelated;
        }
        return {};
    }

    /**
     * Build omit object for hiding fields based on user role
     */
    omit(user: any, inaccessible_fields: string[] | null = null): Record<string, boolean> {
        if (inaccessible_fields != null) {
            if (!Array.isArray(inaccessible_fields)) return {};
            return inaccessible_fields.reduce((acc: Record<string, boolean>, curr: string) => {
                acc[curr] = true;
                return acc;
            }, {});
        }
        return this.getRelatedOmit(this.name, user);
    }

    /**
     * Get omit fields for a related object based on user role
     */
    getRelatedOmit(relatedModelName: string, user: any): Record<string, boolean> {
        // System users bypass ACL — including read-side field hiding, consistent with every
        // other ACL surface (access/update/delete filters, canCreate, writable, filter/sort omit).
        if (isSystemUser(user)) return {};
        const acl = getAcl();
        if (acl.model[relatedModelName]?.getOmitFields) {
            const omit_fields = acl.model[relatedModelName].getOmitFields!(user);
            if (omit_fields && Array.isArray(omit_fields)) {
                return omit_fields.reduce((acc: Record<string, boolean>, curr: string) => {
                    acc[curr] = true;
                    return acc;
                }, {});
            }
        }
        return {};
    }

    /**
     * Parse a fields string into scalar fields and relation field groups.
     * e.g., "id,name,posts.title,posts.content,author.name"
     * → { scalars: ['id','name'], relations: Map { 'posts' => ['title','content'], 'author' => ['name'] } }
     */
    #parseFields(fields: string): { scalars: string[]; relations: Map<string, string[]> } {
        const scalars: string[] = [];
        const relations = new Map<string, string[]>();

        const parts = fields.split(',').map(f => f.trim()).filter(f => f.length > 0);

        for (const part of parts) {
            const dotIndex = part.indexOf('.');
            if (dotIndex === -1) {
                if (!scalars.includes(part)) scalars.push(part);
            } else {
                const relationName = part.substring(0, dotIndex);
                const fieldName = part.substring(dotIndex + 1);
                if (!relations.has(relationName)) {
                    relations.set(relationName, []);
                }
                const arr = relations.get(relationName)!;
                if (!arr.includes(fieldName)) arr.push(fieldName);
            }
        }

        return { scalars, relations };
    }

    /**
     * Recursively set a nested field path into a select object.
     * e.g. "author.name" on obj → obj.author = { select: { name: true } }
     */
    #setNestedField(obj: Record<string, any>, fieldPath: string): void {
        const dotIdx = fieldPath.indexOf('.');
        if (dotIdx === -1) {
            obj[fieldPath] = true;
        } else {
            const key = fieldPath.substring(0, dotIdx);
            const rest = fieldPath.substring(dotIdx + 1);
            if (!obj[key]) {
                obj[key] = { select: {} };
            } else if (obj[key] === true) {
                obj[key] = { select: {} };
            }
            this.#setNestedField(obj[key].select, rest);
        }
    }

    /**
     * Build a Prisma select object for a model from field paths, enforcing ACL at EVERY level:
     * - omitted fields (getOmitFields) are dropped
     * - denied relations (getAccessFilter → false) are skipped
     * - list / optional to-one relations get the ACL where clause (+ include row cap)
     * - a known scalar used as a relation path throws 400
     *
     * Keys that don't resolve in the DMMF metadata are passed through untouched and left
     * to Prisma's own validation — real DMMF is complete, so in production every key is
     * enforced; the passthrough only matters for partial metadata (e.g. test mocks).
     */
    #buildSelectForModel(modelName: string, fieldPaths: string[], user: any, depth: number): Record<string, any> {
        if (depth > MAX_NESTING_DEPTH) {
            throw new ErrorResponse(400, "max_nesting_depth_exceeded", { depth: MAX_NESTING_DEPTH });
        }

        const select: Record<string, any> = {};
        const omit = this.getRelatedOmit(modelName, user);
        const modelFields = this.#getRelatedModelFields(modelName);
        const modelRelations = dmmf.buildRelationships(modelName);

        // Group paths into direct keys and relation sub-paths
        const scalars: string[] = [];
        const grouped = new Map<string, string[]>();
        for (const path of fieldPaths) {
            const dotIdx = path.indexOf('.');
            if (dotIdx === -1) {
                scalars.push(path);
            } else {
                const head = path.substring(0, dotIdx);
                if (!grouped.has(head)) grouped.set(head, []);
                grouped.get(head)!.push(path.substring(dotIdx + 1));
            }
        }

        for (const key of scalars) {
            if (omit[key]) continue; // Hidden by ACL

            const rel = modelRelations.find((r: RelationConfig) => r.name === key);
            if (rel) {
                // Relation requested as a leaf — include it whole, with ACL content
                const { content, hasContent, denied } = this.#buildBaseIncludeContent(rel, user, modelName);
                if (denied) continue;
                select[key] = hasContent ? content : true;
                continue;
            }

            select[key] = true;
        }

        for (const [relName, subPaths] of grouped) {
            if (omit[relName]) continue; // Hidden by ACL

            const rel = modelRelations.find((r: RelationConfig) => r.name === relName);
            if (rel) {
                const { content, denied } = this.#buildBaseIncludeContent(rel, user, modelName);
                if (denied) continue;

                const nestedSelect = this.#buildSelectForModel(rel.object, subPaths, user, depth + 1);
                if (Object.keys(nestedSelect).length === 0) continue; // Everything hidden by ACL

                const entry: Record<string, any> = { select: nestedSelect };
                if (content.where) entry.where = content.where;
                if (content.take != null) entry.take = content.take;
                select[relName] = entry;
                continue;
            }

            // A known scalar can never be a relation path
            if (modelFields[relName] && modelFields[relName].kind !== 'object') {
                throw new ErrorResponse(400, "invalid_relation_field", { field: relName, modelName });
            }

            // Unknown key — pass through blind and let Prisma validate
            const blind: Record<string, any> = {};
            for (const subPath of subPaths) {
                this.#setNestedField(blind, subPath);
            }
            select[relName] = { select: blind };
        }

        return select;
    }

    /**
     * Build the Prisma field selection clause.
     * When `fields` is specified, returns `{ select: ... }` (Prisma select mode).
     * When `fields` is null/empty, returns `{ include: ..., omit: ... }` (current behavior).
     *
     * Prisma does NOT support `select` and `include` together.
     * When fields are specified, everything goes through `select`.
     *
     * @param fields  - Comma-separated field list with dot notation for relations, or null
     * @param include - Include string ("ALL", "author,posts", etc.)
     * @param user    - User for ACL filters
     */
    buildFieldSelection(
        fields: string | null,
        include: string | Record<string, any>,
        user: any
    ): { select?: Record<string, any>; include?: Record<string, any>; omit?: Record<string, any> } {
        // No fields specified → current behavior
        if (!fields || fields.trim() === '') {
            const includeClause = this.include(include, user);
            const omitClause = this.omit(user);
            return {
                ...(Object.keys(includeClause).length > 0 ? { include: includeClause } : {}),
                ...(Object.keys(omitClause).length > 0 ? { omit: omitClause } : {}),
            };
        }

        const { scalars, relations } = this.#parseFields(fields);
        const includeStr: string = typeof include === 'string'
            ? include
            : (include && typeof (include as any).query === 'string' ? (include as any).query as string : '');

        // Determine which relations are available from the include param
        const availableRelations = new Set<string>();
        const isAll = includeStr.trim() === 'ALL';

        if (isAll) {
            for (const rel of this.relatedObjects) {
                availableRelations.add(rel.name);
            }
        } else if (includeStr.trim() !== '') {
            const includeList = includeStr.split(',').map(s => s.trim());
            for (const item of includeList) {
                availableRelations.add(item.split('.')[0]);
            }
        }

        // A relation named in fields (posts.title) is included — no need to list it in include
        // as well; listing it there too is the same relation (a set)
        for (const relationName of relations.keys()) availableRelations.add(relationName);

        // Build select object
        const select: Record<string, any> = {};

        // Add top-level omit fields to exclude from selection
        const omitFields = this.omit(user);

        // Add scalar fields — a relation named alone (fields=id,author) is the whole relation,
        // included under its model's rule as include=author is
        for (const field of scalars) {
            if (omitFields[field]) continue;
            if (this.getRelationByName(field)) {
                availableRelations.add(field);
                continue;
            }
            select[field] = true;
        }

        // Add relations from the include param and the fields
        for (const relationName of availableRelations) {
            const rel = this.getRelationByName(relationName);
            if (!rel) throw new ErrorResponse(400, "relation_not_exist", { relation: relationName, modelName: this.name });

            // Get ACL content for this relation (where, omit, row cap)
            const { content, hasContent, denied } = this.#buildBaseIncludeContent(rel, user, this.name);
            if (denied) continue;

            const relationFields = relations.get(relationName);

            if (relationFields && relationFields.length > 0) {
                // User specified specific fields for this relation — build the nested select
                // with ACL enforced at every level (omit, denied models, access-filter where)
                const relSelect = this.#buildSelectForModel(rel.object, relationFields, user, 1);
                if (Object.keys(relSelect).length === 0) {
                    // Everything requested is hidden by ACL — skip the relation entirely
                    continue;
                }

                const entry: Record<string, any> = { select: relSelect };
                if (content.where) entry.where = content.where;
                if (content.take != null) entry.take = content.take;
                select[relationName] = entry;
            } else {
                // No specific fields → the relation with all its fields, under its rule
                select[relationName] = hasContent ? content : true;
            }
        }

        return { select };
    }

    /**
     * Validate and limit result count
     */
    take(limit: number): number {
        if (!Number.isInteger(limit) || limit <= 0) {
            throw new ErrorResponse(400, "invalid_limit");
        }
        return limit > QueryBuilder.API_RESULT_LIMIT ? QueryBuilder.API_RESULT_LIMIT : limit;
    }

    /**
     * Build sort object for ordering results.
     * Validates the relation chain and terminal field against the schema:
     * - every path segment must be an existing relation
     * - to-many relations can only be ordered by '_count' (as the terminal segment)
     * - the terminal field must be a scalar on the resolved model
     */
    sort(sortBy: string, sortOrder: string, user: any = null): Record<string, unknown> {
        if (typeof sortBy !== 'string') {
            throw new ErrorResponse(400, "sortby_must_be_string", { type: typeof sortBy });
        }
        if (typeof sortOrder !== 'string' || (sortOrder != 'desc' && sortOrder != 'asc')) {
            throw new ErrorResponse(400, "sortorder_invalid", { value: sortOrder });
        }
        const relation_chain = sortBy.split('.').map((e: string) => e.trim());
        const field_name = relation_chain.pop()!;

        // Walk the relation chain, validating each segment
        let currentModel = this.name;
        let lastRelationIsList = false;
        for (let i = 0; i < relation_chain.length; i++) {
            const relationName = relation_chain[i];

            // Omitted relations must not be traversable for sorting either
            this.#assertQueryableField(relationName, currentModel, user);

            const relations: RelationConfig[] = currentModel === this.name
                ? this.relatedObjects
                : dmmf.buildRelationships(currentModel);
            const rel = relations.find((r: RelationConfig) => r.name === relationName);

            if (!rel) {
                throw new ErrorResponse(400, "invalid_sort_field", { sortBy, relation: relationName, modelName: currentModel });
            }

            // Not through a model the rule denies (an order can't be limited to readable rows —
            // Prisma takes no filter in orderBy — so a restricted model's rows all count)
            this.#relationAccess(rel.object, relationName, currentModel, user);

            lastRelationIsList = rel.isList || dmmf.isListRelation(currentModel, rel.name);

            // To-many relations can only be ordered by their count, directly under the relation
            if (lastRelationIsList && (i < relation_chain.length - 1 || field_name !== '_count')) {
                throw new ErrorResponse(400, "invalid_sort_field", {
                    sortBy,
                    relation: relationName,
                    modelName: currentModel,
                    hint: `To-many relations can only be sorted by '${relationName}._count'`,
                });
            }

            currentModel = rel.object;
        }

        // Validate the terminal field
        if (field_name === '_count') {
            if (!lastRelationIsList) {
                throw new ErrorResponse(400, "invalid_sort_field", { sortBy, modelName: currentModel, hint: "'_count' is only valid on to-many relations" });
            }
        } else {
            const targetFields = currentModel === this.name ? this.fields : this.#getRelatedModelFields(currentModel);
            const field = targetFields[field_name];
            if (!field || field.kind === 'object') {
                throw new ErrorResponse(400, "invalid_sort_field", { sortBy, field: field_name, modelName: currentModel });
            }

            // Sorting by an ACL-hidden field leaks value ordering — reject
            this.#assertQueryableField(field_name, currentModel, user);
        }

        const sort: Record<string, any> = {};
        let curr: Record<string, any> = sort;
        for (let i = 0; i < relation_chain.length; i++) {
            curr[relation_chain[i]] = {};
            curr = curr[relation_chain[i]];
        }
        curr[field_name] = sortOrder;

        return sort;
    }

    /**
     * Process data for create operation with relation handling
     * Transforms nested relation data into Prisma create/connect syntax
     * Does NOT mutate the input data - returns a new transformed object
     *
     * SECURITY NOTE: when `user` is null or a system user, ALL ACL checks (canCreate,
     * omit, writable whitelist, connect access filters) are skipped. Model always passes a
     * user (defaulting to the framework system user, which bypasses ACL) — only pass null
     * deliberately for trusted internal transformations.
     *
     * `stripped`: the top level was cleared of what the user may not write already (sanitizeRow)
     * — before middleware ran, so what a hook sets there stays.
     */
    create(data: Record<string, unknown>, user: any = null, { stripped = false }: { stripped?: boolean } = {}): Record<string, unknown> {
        // One working copy; the per-key processors edit it in place
        const result: Record<string, any> = { ...data };

        // Remove fields user shouldn't be able to set
        if (!stripped) this.#stripUnwritable(result, user);

        // The row's own values first — nested items take their foreign key back to it from them
        const own = this.#writeScalars(result, this.fields);
        for (const key of Object.keys(result)) {
            const field = this.fields[key];
            // Handle relation fields or unknown keys
            if (field == null || field.kind === 'object') {
                this.#processCreateRelation(result, key, user, own);
            }
        }
        // Foreign-key columns become connects of their relations
        this.#linkForeignKeys(result, this.relatedObjects, user, 'create', { model: this.name, whole: true });

        return result;
    }

    /**
     * The scalar values of a write as the database takes them (dates, integers past 2^53
     * refused) — set in `data`, and returned as the row's known values
     */
    #writeScalars(data: Record<string, any>, fields: Record<string, any>): Record<string, any> {
        const values: Record<string, any> = {};
        for (const [key, value] of Object.entries(data)) {
            const field = fields[key];
            if (field == null || field.kind === 'object') continue;
            // A JSON number past 2^53 has lost digits before it got here — strings carry them
            if (field.type === 'BigInt' && typeof value === 'number' && !Number.isSafeInteger(value)) {
                throw new ErrorResponse(400, "unsafe_integer", { field: key });
            }
            values[key] = data[key] = writeDate(field, value);
        }
        return values;
    }

    /**
     * Process a relation field for create operation (edits `data`, the caller's working copy)
     */
    #processCreateRelation(
        data: Record<string, any>,
        key: string,
        user: any = null,
        parent: Record<string, any> | null = null
    ): void {
        const relatedObject = this.getRelationByName(key);
        if (!relatedObject) {
            throw new ErrorResponse(400, "unexpected_key", { key });
        }

        if (!data[key]) return;

        this.#ensureRelations(relatedObject);

        if (Array.isArray(data[key])) {
            // Clone each item to avoid mutating original nested objects
            data[key] = this.#processCreateArrayRelation(
                data[key].map((item: Record<string, any>) => ({ ...item })), relatedObject, key, user, 0, parent
            );
        } else {
            // Clone the nested object to avoid mutating original
            data[key] = this.#processCreateSingleRelation(
                { ...data[key] }, relatedObject, key, user, 0, parent
            );
        }
    }

    /**
     * Process array relation for create operation. The items are rows of a new parent: created —
     * with the key they carry (409 when it is taken). An item with only its key links an
     * existing row instead, which moves it here: held to the related model's update rule as well
     * as its read rule. Not where the key includes the parent's: such rows can't exist yet.
     */
    #processCreateArrayRelation(
        items: Record<string, any>[],
        relatedObject: RelationConfig,
        relationName: string,
        user: any = null,
        depth: number = 0,
        parent: Record<string, any> | null = null
    ): Record<string, any> {
        if (depth > MAX_NESTING_DEPTH) {
            throw new ErrorResponse(400, "max_nesting_depth_exceeded", { depth: MAX_NESTING_DEPTH });
        }

        this.#ensureRelations(relatedObject);
        for (const item of items) {
            this.#assertKnownFields(item, relatedObject.object, relationName);
            this.#dropBackReference(item, relatedObject);
        }

        const model = relatedObject.object;
        const keyFields = this.#keyFields(model);
        const inherited = this.#inherited(relatedObject, parent);
        const keyed = (item: Record<string, any>): Record<string, any> => ({ ...item, ...inherited });
        const linksOnly = (item: Record<string, any>): boolean => !this.#keyIncludesParent(relatedObject, keyFields)
            && keyFields.every((field: string) => keyed(item)[field] != null)
            && Object.keys(item).every((key: string) => keyFields.includes(key));

        const { modelAcl: relatedAcl, accessFilter, updateFilter, omitFields } = this.#resolveAclContext(model, user);

        // The key addresses records in nested payloads — exempt from the writable whitelist
        const clean = (item: Record<string, any>): Record<string, any> => {
            const cleaned: Record<string, any> = { ...item };
            for (const field of omitFields) {
                delete cleaned[field];
            }
            this.#applyWritableWhitelist(cleaned, relatedAcl, user, keyFields);
            return cleaned;
        };

        const createItems = items.filter((item: Record<string, any>) => !linksOnly(item));
        const connectItems = items.filter(linksOnly);
        const result: Record<string, any> = {};

        if (createItems.length > 0) {
            this.#assertCanCreateAll(createItems, relatedAcl, user, model);
            result.create = createItems.map((item: Record<string, any>) =>
                this.#nestedData(clean(item), relatedObject, user, 'create', relationName, depth, inherited));
        }

        if (connectItems.length > 0) {
            const rules: [any, string][] = [[accessFilter, 'no_permission']];
            if (linkRewritesRelated(relatedObject)) rules.push([updateFilter, 'no_permission_to_update']);
            result.connect = connectItems.map((item: Record<string, any>) =>
                this.#scopeUnique(this.#keyWhere(model, keyFields, keyed(item)), model, rules));
        }

        return result;
    }

    /**
     * Process single relation for create operation.
     *
     * NOTE: unlike array relations (where items carrying a full PK become connect/upsert),
     * a single-object relation payload always becomes `{ create: ... }` — to link an
     * existing record, send the FK scalar or an explicit `{ connect: ... }` operation.
     */
    #processCreateSingleRelation(
        item: Record<string, any>,
        relatedObject: RelationConfig,
        relationName: string,
        user: any = null,
        depth: number = 0,
        parent: Record<string, any> | null = null
    ): Record<string, any> {
        if (depth > MAX_NESTING_DEPTH) {
            throw new ErrorResponse(400, "max_nesting_depth_exceeded", { depth: MAX_NESTING_DEPTH });
        }

        // Raw Prisma operations (connect, create, ...) — held to the related model's ACL
        if (isRawOperation(item)) {
            return this.#secureRawOperations(item, relatedObject, user, depth);
        }

        // Get ACL context for the related model
        const { modelAcl: relatedAcl, omitFields } = this.#resolveAclContext(relatedObject.object, user);

        // A plain object payload creates the related record
        if (user && !isSystemUser(user) && relatedAcl?.canCreate && !relatedAcl.canCreate(user, item)) {
            throw new ErrorResponse(403, "no_permission_to_create", { model: relatedObject.object });
        }

        // Apply omit fields, then the writable-fields whitelist (the related key is an identifier, not data)
        for (const field of omitFields) {
            delete item[field];
        }
        this.#applyWritableWhitelist(item, relatedAcl, user, this.#keyFields(relatedObject.object));

        this.#ensureRelations(relatedObject);
        this.#assertKnownFields(item, relatedObject.object, relationName);
        this.#dropBackReference(item, relatedObject);

        return { create: this.#nestedData(item, relatedObject, user, 'create', relationName, depth, this.#inherited(relatedObject, parent)) };
    }

    /** The fields that identify a row of a model — its @id / @@id, or its unique */
    #keyFields(model: string): string[] {
        const key = this.getPrimaryKey(model);
        return Array.isArray(key) ? key : [key];
    }

    /** A unique where for a row by these key fields: { id: 1 } — or the compound selector { a_b: { a: 1, b: 2 } } */
    #keyWhere(model: string, keyFields: string[], values: Record<string, any>): Record<string, any> {
        if (keyFields.length === 1) return { [keyFields[0]]: values[keyFields[0]] };
        const selector: Record<string, any> = {};
        for (const field of keyFields) selector[field] = values[field];
        return { [dmmf.compoundKeyName(model, keyFields)]: selector };
    }

    /** Every field of a nested item must exist on its model */
    #assertKnownFields(item: Record<string, any>, model: string, path: string): void {
        for (const key of Object.keys(item)) {
            if (!this.#fieldExistsOnModel(model, key)) {
                throw new ErrorResponse(400, "unexpected_key", { key: `${path}.${key}` });
            }
        }
    }

    /** The nested model's side of the relation a nested write goes through — the way back to the parent */
    #backRelation(relatedObject: RelationConfig): RelationConfig | undefined {
        if (!relatedObject.relationName) return undefined;
        const sides = (relatedObject.relation ?? []).filter((r: RelationConfig) => r.relationName === relatedObject.relationName);
        // A relation of a model to itself has both sides on it
        return sides.length > 1 ? sides.find((r: RelationConfig) => r.name !== relatedObject.name) : sides[0];
    }

    /** The foreign key back to the parent is the nesting's to decide — a client's copy of it is dropped */
    #dropBackReference(item: Record<string, any>, relatedObject: RelationConfig): void {
        const back = this.#backRelation(relatedObject);
        for (const column of back?.fields ?? (back?.field ? [back.field] : [])) {
            delete item[column];
        }
    }

    /** What a nested item takes from its parent: its foreign key back to it, where the parent's values are known */
    #inherited(relatedObject: RelationConfig, parent: Record<string, any> | null): Record<string, any> {
        const values: Record<string, any> = {};
        const back = this.#backRelation(relatedObject);
        if (!back || !parent) return values;
        const columns = back.fields ?? (back.field ? [back.field] : []);
        const targets = back.foreignKeys?.length ? back.foreignKeys : (back.foreignKey ? [back.foreignKey] : []);
        columns.forEach((column: string, i: number) => {
            if (targets[i] != null && parent[targets[i]] != null) values[column] = parent[targets[i]];
        });
        return values;
    }

    /** Whether a nested model's key includes its foreign key back to the parent — its rows are that parent's alone */
    #keyIncludesParent(relatedObject: RelationConfig, keyFields: string[]): boolean {
        const back = this.#backRelation(relatedObject);
        return (back?.fields ?? (back?.field ? [back.field] : [])).some((column: string) => keyFields.includes(column));
    }

    /** A row's key as { field: value } — from its key value, or an object holding its fields; null when unknown */
    #keyValues(model: string, id: unknown): Record<string, any> | null {
        if (id == null) return null;
        const keyFields = this.#keyFields(model);
        if (typeof id === 'object' && !(id instanceof Date)) {
            const values: Record<string, any> = {};
            for (const field of keyFields) {
                if ((id as Record<string, any>)[field] != null) values[field] = (id as Record<string, any>)[field];
            }
            return Object.keys(values).length > 0 ? values : null;
        }
        return keyFields.length === 1 ? { [keyFields[0]]: id } : null;
    }

    /** A unique where held to some of a model's rules at once — each a filter, null (none) or false (refused) */
    #scopeUnique(where: Record<string, any>, model: string, rules: [any, string][]): Record<string, any> {
        const conditions: Record<string, any>[] = [];
        for (const [rule, denied] of rules) {
            if (rule === false) throw new ErrorResponse(403, denied, { model });
            if (rule && typeof rule === 'object' && Object.keys(rule).length > 0) conditions.push(rule);
        }
        return conditions.length > 0 ? { ...where, AND: conditions } : where;
    }

    /**
     * Whether `data` — a nested create as #nestedData writes it — has what a new row of `model`
     * needs: every required column without a default, every required relation (the one back to
     * the parent is the nesting's). Prisma validates an upsert's create half even when the row
     * exists — an item without it can only update.
     */
    #creatable(model: string, data: Record<string, any>, back: RelationConfig | undefined, relations: RelationConfig[]): boolean {
        const linked = new Set<string>();
        for (const relation of relations) {
            if (relation === back || data[relation.name] != null) {
                for (const column of relation.fields ?? (relation.field ? [relation.field] : [])) linked.add(column);
            }
        }
        const complete = Object.values(this.#fieldsOf(model)).every((field: any) => {
            if (!field.isRequired || field.isList || field.hasDefaultValue || field.isUpdatedAt) return true;
            if (field.kind === 'object') {
                return !field.relationFromFields?.length || field.name === back?.name || data[field.name] != null
                    || field.relationFromFields.every((column: string) => data[column] != null);
            }
            return data[field.name] != null || linked.has(field.name);
        });
        if (!complete) return false;
        // The rows it creates with it, at every level, must be new rows too
        for (const relation of relations) {
            const ops = data[relation.name];
            if (relation === back || !ops || typeof ops !== 'object') continue;
            const creates = [
                ...(Array.isArray(ops.create) ? ops.create : ops.create ? [ops.create] : []),
                ...(Array.isArray(ops.connectOrCreate) ? ops.connectOrCreate : ops.connectOrCreate ? [ops.connectOrCreate] : []).map((c: any) => c?.create),
            ].filter((item: unknown) => item && typeof item === 'object');
            if (creates.length === 0) continue;
            this.#ensureRelations(relation);
            const nestedBack = this.#backRelation(relation);
            if (!creates.every((item: Record<string, any>) => this.#creatable(relation.object, item, nestedBack, relation.relation ?? []))) return false;
        }
        return true;
    }

    /**
     * Foreign-key columns become connects of their relations, held to the related model's access
     * rule — a composite foreign key with all its columns, through its compound selector:
     * { orgId: 1, userId: 2 } → { member: { connect: { orgId_userId: { orgId: 1, userId: 2 } } } }.
     *
     * A relation is named by a column only its foreign key has (assignee_no). A column several
     * foreign keys share (tenant_id) is completed from what is known — the parent's values in a
     * nested item, the row's key in an update — and changed in an update, it moves every link
     * through it. A missing link (null — in creates also an empty form field) is left
     * out of a create and unlinks in an update: `disconnect` — or, where the foreign key shares a
     * column that disconnect would null too, its own columns set null. A required relation can't
     * be unlinked — nor left out of a create of the `whole` row. Edits `data`; true when it linked
     * a relation.
     */
    #linkForeignKeys(
        data: Record<string, any>,
        relations: RelationConfig[],
        user: any,
        mode: 'create' | 'update',
        { model, back, inherited = {}, whole = false }: { model: string; back?: RelationConfig; inherited?: Record<string, any>; whole?: boolean }
    ): boolean {
        const columnsOf = (relation: RelationConfig): string[] => relation.fields ?? (relation.field ? [relation.field] : []);
        const owning = relations.filter((relation: RelationConfig) => columnsOf(relation).length > 0);
        const holders = new Map<string, number>();
        for (const relation of owning) {
            for (const column of columnsOf(relation)) holders.set(column, (holders.get(column) ?? 0) + 1);
        }
        const ownColumns = (relation: RelationConfig): string[] => columnsOf(relation).filter((column: string) => holders.get(column) === 1);
        const given: Record<string, any> = { ...inherited, ...data };
        const present = (column: string): boolean => given[column] != null && !(mode === 'create' && given[column] === '');
        const incomplete = (relation: RelationConfig): never => {
            throw new ErrorResponse(400, "incomplete_foreign_key", { relation: relation.name, fields: columnsOf(relation) });
        };
        const fields = this.#fieldsOf(model);
        const required = (relation: RelationConfig): boolean => fields[relation.name]?.isRequired === true;
        const linkable = owning.filter((relation: RelationConfig) => relation !== back);

        // Relations named by a column of their own: linked — or unlinked, those columns all null
        const plan = new Map<RelationConfig, 'link' | 'unlink'>();
        for (const relation of linkable) {
            const own = ownColumns(relation);
            if (!own.some((column: string) => column in data)) continue;
            if (columnsOf(relation).every(present)) plan.set(relation, 'link');
            else if (own.every((column: string) => !present(column))) plan.set(relation, 'unlink');
            else incomplete(relation);
        }
        // An update of a shared column moves every link through it (in a create, a relation not
        // named is left out)
        for (const column of mode === 'update' ? Object.keys(data) : []) {
            if ((holders.get(column) ?? 0) < 2) continue;
            for (const relation of linkable) {
                if (!columnsOf(relation).includes(column) || plan.has(relation)) continue;
                if (columnsOf(relation).every(present)) plan.set(relation, 'link');
                else incomplete(relation);
            }
        }

        const used = new Set<string>();
        let linked = false;
        let nulled: RelationConfig | null = null;
        for (const [relation, action] of plan) {
            const columns = columnsOf(relation);
            if (action === 'link') {
                // The columns it references — usually the related model's key
                const targets = relation.foreignKeys?.length ? relation.foreignKeys : [relation.foreignKey ?? this.#keyFields(relation.object)[0]];
                const values: Record<string, any> = {};
                targets.forEach((target: string, i: number) => { values[target] = given[columns[i]]; });
                const { accessFilter } = this.#resolveAclContext(relation.object, user);
                data[relation.name] = { connect: this.#mergeAclIntoUniqueWhere(this.#keyWhere(relation.object, targets, values), accessFilter, relation.object) };
                columns.forEach((column: string) => used.add(column));
                linked = true;
            } else if (required(relation)) {
                throw new ErrorResponse(400, "foreign_key_required", { relation: relation.name, fields: columns });
            } else if (mode === 'create') {
                // Nothing to link to: left out
                ownColumns(relation).forEach((column: string) => used.add(column));
            } else if (columns.every((column: string) => holders.get(column) === 1)) {
                data[relation.name] = { disconnect: true };
                columns.forEach((column: string) => used.add(column));
            } else {
                for (const column of ownColumns(relation)) data[column] = null;
                nulled = relation;
            }
        }
        for (const column of used) {
            delete data[column];
        }

        // Prisma takes foreign-key columns only without relation writes next to them
        if (nulled && owning.some((relation: RelationConfig) => data[relation.name] != null && typeof data[relation.name] === 'object')) {
            throw new ErrorResponse(400, "foreign_key_unlink_conflict", { relation: nulled.name, fields: ownColumns(nulled) });
        }

        // A required relation a create of the whole row leaves out — named by its columns, not
        // Prisma's argument (a nested create may have it from the nesting)
        if (mode === 'create' && whole) {
            for (const relation of linkable) {
                if (plan.has(relation) || data[relation.name] != null || !required(relation)) continue;
                const own = ownColumns(relation);
                if (own.length === 0 || own.some((column: string) => fields[column]?.hasDefaultValue)) continue;
                throw new ErrorResponse(400, "foreign_key_required", { relation: relation.name, fields: columnsOf(relation) });
            }
        }
        return linked;
    }

    /** An autoincrement key column — Prisma takes it in a create only as plain columns, never next to a relation */
    #isAutoincrement(model: string, field: string): boolean {
        const def = this.#getRelatedModelFields(model)[field]?.default as { name?: string } | undefined;
        return def?.name === 'autoincrement';
    }

    /**
     * A nested item written as a create or an update of its model: relations inside it are
     * written the same way, one level deeper, and foreign keys become connects held to the
     * related model's rule — completed by what the item takes from its parent (`inherited`).
     * Its key addresses it (the where), it is no data: an update leaves it out, and so does a
     * create that links relations when the database assigns it.
     */
    #nestedData(
        item: Record<string, any>,
        relatedObject: RelationConfig,
        user: any,
        mode: 'create' | 'update',
        path: string,
        depth: number,
        inherited: Record<string, any> = {}
    ): Record<string, any> {
        const model = relatedObject.object;
        const data: Record<string, any> = { ...item };
        const relations = this.#ensureRelations(relatedObject).relation ?? [];
        // The item's values and what it takes from its parent: what its own items take from it
        const known = { ...this.#writeScalars(data, this.#fieldsOf(model)), ...inherited };
        for (const [key, value] of Object.entries(item)) {
            const nested = relations.find((r: RelationConfig) => r.name === key);
            if (!nested || !value || typeof value !== 'object') continue;
            this.#ensureRelations(nested);
            const at = `${path}.${key}`;
            if (mode === 'create') {
                data[key] = Array.isArray(value)
                    ? this.#processCreateArrayRelation(value.map((v: Record<string, any>) => ({ ...v })), nested, at, user, depth + 1, known)
                    : this.#processCreateSingleRelation({ ...value }, nested, at, user, depth + 1, known);
            } else if (Array.isArray(value)) {
                data[key] = this.#processArrayRelation(value.map((v: Record<string, any>) => ({ ...v })), nested, known, user, depth + 1);
            } else {
                const written = this.#processSingleRelation({ ...value }, nested, user, depth + 1, known);
                if (written) data[key] = written;
                else delete data[key];
            }
        }

        const keyFields = this.#keyFields(model);
        if (mode === 'update') {
            for (const field of keyFields) delete data[field];
        }
        const linked = this.#linkForeignKeys(data, relations, user, mode, { model, back: this.#backRelation(relatedObject), inherited: known });
        if (mode === 'create' && linked) {
            for (const field of keyFields) {
                if (this.#isAutoincrement(model, field)) delete data[field];
            }
        }
        return data;
    }

    /**
     * A plain row for bulk writes (createMany): fields the ACL hides or doesn't let this user
     * write are removed, nothing is transformed. Relations aren't supported by createMany.
     */
    sanitizeRow(data: Record<string, unknown>, user: any = null): Record<string, unknown> {
        const row: Record<string, any> = { ...data };
        this.#stripUnwritable(row, user);
        return row;
    }

    /** Remove what the ACL hides from this user or doesn't let them write (edits `row`) */
    #stripUnwritable(row: Record<string, any>, user: any): void {
        const { modelAcl, omitFields } = this.#resolveAclContext(this.name, user);
        for (const field of omitFields) {
            delete row[field];
        }
        this.#applyWritableWhitelist(row, modelAcl, user);
    }

    /**
     * Process data for update operation with nested relation support
     * Transforms nested relation data into Prisma update/upsert/connect/disconnect syntax
     * Does NOT mutate the input data - returns a new transformed object
     */
    update(
        id: string | number | Record<string, any> | null,
        data: Record<string, unknown>,
        user: any = null,
        { stripped = false }: { stripped?: boolean } = {}
    ): Record<string, unknown> {
        // One working copy; the per-key processors edit it in place
        const result: Record<string, any> = { ...data };

        // Remove fields user shouldn't be able to modify (see create: `stripped`)
        if (!stripped) this.#stripUnwritable(result, user);

        // The record's key (`id`: its value, or an object of its fields): it completes a foreign
        // key the payload names in part, and nested items take theirs from it. Unchanged, it is
        // no write (clients echo it back; upserts carry it) — dropping it avoids a pointless key
        // update, and Prisma's checked input, used once a foreign key becomes a connect, has no
        // autoincrement id at all.
        const key = this.#keyValues(this.name, id) ?? {};
        for (const [field, value] of Object.entries(key)) {
            if (result[field] != null && keyText(this.fields[field], result[field]) === keyText(this.fields[field], value)) {
                delete result[field];
            }
        }

        const own = { ...this.#writeScalars(result, this.fields), ...key };
        for (const field of Object.keys(result)) {
            // Handle relation fields or unknown keys
            if (this.fields[field] == null || this.fields[field].kind === 'object') {
                this.#processUpdateRelation(result, field, user, own);
            }
        }
        // Foreign-key columns become connects (null: unlinks) of their relations
        this.#linkForeignKeys(result, this.relatedObjects, user, 'update', { model: this.name, inherited: key });

        return result;
    }

    /**
     * Process a relation field for update operation (edits `data`, the caller's working copy)
     */
    #processUpdateRelation(
        data: Record<string, any>,
        key: string,
        user: any,
        parent: Record<string, any> | null = null
    ): void {
        const relatedObject = this.getRelationByName(key);
        if (!relatedObject) {
            throw new ErrorResponse(400, "unexpected_key", { key });
        }

        if (!data[key]) return;

        this.#ensureRelations(relatedObject);

        if (Array.isArray(data[key])) {
            // Clone each item to avoid mutating original nested objects
            data[key] = this.#processArrayRelation(
                data[key].map((item: Record<string, any>) => ({ ...item })), relatedObject, parent, user
            );
        } else {
            // Clone the nested object to avoid mutating original
            const written = this.#processSingleRelation({ ...data[key] }, relatedObject, user, 0, parent);
            if (written) data[key] = written;
            else delete data[key];
        }
    }

    /**
     * Resolve the ACL writable-fields whitelist for a user.
     * Returns null when unrestricted (no hook, no user, system user, or hook returned null).
     */
    #getWritableFieldsSet(modelAcl: any, user: any): Set<string> | null {
        if (!user || isSystemUser(user) || !modelAcl?.getWritableFields) {
            return null;
        }
        const list = modelAcl.getWritableFields(user);
        return Array.isArray(list) ? new Set(list) : null;
    }

    /**
     * Strip fields outside the ACL writable-fields whitelist (mutates obj).
     * Identifier fields passed as `exempt` (PKs/FKs used to address records in nested
     * payloads) are never stripped — they select records, they don't write data.
     */
    #applyWritableWhitelist(obj: Record<string, any>, modelAcl: any, user: any, exempt: string[] = []): void {
        const writable = this.#getWritableFieldsSet(modelAcl, user);
        if (!writable) return;
        for (const key of Object.keys(obj)) {
            if (!writable.has(key) && !exempt.includes(key)) {
                delete obj[key];
            }
        }
    }

    /**
     * Merge an ACL filter into a unique where clause (connect / upsert / update targets).
     *
     * Prisma's WhereUniqueInput requires at least one unique field at the TOP level, so the
     * filter goes into a nested AND — `{ AND: [where, filter] }` is rejected ("needs at least
     * one of id arguments"). Nesting also prevents filter keys from overwriting the unique
     * key when they collide (e.g. an ACL filter on `id`).
     */
    #mergeAclIntoUniqueWhere(where: Record<string, any>, aclFilter: any, model: string, denied = 'no_permission'): Record<string, any> {
        // A deny is a refusal, not "no filter" — as for raw nested operations
        if (aclFilter === false) throw new ErrorResponse(403, denied, { model });
        if (!aclFilter || typeof aclFilter !== 'object' || Object.keys(aclFilter).length === 0) {
            return where;
        }
        return { ...where, AND: [aclFilter] };
    }

    /**
     * Assert the user may create every item (per-item canCreate check)
     */
    #assertCanCreateAll(items: Record<string, any>[], relatedAcl: any, user: any, modelName: string): void {
        // System users bypass ACL — consistent with Model.canCreate and every other bypass site.
        if (!user || isSystemUser(user) || !relatedAcl?.canCreate) return;
        for (const item of items) {
            if (!relatedAcl.canCreate(user, item)) {
                throw new ErrorResponse(403, "no_permission_to_create", { model: modelName });
            }
        }
    }

    /**
     * Hold raw Prisma operations in a nested payload ({ tags: { deleteMany: {} } },
     * { author: { connect: { id } } }, ...) to the related model's ACL — otherwise they
     * would bypass access/update/delete filters, canCreate and field stripping entirely.
     * System users (and trusted internal calls without a user) pass through unchanged.
     */
    #secureRawOperations(ops: Record<string, any>, relation: RelationConfig, user: any, depth: number = 0): Record<string, any> {
        if (!user || isSystemUser(user)) return ops;
        if (depth > MAX_NESTING_DEPTH) {
            throw new ErrorResponse(400, "max_nesting_depth_exceeded", { depth: MAX_NESTING_DEPTH });
        }
        const { modelAcl, accessFilter, updateFilter, deleteFilter, omitFields } = this.#resolveAclContext(relation.object, user);
        const pk = this.getPrimaryKey(relation.object);
        const identifiers = Array.isArray(pk) ? pk : [pk];
        const nestedRelations = dmmf.buildRelationships(relation.object);
        // `true` from an ACL hook means "no restriction"
        const normalize = (filter: any) => (filter === true || filter == null ? null : filter);

        return secureNestedOperations(ops, relation, {
            accessFilter: normalize(accessFilter),
            updateFilter: normalize(updateFilter),
            deleteFilter: normalize(deleteFilter),
            canCreate: (data) => !modelAcl?.canCreate || modelAcl.canCreate(user, data),
            cleanData: (data) => {
                const cleaned: Record<string, any> = { ...data };
                for (const field of omitFields) delete cleaned[field];
                this.#applyWritableWhitelist(cleaned, modelAcl, user, identifiers);
                for (const key of Object.keys(cleaned)) {
                    const nested = nestedRelations.find((r: RelationConfig) => r.name === key);
                    if (nested && isRawOperation(cleaned[key])) {
                        cleaned[key] = this.#secureRawOperations(cleaned[key], nested, user, depth + 1);
                    }
                }
                return cleaned;
            },
        });
    }

    /**
     * Resolve the ACL context (hooks + evaluated filters) for a model and user.
     * Central helper for the `user && acl?.hook ? ... : fallback` boilerplate.
     * Filters are lazy getters — only the hooks you destructure are invoked.
     */
    #resolveAclContext(modelName: string, user: any): {
        modelAcl: any;
        /** A filter, null (no restriction) or false (denied) */
        accessFilter: Record<string, any> | false | null;
        updateFilter: Record<string, any> | false | null;
        deleteFilter: Record<string, any> | false | null;
        omitFields: string[];
    } {
        const modelAcl = getAcl().model[modelName];
        // System users bypass ACL — never invoke the app hooks with the null-id identity.
        const active = user && !isSystemUser(user);
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        return {
            modelAcl,
            get accessFilter() {
                return active && modelAcl?.getAccessFilter ? self.cleanFilter(guardAclFilter(modelAcl.getAccessFilter(user), modelName, 'getAccessFilter')) : null;
            },
            get updateFilter() {
                return active && modelAcl?.getUpdateFilter ? self.cleanFilter(guardAclFilter(modelAcl.getUpdateFilter(user), modelName, 'getUpdateFilter')) : null;
            },
            get deleteFilter() {
                return active && modelAcl?.getDeleteFilter ? self.cleanFilter(guardAclFilter(modelAcl.getDeleteFilter(user), modelName, 'getDeleteFilter')) : null;
            },
            get omitFields() {
                if (!active || !modelAcl?.getOmitFields) return [];
                const list: string[] = modelAcl.getOmitFields(user) ?? [];
                // getOmitFields hides fields from READ responses. When stripping them from a
                // WRITE payload, keep write-only fields (required, no default) — stripping a
                // field the database mandates guarantees a failed insert. The archetype is
                // `password`: hidden on read, required on write. Read-side omit is unaffected
                // (it uses getRelatedOmit, not this getter).
                return list.filter((f: string) => !self.#isWriteOnlyField(modelName, f));
            },
        };
    }

    /**
     * A field the database requires on insert with no default — write-only when also hidden
     * by getOmitFields (e.g. password). Such fields must survive write-payload omit-stripping.
     */
    #isWriteOnlyField(modelName: string, fieldName: string): boolean {
        const fields = modelName === this.name ? this.fields : this.#getRelatedModelFields(modelName);
        const f = fields[fieldName];
        return !!f && f.kind === 'scalar' && f.isRequired === true && f.hasDefaultValue !== true && !f.isId;
    }

    /**
     * Process array relations for update operations. An item is addressed by its key — the part
     * the parent holds taken from the parent (task_no under a project: the project's tenant and
     * number with it). Only its key: the row is linked — a row of another parent moves here,
     * held to the related model's update rule; a row whose key includes this parent's is linked
     * already, and created when missing and it can be. Its key and data: upserted — updated only,
     * when the user may not create it or it lacks what a new row needs. No key: created.
     */
    #processArrayRelation(
        dataArray: Record<string, any>[],
        relatedObject: RelationConfig,
        parent: Record<string, any> | null,
        user: any = null,
        depth: number = 0
    ): Record<string, any> {
        if (depth > MAX_NESTING_DEPTH) {
            throw new ErrorResponse(400, "max_nesting_depth_exceeded", { depth: MAX_NESTING_DEPTH });
        }

        this.#ensureRelations(relatedObject);
        for (const item of dataArray) {
            this.#assertKnownFields(item, relatedObject.object, relatedObject.name);
            this.#dropBackReference(item, relatedObject);
        }

        const model = relatedObject.object;
        const keyFields = this.#keyFields(model);
        const inherited = this.#inherited(relatedObject, parent);
        const ownedByParent = this.#keyIncludesParent(relatedObject, keyFields);
        const back = this.#backRelation(relatedObject);
        const { modelAcl: relatedAcl, accessFilter, updateFilter, omitFields } = this.#resolveAclContext(model, user);

        // The key addresses records — exempt from the writable whitelist
        const clean = (obj: Record<string, any>): Record<string, any> => {
            const cleaned: Record<string, any> = { ...obj };
            for (const field of omitFields) {
                delete cleaned[field];
            }
            this.#applyWritableWhitelist(cleaned, relatedAcl, user, keyFields);
            return cleaned;
        };

        const keyed = (item: Record<string, any>): Record<string, any> => ({ ...item, ...inherited });
        const hasKey = (item: Record<string, any>): boolean => keyFields.every((field: string) => keyed(item)[field] != null);
        const onlyKey = (item: Record<string, any>): boolean => Object.keys(item).every((key: string) => keyFields.includes(key));
        const mayCreate = (item: Record<string, any>): boolean =>
            !user || isSystemUser(user) || !relatedAcl?.canCreate || relatedAcl.canCreate(user, item);
        const where = (item: Record<string, any>, rules: [any, string][]): Record<string, any> =>
            this.#scopeUnique(this.#keyWhere(model, keyFields, keyed(item)), model, rules);
        const readRule: [any, string] = [accessFilter, 'no_permission'];
        const updateRule: [any, string] = [updateFilter, 'no_permission_to_update'];

        const result: Record<string, any[]> = {};
        const add = (op: string, entry: Record<string, any>): void => {
            (result[op] ??= []).push(entry);
        };
        for (const item of dataArray) {
            if (!hasKey(item)) {
                if (!mayCreate(item)) {
                    throw new ErrorResponse(403, "no_permission_to_create", { model });
                }
                add('create', this.#nestedData(clean(item), relatedObject, user, 'create', relatedObject.name, depth, inherited));
                continue;
            }

            const cleaned = clean(item);
            const createData = this.#nestedData(cleaned, relatedObject, user, 'create', relatedObject.name, depth, inherited);
            const creatable = mayCreate(item) && this.#creatable(model, createData, back, relatedObject.relation ?? []);

            if (onlyKey(item)) {
                if (!ownedByParent) {
                    // Linking moves the row here — an update of it, unless the links are rows of their own
                    add('connect', where(item, linkRewritesRelated(relatedObject) ? [readRule, updateRule] : [readRule]));
                } else {
                    add(creatable ? 'connectOrCreate' : 'connect', creatable
                        ? { where: where(item, [readRule]), create: createData }
                        : where(item, [readRule]));
                }
                continue;
            }

            const updateData = this.#nestedData(cleaned, relatedObject, user, 'update', relatedObject.name, depth, inherited);
            if (creatable) {
                add('upsert', { where: where(item, [updateRule]), create: createData, update: updateData });
            } else {
                add('update', { where: where(item, [updateRule]), data: updateData });
            }
        }

        return result;
    }

    /**
     * Process single relation for update operations: a plain object writes the related record —
     * the linked one updated, under the related model's update rule, or created when none is
     * linked: if the user may create it, it has what a new row needs and the related model has
     * no update rule (an upsert can't be held to one — Prisma's upsert-with-where fails
     * whenever the where misses)
     */
    #processSingleRelation(
        dataObj: Record<string, any>,
        relatedObject: RelationConfig,
        user: any = null,
        depth: number = 0,
        parent: Record<string, any> | null = null
    ): Record<string, any> | null {
        if (depth > MAX_NESTING_DEPTH) {
            throw new ErrorResponse(400, "max_nesting_depth_exceeded", { depth: MAX_NESTING_DEPTH });
        }

        // Raw Prisma operations (connect, deleteMany, ...) — held to the related model's ACL
        if (isRawOperation(dataObj)) {
            return this.#secureRawOperations(dataObj, relatedObject, user, depth);
        }

        const model = relatedObject.object;
        const { modelAcl: relatedAcl, updateFilter, omitFields } = this.#resolveAclContext(model, user);
        if (updateFilter === false) {
            throw new ErrorResponse(403, "no_permission_to_update", { model });
        }

        // Remove omitted fields, then apply the writable-fields whitelist (the related key is an identifier, not data)
        for (const field of omitFields) {
            delete dataObj[field];
        }
        this.#applyWritableWhitelist(dataObj, relatedAcl, user, this.#keyFields(model));

        this.#ensureRelations(relatedObject);
        this.#assertKnownFields(dataObj, model, relatedObject.name);
        this.#dropBackReference(dataObj, relatedObject);

        const inherited = this.#inherited(relatedObject, parent);
        const createData = this.#nestedData(dataObj, relatedObject, user, 'create', relatedObject.name, depth, inherited);
        const updateData = this.#nestedData(dataObj, relatedObject, user, 'update', relatedObject.name, depth, inherited);
        const restricted = !!updateFilter && typeof updateFilter === 'object' && Object.keys(updateFilter).length > 0;
        const mayCreate = !user || isSystemUser(user) || !relatedAcl?.canCreate || relatedAcl.canCreate(user, dataObj);

        if (!restricted && mayCreate && this.#hasMeaningfulContent(createData)
            && this.#creatable(model, createData, this.#backRelation(relatedObject), relatedObject.relation ?? [])) {
            return { upsert: { create: createData, update: updateData } };
        }
        if (!this.#hasMeaningfulContent(updateData)) return null;
        return { update: restricted ? { where: updateFilter, data: updateData } : updateData };
    }

    /**
     * Check if data object contains meaningful content for database operations
     */
    #hasMeaningfulContent(dataObj: Record<string, any>): boolean {
        return Object.values(dataObj).some((value: any) => {
            if (value === null || value === undefined) return false;
            if (typeof value !== 'object' || value instanceof Date || Array.isArray(value)) return true;
            // A nested write counts when it does something (connect, connectOrCreate, upsert, ...)
            return Object.keys(value).length > 0;
        });
    }

    /**
     * Recursively clean filter object by removing undefined values and empty AND/OR arrays
     */
    cleanFilter(filter: any): any {
        if (!filter || typeof filter !== 'object') {
            return filter === undefined ? null : filter;
        }

        if (Array.isArray(filter)) {
            const cleaned = filter.map((item: any) => this.cleanFilter(item)).filter((item: any) => item !== null && item !== undefined);
            return cleaned.length > 0 ? cleaned : null;
        }

        const cleaned: Record<string, any> = {};
        for (const key in filter) {
            const value = filter[key];

            if (value === undefined) {
                continue; // Skip undefined values
            }

            if (value === null) {
                cleaned[key] = null;
                continue;
            }

            if (typeof value === 'object') {
                const cleanedValue = this.cleanFilter(value);
                if (cleanedValue !== null && cleanedValue !== undefined) {
                    // For AND/OR arrays, only add if they have items
                    if ((key === 'AND' || key === 'OR') && Array.isArray(cleanedValue) && cleanedValue.length === 0) {
                        continue;
                    }
                    cleaned[key] = cleanedValue;
                }
            } else {
                cleaned[key] = value;
            }
        }

        // If cleaned filter only has one condition in an AND/OR, unwrap it
        if (Object.keys(cleaned).length === 1 && (cleaned.AND || cleaned.OR)) {
            const array = cleaned.AND || cleaned.OR;
            if (Array.isArray(array) && array.length === 1) {
                return array[0];
            }
        }

        return Object.keys(cleaned).length > 0 ? cleaned : null;
    }

    /**
     * Check if a relation is a list (array) relation using Prisma DMMF
     */
    #isListRelation(parentModel: string, relationName: string): boolean {
        return dmmf.isListRelation(parentModel, relationName);
    }

    /**
     * Get API result limit constant
     */
    static get API_RESULT_LIMIT(): number {
        return API_RESULT_LIMIT;
    }

    /**
     * Handle Prisma errors and convert to standardized error responses.
     * All messages are translated via LanguageDict (with {placeholder} interpolation
     * from ErrorResponse.data) — pass the request's negotiated language so clients
     * receive localized messages; it defaults to the configured default language.
     */
    static errorHandler(error: any, data: Record<string, unknown> = {}, language: string | null = null): QueryErrorResponse {
        // Default values
        let statusCode: number = error.status_code || 500;
        let message: string;
        let key: string | undefined;
        let errorData: Record<string, unknown> | undefined;

        if (error instanceof ErrorResponse) {
            key = error.message;
            errorData = error.data ?? undefined;
            message = LanguageDict.get(error.message, error.data, language);
        } else if (process.env.NODE_ENV === 'production') {
            key = 'internal_server_error';
            message = LanguageDict.get(key, null, language);
        } else {
            message = error.message || String(error);
        }

        // The database's own error behind a driver adapter failure: thrown as is (Prisma 7.8), or
        // as the generic P2039 "Database error" (7.10)
        const databaseError = databaseErrorInfo(error?.name === 'DriverAdapterError' ? error.cause : error?.meta?.driverAdapterError?.cause);

        // Handle Prisma error codes (PrismaClientKnownRequestError)
        if (error?.code && PRISMA_ERROR_MAP[error.code]) {
            const errorInfo = PRISMA_ERROR_MAP[error.code];
            statusCode = errorInfo.status;

            // Handle dynamic messages (e.g., P2002 duplicate)
            if (error.code === 'P2002') {
                // Driver adapters (Prisma 7) report the constraint in driverAdapterError, not meta.target
                const { model: modelName, fields } = duplicateTarget(error, data);
                // The value from the data passed to errorHandler (a nested row's isn't there)
                const value = fields.length > 0 && fields.every((f: string) => data[f] !== undefined && data[f] !== null && typeof data[f] !== 'object')
                    ? fields.map((f: string) => String(data[f])).join(', ')
                    : '';
                if (fields.length === 0) {
                    // A clash the database doesn't place (MariaDB's PRIMARY, in a nested write): no name
                    key = 'duplicate_entry_unknown';
                    errorData = {};
                } else {
                    key = value ? 'duplicate_entry' : 'duplicate_entry_no_value';
                    errorData = { model: modelName, field: fields.join(', '), value };
                }
                message = LanguageDict.get(key, errorData, language);
            } else {
                key = errorInfo.message!;
                message = LanguageDict.get(key, null, language);
            }
        }
        else if (databaseError) {
            statusCode = databaseError.status;
            key = databaseError.message!;
            message = LanguageDict.get(key, null, language);
        }
        // Handle PrismaClientValidationError — invalid arguments, type mismatches
        else if (error?.name === 'PrismaClientValidationError' || error?.constructor?.name === 'PrismaClientValidationError') {
            statusCode = 400;
            key = 'data_validation_error';
            // Prisma ends the message with the reason — "Invalid value for argument `hired_on`:
            // premature end of input. Expected ISO-8601 DateTime." / "Argument `name` is missing."
            const reason = String(error.message || '').split('\n').map((l: string) => l.trim()).filter(Boolean).pop() || '';
            const field = /argument `([^`]+)`/i.exec(reason)?.[1];
            message = /argument/i.test(reason) ? reason : LanguageDict.get(key, null, language);
            // A filter operator (equals, in, ...) is not the field a client can fix
            if (field && !PRISMA_OPERATORS.has(field)) errorData = { field };
        }
        // Handle PrismaClientInitializationError — connection/config issues
        else if (error?.name === 'PrismaClientInitializationError' || error?.constructor?.name === 'PrismaClientInitializationError') {
            statusCode = 500;
            key = 'db_connection_failed';
            message = LanguageDict.get(key, null, language);
        }
        // Handle PrismaClientRustPanicError — internal Prisma engine crash
        else if (error?.name === 'PrismaClientRustPanicError' || error?.constructor?.name === 'PrismaClientRustPanicError') {
            statusCode = 500;
            key = 'internal_server_error';
            message = LanguageDict.get(key, null, language);
        }

        // Client errors (404, 403, duplicates, validation) are expected traffic: warn, so error
        // level and alerting stay meaningful for real failures
        if (statusCode >= 500) {
            Logger.error(error);
        } else {
            Logger.warn(`${statusCode} ${key ?? error?.code ?? ''}`.trim(), { message: error?.message });
        }

        return {
            status_code: statusCode,
            message,
            ...(key ? { key } : {}),
            ...(errorData ? { data: errorData } : {}),
        };
    }
}

export { QueryBuilder, prisma, prismaTransaction, PRISMA_ERROR_MAP };