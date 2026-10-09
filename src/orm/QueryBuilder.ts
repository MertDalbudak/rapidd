import { prisma, prismaTransaction, getAcl } from '../core/prisma';
import { ErrorResponse } from '../core/errors';
import { LanguageDict } from '../core/i18n';
import { Logger } from '../utils/Logger';
import { isSystemUser } from '../core/user';
import * as dmmf from '../core/dmmf';
import { dayRange, filterTimeZone, startOfDay } from './dates';
import { PRISMA_WRITE_OPS, isRawOperation, secureNestedOperations } from './nestedOperations';
import { parseScalar } from './values';
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

    /** O(1) lookup of relation by field (foreign key field name) */
    getRelationByField(field: string): RelationConfig | undefined {
        if (!this._relatedByField) {
            const map = new Map<string, RelationConfig>();
            for (const rel of this.relatedObjects) {
                if (rel.field) map.set(rel.field, rel);
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
                relatedObject.relation = targetRelations.map((nested: DMMFField) => ({
                    name: nested.name,
                    object: nested.type,
                    isList: nested.isList,
                    field: nested.relationFromFields?.[0],
                    foreignKey: nested.relationToFields?.[0] || 'id',
                    ...(nested.relationFromFields && nested.relationFromFields.length > 1 ? {
                        fields: nested.relationFromFields,
                        foreignKeys: nested.relationToFields,
                    } : {}),
                }));
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
        this.#applyFilterValue(filterContext, fieldName, trimmedValue, modelName, user);
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
     * Navigate through relation path and return the filter context object and current model name
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

            // Create or navigate to the relation filter
            if (!filter[rel.name]) {
                const isListRel = rel.isList || dmmf.isListRelation(currentModelName, rel.name);

                if (isListRel) {
                    filter[rel.name] = { some: {} };
                    filter = filter[rel.name].some;
                } else {
                    filter[rel.name] = {};
                    filter = filter[rel.name];
                }
            } else {
                filter = filter[rel.name].some || filter[rel.name];
            }

            currentModelName = rel.object;
        }

        return { filter, modelName: currentModelName };
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
                // To-one relations use { is: null }; list relations can't be null — "no related rows" is { none: {} }
                filter[fieldName] = field.isList ? { none: {} } : { is: null };
            } else if (field.isRequired) {
                // Non-nullable scalar fields can never be null — reject the filter
                throw new ErrorResponse(400, "field_not_nullable", { field: fieldName });
            } else {
                filter[fieldName] = { equals: null };
            }
            return;
        }
        if (value === 'not:#NULL') {
            if (isRelation) {
                filter[fieldName] = field.isList ? { some: {} } : { isNot: null };
            } else if (field.isRequired) {
                // Non-nullable scalar fields are always not-null — skip (always true)
                return;
            } else {
                filter[fieldName] = { not: { equals: null } };
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

        // Handle not: prefix (negation)
        if (value.startsWith('not:')) {
            this.#applyNegatedFilter(filter, fieldName, value.substring(4), field);
            return;
        }

        // Apply typed filter based on the field's declared type
        this.#applyTypedFilter(filter, fieldName, value, field);
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

        // not:[array]
        if (value.startsWith('[') && value.endsWith(']')) {
            const arr = this.#parseArrayValue(value);
            if ((fieldType === 'String' || fieldType === null) && arr.some((v: unknown) => typeof v === 'string' && v.includes('%'))) {
                // Append — assignment would clobber a previous field's not:[...] group.
                // Prisma NOT arrays AND their entries, which is the right semantics here.
                if (!filter.NOT) filter.NOT = [];
                filter.NOT.push(...arr.map((v: unknown) => ({ [fieldName]: this.#filterString(String(v), fieldType === null) })));
            } else {
                filter[fieldName] = { notIn: this.#coerceArrayValues(arr, fieldName, fieldType) };
            }
            return;
        }

        // not:between:
        if (value.startsWith('between:')) {
            this.#applyNotBetween(filter, fieldName, value.substring(8), fieldType);
            return;
        }

        switch (fieldType) {
            case 'Number': {
                const numFilter = this.#filterNumber(value);
                if (!numFilter) {
                    throw new ErrorResponse(400, "invalid_filter_value", { field: fieldName, value, expected: 'number' });
                }
                filter[fieldName] = { not: numFilter };
                return;
            }
            case 'DateTime':
                filter[fieldName] = { not: this.#buildDateCondition(fieldName, value) };
                return;
            case 'Boolean':
                filter[fieldName] = { not: this.#parseBooleanValue(fieldName, value) };
                return;
            case 'String':
                filter[fieldName] = { not: this.#filterString(value, false) };
                return;
            case 'Enum':
                filter[fieldName] = { not: { equals: this.#safeDecode(value) } };
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
    #applyNotBetween(filter: Record<string, any>, fieldName: string, rangeValue: string, fieldType: string | null = null): void {
        const [start, end] = rangeValue.split(';').map((v: string) => v.trim());

        if (!start || !end) {
            throw new ErrorResponse(400, "between_requires_two_values");
        }

        const treatAsNumber = fieldType === 'Number' ||
            (fieldType === null && FILTER_PATTERNS.PURE_NUMBER.test(start) && FILTER_PATTERNS.PURE_NUMBER.test(end));

        if (treatAsNumber) {
            const startNum = this.#parseNumericValue(start);
            const endNum = this.#parseNumericValue(end);
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
            const startDate = new Date(start);
            const endDate = new Date(end);
            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
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

        // Arrays are handled per type so values can be coerced to the column type
        if (value.startsWith('[') && value.endsWith(']')) {
            const arr = this.#parseArrayValue(value);
            if ((fieldType === 'String' || fieldType === null) && arr.some((v: unknown) => typeof v === 'string' && v.includes('%'))) {
                // Each field's wildcard list is its own OR group nested under AND —
                // a shared top-level OR would merge groups across fields:
                // name=[%a%,%b%],title=[%c%,%d%] must mean (a OR b) AND (c OR d)
                const orGroup = arr.map((v: unknown) => ({ [fieldName]: this.#filterString(String(v), fieldType === null) }));
                if (!filter.AND) filter.AND = [];
                filter.AND.push({ OR: orGroup });
            } else {
                filter[fieldName] = { in: this.#coerceArrayValues(arr, fieldName, fieldType) };
            }
            return;
        }

        switch (fieldType) {
            case 'Number': {
                const numFilter = this.#filterNumber(value);
                if (!numFilter) {
                    throw new ErrorResponse(400, "invalid_filter_value", { field: fieldName, value, expected: 'number' });
                }
                filter[fieldName] = numFilter;
                return;
            }
            case 'DateTime':
                filter[fieldName] = this.#buildDateCondition(fieldName, value);
                return;
            case 'Boolean':
                filter[fieldName] = { equals: this.#parseBooleanValue(fieldName, value) };
                return;
            case 'String':
                filter[fieldName] = this.#filterString(value, false);
                return;
            case 'Enum':
                // Wildcards aren't supported on enum columns — exact match only
                filter[fieldName] = { equals: this.#safeDecode(value) };
                return;
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
    #buildDateCondition(fieldName: string, value: string): Record<string, any> {
        const opFilter = this.#filterDateTime(value);
        if (opFilter) {
            return opFilter;
        }

        // A date operator was present but produced no filter (e.g. between: with two numbers)
        if (FILTER_PATTERNS.DATE_OPS.some((op: string) => value.startsWith(op))) {
            throw new ErrorResponse(400, "invalid_date_format", { field: fieldName, value });
        }

        let date: Date;
        try {
            date = this.#parseDate(value);
        } catch {
            throw new ErrorResponse(400, "invalid_filter_value", { field: fieldName, value, expected: 'date' });
        }

        // Date-only values match the entire day (same semantics as 'on:')
        if (FILTER_PATTERNS.DATE_ONLY.test(value)) {
            return this.#calendarDay(value, date);
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
    #coerceArrayValues(arr: any[], fieldName: string, fieldType: string | null): any[] {
        switch (fieldType) {
            case 'Number':
                return arr.map((v: any) => {
                    const parsed = this.#parseNumericValue(String(v));
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
            case 'Enum':
                return arr.map((v: any) => typeof v === 'string' ? this.#safeDecode(v) : String(v));
            default:
                return arr;
        }
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
     * Parse array value from string
     */
    #parseArrayValue(value: string): any[] {
        let arr: any[];
        try {
            const parsed = JSON.parse(value);
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
    #filterNumber(value: string): Record<string, number | bigint> | null {
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
                    const start = this.#parseNumericValue(startStr);
                    const end = this.#parseNumericValue(endStr);
                    if (start == null || end == null) return null;
                    return { gte: start, lte: end };
                }
            }
        }

        const parsed = this.#parseNumericValue(numValue);
        if (parsed == null) return null;

        return { [prismaOp]: parsed };
    }

    /**
     * Parse a numeric string, returning BigInt for integers beyond safe range
     */
    #parseNumericValue(value: string): number | bigint | null {
        if (value == null) return null;
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
    #filterDateTime(value: string): Record<string, Date | Record<string, Date>> | null {
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
                const date = this.#parseDate(operatorValue);
                return { [simpleOperatorMap[foundOperator]]: date };
            }

            // Handle 'on:' - match entire day
            if (foundOperator === 'on:') {
                return this.#calendarDay(operatorValue, this.#parseDate(operatorValue));
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

                const startDate = this.#parseDate(start);
                const endDate = this.#parseDate(end);
                return { gte: startDate, lte: endDate };
            }

            return null;
        } catch (error: any) {
            if (error instanceof ErrorResponse) throw error;
            throw new ErrorResponse(400, "invalid_date_format", { value, error: error.message });
        }
    }

    /**
     * Parse a date string and validate it. With API_TIMEZONE set, a date-only value means
     * the start of that day in the configured zone (instead of UTC midnight).
     */
    #parseDate(dateStr: string): Date {
        const zone = filterTimeZone();
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
    #calendarDay(value: string, parsed: Date): { gte: Date; lt: Date } {
        const zone = filterTimeZone();
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
            const accessFilter = acl.model[relation.object].getAccessFilter!(user);

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
                const cleanedFilter = this.cleanFilter(accessFilter);
                const simplifiedFilter = this.#simplifyNestedFilter(cleanedFilter, parentModel, relation.object);
                if (simplifiedFilter && typeof simplifiedFilter === 'object' && Object.keys(simplifiedFilter).length > 0) {
                    content.where = simplifiedFilter;
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
                if (!childRelation) continue;

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

        // Validate: every relation referenced in fields must be in the include set
        for (const relationName of relations.keys()) {
            if (!availableRelations.has(relationName)) {
                throw new ErrorResponse(400, "relation_not_included", {
                    relation: relationName,
                    hint: `Add '${relationName}' to the include parameter`,
                });
            }
        }

        // Build select object
        const select: Record<string, any> = {};

        // Add top-level omit fields to exclude from selection
        const omitFields = this.omit(user);

        // Add scalar fields
        for (const field of scalars) {
            if (!omitFields[field]) {
                select[field] = true;
            }
        }

        // Add relations from the include param
        for (const relationName of availableRelations) {
            const rel = this.getRelationByName(relationName);
            if (!rel) continue;

            // Get ACL content for this relation (where, omit)
            const { content, denied } = this.#buildBaseIncludeContent(rel, user, this.name);
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
                // Relation is in include but no specific fields → include with all fields
                if (content.where || content.omit) {
                    select[relationName] = content;
                } else {
                    select[relationName] = true;
                }
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
     */
    create(data: Record<string, unknown>, user: any = null): Record<string, unknown> {
        // One working copy; the per-key processors edit it in place
        const result: Record<string, any> = { ...data };

        // Remove fields user shouldn't be able to set
        const { modelAcl, omitFields } = this.#resolveAclContext(this.name, user);
        for (const field of omitFields) {
            delete result[field];
        }
        this.#applyWritableWhitelist(result, modelAcl, user);

        const keys = Object.keys(result);
        for (const key of keys) {
            const field = this.fields[key];
            const isRelationField = field?.kind === 'object';

            // Handle relation fields or unknown keys
            if (field == null || isRelationField) {
                this.#processCreateRelation(result, key, user);
            } else {
                // Check if this scalar field is a FK that should become a connect
                this.#processForeignKeyField(result, key, user, false);
            }
        }

        return result;
    }

    /**
     * Process a relation field for create operation (edits `data`, the caller's working copy)
     */
    #processCreateRelation(
        data: Record<string, any>,
        key: string,
        user: any = null
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
                data[key].map((item: Record<string, any>) => ({ ...item })), relatedObject, key, user
            );
        } else {
            // Clone the nested object to avoid mutating original
            data[key] = this.#processCreateSingleRelation(
                { ...data[key] }, relatedObject, key, user
            );
        }
    }

    /**
     * Process array relation for create operation
     */
    #processCreateArrayRelation(
        items: Record<string, any>[],
        relatedObject: RelationConfig,
        relationName: string,
        user: any = null,
        depth: number = 0
    ): Record<string, any> {
        if (depth > MAX_NESTING_DEPTH) {
            throw new ErrorResponse(400, "max_nesting_depth_exceeded", { depth: MAX_NESTING_DEPTH });
        }

        this.#ensureRelations(relatedObject);

        for (let i = 0; i < items.length; i++) {
            this.#validateAndTransformRelationItem(items[i], relatedObject, relationName);
        }

        const relatedPrimaryKey = this.getPrimaryKey(relatedObject.object);
        const pkFields = Array.isArray(relatedPrimaryKey) ? relatedPrimaryKey : [relatedPrimaryKey];
        const foreignKey = relatedObject.foreignKey || pkFields[0];

        // For composite keys, check if ALL PK fields are present
        const hasCompletePK = (item: Record<string, any>): boolean => pkFields.every((field: string) => item[field] != null);

        // Check if an item has ONLY primary key fields (no additional data)
        const hasOnlyPKFields = (item: Record<string, any>): boolean => {
            const itemKeys = Object.keys(item);
            return itemKeys.every((key: string) => pkFields.includes(key));
        };

        const createItems: Record<string, any>[] = [];
        const connectOnlyItems: Record<string, any>[] = [];
        const upsertItems: Record<string, any>[] = [];
        for (const item of items) {
            if (!hasCompletePK(item)) {
                createItems.push(item);
            } else if (hasOnlyPKFields(item)) {
                connectOnlyItems.push(item);
            } else {
                upsertItems.push(item);
            }
        }

        // Get ACL context for the related model
        const { modelAcl: relatedAcl, accessFilter, omitFields } = this.#resolveAclContext(relatedObject.object, user);

        // Identifier fields address records in nested payloads — exempt from the writable
        // whitelist (n:m composite FK fields included, aligned with the update path)
        const identifierExempt = [...pkFields, foreignKey, ...(Array.isArray(relatedObject.fields) ? relatedObject.fields : [])];

        const result: Record<string, any> = {};

        if (createItems.length > 0) {
            // Check canCreate permission for nested creates
            this.#assertCanCreateAll(createItems, relatedAcl, user, relatedObject.object);

            // Remove omitted and non-writable fields from create items
            result.create = createItems.map((item: Record<string, any>) => {
                const cleanedItem: Record<string, any> = { ...item };
                for (const field of omitFields) {
                    delete cleanedItem[field];
                }
                this.#applyWritableWhitelist(cleanedItem, relatedAcl, user, identifierExempt);
                return cleanedItem;
            });
        }

        if (connectOnlyItems.length > 0) {
            if (pkFields.length > 1) {
                // Composite key - build composite where clause with ACL
                result.connect = connectOnlyItems.map((e: Record<string, any>) => {
                    const where: Record<string, any> = {};
                    pkFields.forEach((field: string) => { where[field] = e[field]; });
                    return this.#mergeAclIntoUniqueWhere(where, accessFilter);
                });
            } else {
                // Simple key with ACL
                result.connect = connectOnlyItems.map((e: Record<string, any>) => {
                    const where: Record<string, any> = { [foreignKey]: e[foreignKey] || e[pkFields[0]] };
                    return this.#mergeAclIntoUniqueWhere(where, accessFilter);
                });
            }
        }

        if (upsertItems.length > 0) {
            // Check canCreate permission for nested connectOrCreate
            this.#assertCanCreateAll(upsertItems, relatedAcl, user, relatedObject.object);

            // Remove omitted and non-writable fields from connectOrCreate items
            result.connectOrCreate = upsertItems.map((item: Record<string, any>) => {
                const cleanedItem: Record<string, any> = { ...item };
                for (const field of omitFields) {
                    delete cleanedItem[field];
                }
                this.#applyWritableWhitelist(cleanedItem, relatedAcl, user, identifierExempt);

                // Build where clause from PK fields
                const where: Record<string, any> = {};
                if (pkFields.length > 1) {
                    pkFields.forEach((field: string) => { where[field] = cleanedItem[field]; });
                } else {
                    where[foreignKey] = cleanedItem[foreignKey] || cleanedItem[pkFields[0]];
                }

                return {
                    where: this.#mergeAclIntoUniqueWhere(where, accessFilter),
                    create: cleanedItem,
                };
            });
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
        depth: number = 0
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

        // Apply omit fields
        for (const field of omitFields) {
            delete item[field];
        }

        // Apply writable-fields whitelist (related model's PK is an identifier, not data)
        const relatedPk = this.getPrimaryKey(relatedObject.object);
        this.#applyWritableWhitelist(item, relatedAcl, user, Array.isArray(relatedPk) ? relatedPk : [relatedPk]);

        // Ensure nested relations are resolved for deep processing
        this.#ensureRelations(relatedObject);

        for (const fieldKey of Object.keys(item)) {
            if (!this.#fieldExistsOnModel(relatedObject.object, fieldKey)) {
                throw new ErrorResponse(400, "unexpected_key", { key: `${relationName}.${fieldKey}` });
            }

            // Check if this field is a FK that should become a nested connect
            const childRelation = relatedObject?.relation?.find((e: RelationConfig) => e.field === fieldKey);
            if (childRelation && item[fieldKey]) {
                const targetPrimaryKey = childRelation.foreignKey || this.getPrimaryKey(childRelation.object);
                const connectWhere: Record<string, any> = {};

                // Handle composite primary keys
                if (Array.isArray(targetPrimaryKey)) {
                    if (typeof item[fieldKey] === 'object' && item[fieldKey] !== null) {
                        targetPrimaryKey.forEach((pk: string) => {
                            if (item[fieldKey][pk] != null) {
                                connectWhere[pk] = item[fieldKey][pk];
                            }
                        });
                    } else {
                        connectWhere[targetPrimaryKey[0]] = item[fieldKey];
                    }
                } else {
                    connectWhere[targetPrimaryKey] = item[fieldKey];
                }

                // Apply ACL access filter for connect
                const { accessFilter: childAccessFilter } = this.#resolveAclContext(childRelation.object, user);

                item[childRelation.name] = { connect: this.#mergeAclIntoUniqueWhere(connectWhere, childAccessFilter) };
                delete item[fieldKey];
                continue;
            }

            // Check if this field is a nested relation object that needs recursive processing
            const nestedRelation = relatedObject?.relation?.find((e: RelationConfig) => e.name === fieldKey);
            if (nestedRelation && item[fieldKey] && typeof item[fieldKey] === 'object') {
                this.#ensureRelations(nestedRelation);
                if (Array.isArray(item[fieldKey])) {
                    item[fieldKey] = this.#processCreateArrayRelation(
                        item[fieldKey].map((i: Record<string, any>) => ({ ...i })), nestedRelation, `${relationName}.${fieldKey}`, user, depth + 1
                    );
                } else {
                    item[fieldKey] = this.#processCreateSingleRelation(
                        { ...item[fieldKey] }, nestedRelation, `${relationName}.${fieldKey}`, user, depth + 1
                    );
                }
            }
        }

        return { create: { ...item } };
    }

    /**
     * Validate relation item fields and transform nested FK references
     */
    #validateAndTransformRelationItem(
        item: Record<string, any>,
        relatedObject: RelationConfig,
        relationName: string
    ): void {
        this.#ensureRelations(relatedObject);

        for (const fieldKey of Object.keys(item)) {
            if (!this.#fieldExistsOnModel(relatedObject.object, fieldKey)) {
                throw new ErrorResponse(400, "unexpected_key", { key: `${relationName}.${fieldKey}` });
            }

            // Handle composite FK fields
            if (relatedObject.fields?.includes(fieldKey)) {
                const index = relatedObject.fields.findIndex((f: string) => f === fieldKey);
                if (index > 0 && relatedObject.relation?.[index - 1]) {
                    const rel = relatedObject.relation[index - 1];
                    const relPrimaryKey = rel.foreignKey || this.getPrimaryKey(rel.object);
                    const restData: Record<string, any> = { ...item };
                    delete restData[fieldKey];

                    Object.assign(item, {
                        [rel.name]: { connect: { [relPrimaryKey as string]: item[fieldKey] } },
                        ...restData,
                    });
                    delete item[fieldKey];
                } else {
                    delete item[fieldKey];
                }
            }
        }
    }

    /**
     * Process a scalar field that is a FK to a to-one relation, turning it into a
     * relation connect. In update mode (allowDisconnect) a null value becomes a
     * disconnect; in create mode falsy values are simply dropped.
     * Shared by the create and update write transformers; edits `data`, their working copy.
     */
    #processForeignKeyField(
        data: Record<string, any>,
        key: string,
        user: any,
        allowDisconnect: boolean
    ): void {
        const relatedObject = this.getRelationByField(key);
        if (!relatedObject) return;

        const value = data[key];
        // Create mode keeps the historical truthy check; update mode connects on any non-null value
        const shouldConnect = allowDisconnect ? value != null : Boolean(value);

        if (shouldConnect) {
            const targetPrimaryKey = this.getPrimaryKey(relatedObject.object);
            const foreignKey = relatedObject.foreignKey || (Array.isArray(targetPrimaryKey) ? targetPrimaryKey[0] : targetPrimaryKey);
            // Build connect where clause
            const connectWhere: Record<string, any> = { [foreignKey]: value };

            // Apply ACL access filter for connect
            const { accessFilter } = this.#resolveAclContext(relatedObject.object, user);

            data[relatedObject.name] = { connect: this.#mergeAclIntoUniqueWhere(connectWhere, accessFilter) };
        } else if (allowDisconnect) {
            data[relatedObject.name] = { disconnect: true };
        }
        delete data[key];
    }

    /**
     * A plain row for bulk writes (createMany): fields the ACL hides or doesn't let this user
     * write are removed, nothing is transformed. Relations aren't supported by createMany.
     */
    sanitizeRow(data: Record<string, unknown>, user: any = null): Record<string, unknown> {
        const row: Record<string, any> = { ...data };
        const { modelAcl, omitFields } = this.#resolveAclContext(this.name, user);
        for (const field of omitFields) {
            delete row[field];
        }
        this.#applyWritableWhitelist(row, modelAcl, user);
        return row;
    }

    /**
     * Process data for update operation with nested relation support
     * Transforms nested relation data into Prisma update/upsert/connect/disconnect syntax
     * Does NOT mutate the input data - returns a new transformed object
     */
    update(id: string | number | null, data: Record<string, unknown>, user: any = null): Record<string, unknown> {
        // One working copy; the per-key processors edit it in place
        const result: Record<string, any> = { ...data };

        // Remove fields user shouldn't be able to modify
        const { modelAcl, omitFields } = this.#resolveAclContext(this.name, user);
        for (const field of omitFields) {
            delete result[field];
        }
        this.#applyWritableWhitelist(result, modelAcl, user);

        // The record's own key, unchanged, is not a write (clients echo it back; upserts carry
        // it). Dropping it avoids a pointless key update — and Prisma's checked update input,
        // used once a foreign key becomes a connect, has no autoincrement id at all.
        const pk = this.getPrimaryKey();
        if (id != null && typeof pk === 'string' && result[pk] != null && String(result[pk]) === String(id)) {
            delete result[pk];
        }

        const keys = Object.keys(result);
        for (const key of keys) {
            const field = this.fields[key];
            const isRelationField = field?.kind === 'object';

            // Handle relation fields or unknown keys
            if (field == null || isRelationField) {
                this.#processUpdateRelation(result, key, id, user);
            } else {
                // Check if this scalar field is a FK that should become a connect/disconnect
                this.#processForeignKeyField(result, key, user, true);
            }
        }

        return result;
    }

    /**
     * Process a relation field for update operation (edits `data`, the caller's working copy)
     */
    #processUpdateRelation(
        data: Record<string, any>,
        key: string,
        parentId: string | number | null,
        user: any
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
                data[key].map((item: Record<string, any>) => ({ ...item })), relatedObject, parentId, user
            );
        } else {
            // Clone the nested object to avoid mutating original
            data[key] = this.#processSingleRelation(
                { ...data[key] }, relatedObject, user
            );
        }
    }

    /**
     * Build the composite-key pair object for an n:m join-table where clause.
     * Values from the item take precedence; the parent id fills the first FK field when missing.
     * Throws when the composite key is incomplete (e.g. nested n:m updates where no parent id is available).
     */
    #buildCompositePairId(
        item: Record<string, any>,
        relatedObject: RelationConfig,
        parentId: string | number | null
    ): Record<string, any> {
        const fields = relatedObject.fields!;
        const pair_id: Record<string, any> = {};

        if (parentId != null) {
            pair_id[fields[0]] = parentId;
        }
        for (const field in item) {
            if (fields.includes(field)) {
                pair_id[field] = item[field];
            }
        }

        const missing = fields.filter((f: string) => pair_id[f] == null);
        if (missing.length > 0) {
            throw new ErrorResponse(400, "incomplete_composite_key", {
                relation: relatedObject.name,
                missing,
            });
        }

        return pair_id;
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
    #mergeAclIntoUniqueWhere(where: Record<string, any>, aclFilter: any): Record<string, any> {
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
        accessFilter: Record<string, any> | null;
        updateFilter: Record<string, any> | null;
        deleteFilter: Record<string, any> | null;
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
                return active && modelAcl?.getAccessFilter ? self.cleanFilter(modelAcl.getAccessFilter(user)) : null;
            },
            get updateFilter() {
                return active && modelAcl?.getUpdateFilter ? self.cleanFilter(modelAcl.getUpdateFilter(user)) : null;
            },
            get deleteFilter() {
                return active && modelAcl?.getDeleteFilter ? self.cleanFilter(modelAcl.getDeleteFilter(user)) : null;
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
     * Process array relations for update operations
     */
    #processArrayRelation(
        dataArray: Record<string, any>[],
        relatedObject: RelationConfig,
        parentId: string | number | null,
        user: any = null
    ): Record<string, any> {
        this.#ensureRelations(relatedObject);

        for (let i = 0; i < dataArray.length; i++) {
            // Validate all fields exist on the related model
            for (const _key in dataArray[i]) {
                if (!this.#fieldExistsOnModel(relatedObject.object, _key)) {
                    throw new ErrorResponse(400, "unexpected_key", { key: `${relatedObject.name}.${_key}` });
                }
            }

            // Process nested relations recursively if they exist
            if (relatedObject.relation) {
                dataArray[i] = this.#processNestedRelations(dataArray[i], relatedObject.relation, user);
            }
        }

        // Get primary key for the related model
        const relatedPrimaryKey = this.getPrimaryKey(relatedObject.object);
        const pkFields = Array.isArray(relatedPrimaryKey) ? relatedPrimaryKey : [relatedPrimaryKey];
        const foreignKey = relatedObject.foreignKey || pkFields[0];
        const isCompositePK = pkFields.length > 1;

        // Get ACL context for the related model
        const { modelAcl: relatedAcl, accessFilter, updateFilter, omitFields } = this.#resolveAclContext(relatedObject.object, user);

        // Identifier fields address records — exempt from the writable whitelist
        const identifierExempt = [...pkFields, foreignKey, ...(Array.isArray(relatedObject.fields) ? relatedObject.fields : [])];

        // Helper to remove omitted and non-writable fields from an object
        const removeOmitFields = (obj: Record<string, any>): Record<string, any> => {
            const cleaned: Record<string, any> = { ...obj };
            for (const field of omitFields) {
                delete cleaned[field];
            }
            this.#applyWritableWhitelist(cleaned, relatedAcl, user, identifierExempt);
            return cleaned;
        };

        // Helper to check if item has ALL PK fields
        const hasCompletePK = (item: Record<string, any>): boolean => pkFields.every((field: string) => item[field] != null);

        // Helper to check if item has ONLY the PK/FK fields (for connect)
        // For n:m relations (composite FK), checks if only the join table FK fields are present
        const hasOnlyPkFields = (item: Record<string, any>): boolean => {
            const keys = Object.keys(item);

            // For n:m relations with composite FK (e.g., PostTag with postId, tagId)
            if (Array.isArray(relatedObject.fields)) {
                // Check if all keys are part of the composite FK fields
                // e.g., { tagId: 5 } should be connect, { tagId: 5, weight: 3 } should be upsert
                return keys.every((k: string) => relatedObject.fields!.includes(k));
            }

            if (isCompositePK) {
                // For composite PK: all keys must be PK fields, and all PK fields must be present
                return keys.length === pkFields.length && keys.every((k: string) => pkFields.includes(k));
            }
            // For simple: only 1 key which is FK or PK
            return keys.length === 1 && (keys[0] === foreignKey || keys[0] === pkFields[0]);
        };

        // Logic:
        // - connect: item has ONLY the PK/FK fields (just linking an existing record)
        // - upsert: item has PK AND additional data fields (update if exists, create if not)
        // - create: item has NO PK (always create new record)
        // For n:m relations: { tagId: 5 } -> connect, { tagId: 5, weight: 3 } -> upsert
        const connectItems: Record<string, any>[] = [];
        const upsertItems: Record<string, any>[] = [];
        const createItems: Record<string, any>[] = [];

        for (const item of dataArray) {
            if (hasOnlyPkFields(item)) {
                // Only PK/FK fields provided - connect to existing record
                connectItems.push(item);
            } else if (hasCompletePK(item) || Array.isArray(relatedObject.fields)) {
                // Has PK + data fields OR is n:m relation with extra data - upsert
                upsertItems.push(item);
            } else {
                // No PK - create new record
                createItems.push(item);
            }
        }

        // Per-item create permission — items without a PK always create; reject outright when not allowed
        if (user && relatedAcl?.canCreate && createItems.length > 0) {
            for (const item of createItems) {
                if (!relatedAcl.canCreate(user, item)) {
                    throw new ErrorResponse(403, "no_permission_to_create", { model: relatedObject.object });
                }
            }
        }

        // For PK+data items an upsert may create — decided per item (upsert vs update-only)
        const itemCanCreate = (item: Record<string, any>): boolean =>
            !user || !relatedAcl?.canCreate || relatedAcl.canCreate(user, item);

        const result: Record<string, any> = {};

        // Build connect array with ACL access filter
        if (connectItems.length > 0) {
            result.connect = connectItems.map((e: Record<string, any>) => {
                const where: Record<string, any> = {};
                if (Array.isArray(relatedObject.fields)) {
                    // n:m relation - build composite key where clause
                    // e.g., { postId_tagId: { postId: parentId, tagId: e.tagId } }
                    where[relatedObject.field!] = this.#buildCompositePairId(e, relatedObject, parentId);
                } else if (isCompositePK) {
                    pkFields.forEach((field: string) => { where[field] = e[field]; });
                } else {
                    where[foreignKey] = e[foreignKey] || e[pkFields[0]];
                }
                // Apply access filter - user must have access to connect to this record
                return this.#mergeAclIntoUniqueWhere(where, accessFilter);
            });
        }

        // Build upsert or update arrays — per item, based on canCreate(user, item)
        if (upsertItems.length > 0) {
            const buildWhereClause = (e: Record<string, any>): Record<string, any> => {
                const where: Record<string, any> = {};
                if (Array.isArray(relatedObject.fields)) {
                    // Composite key relation (n:m via join table)
                    where[relatedObject.field!] = this.#buildCompositePairId(e, relatedObject, parentId);
                } else if (isCompositePK) {
                    // Composite PK - all fields must be present
                    pkFields.forEach((field: string) => { where[field] = e[field]; });
                } else {
                    // Simple PK present
                    where[pkFields[0]] = e[pkFields[0]];
                }
                // Apply update filter - user must have permission to update
                return this.#mergeAclIntoUniqueWhere(where, updateFilter);
            };

            const upsertable: Record<string, any>[] = [];
            const updateOnly: Record<string, any>[] = [];
            for (const e of upsertItems) {
                (itemCanCreate(e) ? upsertable : updateOnly).push(e);
            }

            if (upsertable.length > 0) {
                // User can create these - use upsert (update if exists, create if not)
                result.upsert = upsertable.map((e: Record<string, any>) => {
                    const cleanedData = removeOmitFields(e);
                    return {
                        'where': buildWhereClause(e),
                        'create': cleanedData,
                        'update': cleanedData,
                    };
                });
            }
            if (updateOnly.length > 0) {
                // User cannot create these - use update only (fails if record doesn't exist)
                result.update = updateOnly.map((e: Record<string, any>) => {
                    const cleanedData = removeOmitFields(e);
                    return {
                        'where': buildWhereClause(e),
                        'data': cleanedData,
                    };
                });
            }
        }

        // Build create array for items without PK (already validated per item above)
        if (createItems.length > 0) {
            result.create = createItems.map((e: Record<string, any>) => removeOmitFields(e));
        }

        return result;
    }

    /**
     * Process single relation for update operations with create/update separation
     */
    #processSingleRelation(
        dataObj: Record<string, any>,
        relatedObject: RelationConfig,
        user: any = null
    ): Record<string, any> | null {
        // Raw Prisma operations (connect, deleteMany, ...) — held to the related model's ACL
        if (isRawOperation(dataObj)) {
            return this.#secureRawOperations(dataObj, relatedObject, user);
        }

        // Get ACL context for the related model
        const { modelAcl: relatedAcl, omitFields } = this.#resolveAclContext(relatedObject.object, user);

        // A plain object payload becomes an upsert, which may create the related record
        if (user && !isSystemUser(user) && relatedAcl?.canCreate && !relatedAcl.canCreate(user, dataObj)) {
            throw new ErrorResponse(403, "no_permission_to_create", { model: relatedObject.object });
        }

        // Remove omitted fields from input
        for (const field of omitFields) {
            delete dataObj[field];
        }

        // Apply writable-fields whitelist (related model's PK is an identifier, not data)
        const singleRelPk = this.getPrimaryKey(relatedObject.object);
        this.#applyWritableWhitelist(dataObj, relatedAcl, user, Array.isArray(singleRelPk) ? singleRelPk : [singleRelPk]);

        // Validate all fields exist on the related model
        for (const _key in dataObj) {
            if (!this.#fieldExistsOnModel(relatedObject.object, _key)) {
                throw new ErrorResponse(400, "unexpected_key", { key: `${relatedObject.name}.${_key}` });
            }
        }

        // Ensure nested relations are resolved for deep processing
        this.#ensureRelations(relatedObject);

        // Process nested relations recursively if they exist
        let processedData: Record<string, any> = dataObj;
        if (relatedObject.relation) {
            processedData = this.#processNestedRelations(dataObj, relatedObject.relation, user);
        }

        // Prepare separate data objects for create and update
        const createData: Record<string, any> = { ...processedData };
        const updateData: Record<string, any> = { ...processedData };
        let hasDisconnects = false;

        // Process direct relations
        if (relatedObject.relation) {
            for (const relation_key in processedData) {
                const rel = relatedObject.relation.find((e: RelationConfig) => e.field === relation_key);
                if (rel) {
                    if (processedData[relation_key] != null) {
                        // Build connect where clause
                        const targetPK = this.getPrimaryKey(rel.object);
                        const connectKey = rel.foreignKey || (Array.isArray(targetPK) ? targetPK[0] : targetPK);
                        const connectWhere: Record<string, any> = {
                            [connectKey]: processedData[relation_key],
                        };

                        // Apply ACL access filter for connect
                        const { accessFilter: childAccessFilter } = this.#resolveAclContext(rel.object, user);

                        const connectObj = { 'connect': this.#mergeAclIntoUniqueWhere(connectWhere, childAccessFilter) };
                        createData[rel.name] = connectObj;
                        updateData[rel.name] = connectObj;
                    } else {
                        // For update, use disconnect when value is null
                        updateData[rel.name] = {
                            'disconnect': true,
                        };
                        hasDisconnects = true;
                        // For create, remove the relation entirely
                        delete createData[rel.name];
                    }
                    // Remove the original field from both
                    delete createData[relation_key];
                    delete updateData[relation_key];
                }
            }
        }

        // Check if we have meaningful content for create and update
        const hasCreateContent = this.#hasMeaningfulContent(createData);
        const hasUpdateContent = this.#hasMeaningfulContent(updateData) || hasDisconnects;

        // Build upsert object conditionally
        const upsertObj: Record<string, any> = {};

        if (hasCreateContent) {
            upsertObj.create = {
                ...createData,
            };
        }

        if (hasUpdateContent) {
            upsertObj.update = {
                ...updateData,
            };
        }

        // Only return upsert if we have at least one operation
        return Object.keys(upsertObj).length > 0 ? { 'upsert': upsertObj } : null;
    }

    /**
     * Recursively process nested relations in data objects
     */
    #processNestedRelations(
        dataObj: Record<string, any>,
        relatedObjects: RelationConfig[],
        user: any = null
    ): Record<string, any> {
        const processedData: Record<string, any> = { ...dataObj };

        for (const key in processedData) {
            const nestedRelation = relatedObjects.find((rel: RelationConfig) => rel.name === key);

            if (nestedRelation && processedData[key] && typeof processedData[key] === 'object') {
                // Ensure deep relations are available for recursive processing
                this.#ensureRelations(nestedRelation);

                if (Array.isArray(processedData[key])) {
                    // Clone each item to avoid mutating originals
                    processedData[key] = this.#processArrayRelation(
                        processedData[key].map((item: Record<string, any>) => ({ ...item })), nestedRelation, null, user
                    );
                } else {
                    // Clone the nested object to avoid mutating original
                    const nestedResult = this.#processSingleRelation(
                        { ...processedData[key] }, nestedRelation, user
                    );
                    if (nestedResult) {
                        processedData[key] = nestedResult;
                    } else {
                        delete processedData[key];
                    }
                }
            }
        }

        return processedData;
    }

    /**
     * Check if data object contains meaningful content for database operations
     */
    #hasMeaningfulContent(dataObj: Record<string, any>): boolean {
        return Object.keys(dataObj).length > 0 &&
            Object.keys(dataObj).some((key: string) => {
                const value = dataObj[key];
                if (value === null || value === undefined) return false;
                if (typeof value === 'object') {
                    // For nested objects, check if they have meaningful operations
                    return value.connect || value.disconnect || value.create || value.update || value.upsert;
                }
                return true;
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
     * Simplify nested filter by removing parent-referencing conditions.
     * When including comments from a post, conditions on the parent
     * ({post: {...}}) are already implied by the parent row and must be dropped.
     * Parent references are matched by RELATION NAME (resolved from the child model's
     * relations targeting the parent model), with the raw parent model name as fallback
     * for schemas where relation and model names coincide.
     */
    #simplifyNestedFilter(filter: any, parentModel: string, childModel?: string): any {
        const parentKeys = new Set<string>([parentModel]);
        if (childModel) {
            for (const rel of dmmf.buildRelationships(childModel)) {
                if (rel.object === parentModel) {
                    parentKeys.add(rel.name);
                }
            }
        }
        return this.#simplifyFilterByKeys(filter, parentKeys);
    }

    #simplifyFilterByKeys(filter: any, parentKeys: Set<string>): any {
        if (!filter || typeof filter !== 'object') {
            return filter;
        }

        if (Array.isArray(filter)) {
            const simplified = filter.map((item: any) => this.#simplifyFilterByKeys(item, parentKeys)).filter((item: any) => item !== null);
            return simplified.length > 0 ? simplified : null;
        }

        const simplified: Record<string, any> = {};
        for (const key in filter) {
            const value = filter[key];

            // Skip filters that reference the parent (we're already in that context)
            if (parentKeys.has(key)) {
                continue;
            }

            // Recursively process AND/OR arrays
            if (key === 'AND' || key === 'OR') {
                const simplifiedArray = this.#simplifyFilterByKeys(value, parentKeys);
                if (simplifiedArray && Array.isArray(simplifiedArray) && simplifiedArray.length > 0) {
                    simplified[key] = simplifiedArray;
                }
            } else {
                simplified[key] = value;
            }
        }

        // If simplified filter only has one condition in an AND/OR, unwrap it
        if (Object.keys(simplified).length === 1 && (simplified.AND || simplified.OR)) {
            const array = simplified.AND || simplified.OR;
            if (Array.isArray(array) && array.length === 1) {
                return array[0];
            }
        }

        return Object.keys(simplified).length > 0 ? simplified : null;
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

        // Handle Prisma error codes (PrismaClientKnownRequestError)
        if (error?.code && PRISMA_ERROR_MAP[error.code]) {
            const errorInfo = PRISMA_ERROR_MAP[error.code];
            statusCode = errorInfo.status;

            // Handle dynamic messages (e.g., P2002 duplicate)
            if (error.code === 'P2002') {
                const target = error.meta?.target;
                const modelName = error.meta?.modelName || '';
                // target can be string (MySQL constraint name) or string[] (field names)
                const fields = Array.isArray(target) ? target : (target ? [target] : []);
                const field = fields.join(', ');
                // Try to find the value from the data passed to errorHandler
                const value = fields.length === 1 && data[fields[0]] !== undefined
                    ? String(data[fields[0]])
                    : '';
                key = value ? 'duplicate_entry' : 'duplicate_entry_no_value';
                errorData = { model: modelName, field, value };
                message = LanguageDict.get(key, errorData, language);
            } else {
                key = errorInfo.message!;
                message = LanguageDict.get(key, null, language);
            }
        }
        // Handle PrismaClientValidationError — invalid arguments, type mismatches
        else if (error?.name === 'PrismaClientValidationError' || error?.constructor?.name === 'PrismaClientValidationError') {
            statusCode = 400;
            key = 'data_validation_error';
            // Extract the useful part: "Argument `equals`: Invalid value provided. Expected Int, provided String."
            const rawMessage = error.message || '';
            const argMatch = rawMessage.match(/Argument\s+`[^`]+`:\s*.+$/m);
            message = argMatch ? argMatch[0] : LanguageDict.get(key, null, language);
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