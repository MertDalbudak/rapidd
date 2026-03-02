import { prisma, prismaTransaction, getAcl } from '../core/prisma';
import { ErrorResponse } from '../core/errors';
import * as dmmf from '../core/dmmf';
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
const MAX_NESTING_DEPTH: number = 10;

// Pre-compiled regex patterns for better performance
const FILTER_PATTERNS = {
    // Split on comma, but not inside brackets
    FILTER_SPLIT: /,(?![^\[]*\])/,
    // ISO date format: 2024-01-01 or 2024-01-01T00:00:00
    ISO_DATE: /^\d{4}-\d{2}-\d{2}(T.*)?$/,
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
    P1001: { status: 500, message: 'Connection to the database could not be established' },

    // Query errors (4xx - client errors)
    P2000: { status: 400, message: 'The provided value for the column is too long' },
    P2001: { status: 404, message: 'The record searched for in the where condition does not exist' },
    P2002: { status: 409, message: null }, // Dynamic message for duplicates
    P2003: { status: 400, message: 'Foreign key constraint failed' },
    P2004: { status: 400, message: 'A constraint failed on the database' },
    P2005: { status: 400, message: 'The value stored in the database is invalid for the field type' },
    P2006: { status: 400, message: 'The provided value is not valid' },
    P2007: { status: 400, message: 'Data validation error' },
    P2008: { status: 400, message: 'Failed to parse the query' },
    P2009: { status: 400, message: 'Failed to validate the query' },
    P2010: { status: 500, message: 'Raw query failed' },
    P2011: { status: 400, message: 'Null constraint violation' },
    P2012: { status: 400, message: 'Missing a required value' },
    P2013: { status: 400, message: 'Missing the required argument' },
    P2014: { status: 400, message: 'The change would violate the required relation' },
    P2015: { status: 404, message: 'A related record could not be found' },
    P2016: { status: 400, message: 'Query interpretation error' },
    P2017: { status: 400, message: 'The records for relation are not connected' },
    P2018: { status: 404, message: 'The required connected records were not found' },
    P2019: { status: 400, message: 'Input error' },
    P2020: { status: 400, message: 'Value out of range for the type' },
    P2021: { status: 404, message: 'The table does not exist in the current database' },
    P2022: { status: 404, message: 'The column does not exist in the current database' },
    P2023: { status: 400, message: 'Inconsistent column data' },
    P2024: { status: 408, message: 'Timed out fetching a new connection from the connection pool' },
    P2025: { status: 404, message: 'Operation failed: required records not found' },
    P2026: { status: 400, message: 'Database provider does not support this feature' },
    P2027: { status: 500, message: 'Multiple errors occurred during query execution' },
    P2028: { status: 500, message: 'Transaction API error' },
    P2030: { status: 404, message: 'Cannot find a fulltext index for the search' },
    P2033: { status: 400, message: 'A number in the query exceeds 64 bit signed integer' },
    P2034: { status: 409, message: 'Transaction failed due to write conflict or deadlock' },
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

    /**
     * Initialize QueryBuilder with model name and configuration
     * @param name - The Prisma model name (e.g., 'users', 'company_profiles')
     */
    constructor(name: string) {
        this.name = name;
        this._relationshipsCache = null;
        this._relatedFieldsCache = {};
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
        return this._relationshipsCache;
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
     * Parse filter string into Prisma where conditions
     * Supports: numeric/date/string operators, not:, #NULL, not:#NULL
     */
    filter(q: string): Record<string, unknown> {
        if (typeof q !== 'string' || q.trim() === '') {
            return {};
        }

        const result: Record<string, unknown> = {};
        const filterParts = q.split(FILTER_PATTERNS.FILTER_SPLIT);

        for (const part of filterParts) {
            // Split only on first '=' to handle values containing '='
            const eqIndex = part.indexOf('=');
            if (eqIndex === -1) continue; // Skip invalid filter parts without '='
            const key = part.substring(0, eqIndex);
            const value = part.substring(eqIndex + 1);
            const relationPath = key.split('.').map((e: string) => e.trim());
            const fieldName = relationPath.pop()!;
            const trimmedValue = value?.trim() ?? null;

            // Validate field exists on model (for non-relation filters)
            if (relationPath.length === 0 && !this.fields[fieldName]) {
                throw new ErrorResponse(400, "invalid_filter_field", { field: fieldName });
            }

            // Navigate to the correct filter context for nested relations
            const { filter: filterContext, modelName } = this.#navigateToFilterContext(result, relationPath);

            // Apply the filter value (with model context for null/relation handling)
            this.#applyFilterValue(filterContext, fieldName, trimmedValue, modelName);
        }

        return result;
    }

    /**
     * Navigate through relation path and return the filter context object and current model name
     */
    #navigateToFilterContext(rootFilter: Record<string, any>, relationPath: string[]): { filter: Record<string, any>; modelName: string } {
        let filter: Record<string, any> = rootFilter;
        let currentRelations: RelationConfig[] | RelationConfig = this.relatedObjects;
        let currentModelName = this.name;

        for (const relationName of relationPath) {
            // Find the relation in current context
            const rel: RelationConfig | undefined = Array.isArray(currentRelations)
                ? currentRelations.find((r: RelationConfig) => r.name === relationName)
                : (currentRelations as RelationConfig)?.relation?.find((r: RelationConfig) => r.name === relationName);

            if (!rel) {
                throw new ErrorResponse(400, "relation_not_exist", {
                    relation: relationName,
                    modelName: this.name,
                });
            }

            // Create or navigate to the relation filter
            if (!filter[rel.name]) {
                const parentModelName = Array.isArray(currentRelations) ? this.name : (currentRelations as RelationConfig).object;
                const isListRel = rel.isList || dmmf.isListRelation(parentModelName, rel.name);

                if (isListRel && rel.field) {
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
            currentRelations = rel;
        }

        return { filter, modelName: currentModelName };
    }

    /**
     * Apply a filter value to a field in the filter context
     */
    #applyFilterValue(filter: Record<string, any>, fieldName: string, value: string | null, modelName: string = this.name): void {
        // Resolve field metadata from the correct model
        const fields = modelName === this.name ? this.fields : this.#getRelatedModelFields(modelName);
        const field = fields[fieldName];
        const isRelation = field?.kind === 'object';

        // Handle explicit null filter tokens
        if (value === '#NULL') {
            if (isRelation) {
                // Relations use { is: null } in Prisma
                filter[fieldName] = { is: null };
            } else if (field?.isRequired) {
                // Non-nullable scalar fields can never be null — reject the filter
                throw new ErrorResponse(400, "field_not_nullable", { field: fieldName });
            } else {
                filter[fieldName] = { equals: null };
            }
            return;
        }
        if (value === 'not:#NULL') {
            if (isRelation) {
                // Relations use { isNot: null } in Prisma
                filter[fieldName] = { isNot: null };
            } else if (field?.isRequired) {
                // Non-nullable scalar fields are always not-null — skip (always true)
                return;
            } else {
                filter[fieldName] = { not: { equals: null } };
            }
            return;
        }

        // Handle not: prefix (negation)
        if (value?.startsWith('not:')) {
            this.#applyNegatedFilter(filter, fieldName, value.substring(4), modelName);
            return;
        }

        // Skip empty/null values — don't filter on empty strings
        if (!value) {
            return;
        }

        // Try to apply typed filter (date, number, array, string)
        this.#applyTypedFilter(filter, fieldName, value);
    }

    /**
     * Apply a negated filter (not:value)
     */
    #applyNegatedFilter(filter: Record<string, any>, fieldName: string, value: string, modelName: string = this.name): void {
        // not:#NULL
        if (value === '#NULL') {
            const fields = modelName === this.name ? this.fields : this.#getRelatedModelFields(modelName);
            const field = fields[fieldName];

            if (field?.kind === 'object') {
                // Relations use { isNot: null } in Prisma
                filter[fieldName] = { isNot: null };
                return;
            }
            // Non-nullable scalar fields are always not-null — skip (always true)
            if (field?.isRequired) {
                return;
            }
            filter[fieldName] = { not: { equals: null } };
            return;
        }

        // not:[array]
        if (value.startsWith('[') && value.endsWith(']')) {
            const arr = this.#parseArrayValue(value);
            if (arr.some((v: unknown) => typeof v === 'string' && v.includes('%'))) {
                filter.NOT = arr.map((v: unknown) => ({ [fieldName]: this.#filterString(v as string) }));
            } else {
                filter[fieldName] = { notIn: arr };
            }
            return;
        }

        // not:between:
        if (value.startsWith('between:')) {
            this.#applyNotBetween(filter, fieldName, value.substring(8));
            return;
        }

        // Try date filter
        const dateFilter = this.#filterDateTime(value);
        if (dateFilter) {
            filter[fieldName] = { not: dateFilter };
            return;
        }

        // Try number filter
        if (this.#looksLikeNumber(value)) {
            const numFilter = this.#filterNumber(value);
            filter[fieldName] = numFilter ? { not: numFilter } : { not: Number(value) };
            return;
        }

        // Default to string filter
        filter[fieldName] = { not: this.#filterString(value) };
    }

    /**
     * Apply not:between: filter
     */
    #applyNotBetween(filter: Record<string, any>, fieldName: string, rangeValue: string): void {
        const [start, end] = rangeValue.split(';').map((v: string) => v.trim());

        if (!start || !end) {
            throw new ErrorResponse(400, "between_requires_two_values");
        }

        const isNumeric = FILTER_PATTERNS.PURE_NUMBER.test(start) && FILTER_PATTERNS.PURE_NUMBER.test(end);

        if (isNumeric) {
            filter.NOT = (filter.NOT || []).concat([{
                AND: [
                    { [fieldName]: { gte: parseFloat(start) } },
                    { [fieldName]: { lte: parseFloat(end) } },
                ],
            }]);
        } else {
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
        }
    }

    /**
     * Apply typed filter (auto-detect type: date, number, array, string)
     */
    #applyTypedFilter(filter: Record<string, any>, fieldName: string, value: string): void {
        // Check for date patterns first
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

        // Try numeric filter
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

        // Array filter
        if (value.startsWith('[') && value.endsWith(']')) {
            const arr = this.#parseArrayValue(value);
            if (arr.some((v: unknown) => typeof v === 'string' && v.includes('%'))) {
                if (!filter.OR) filter.OR = [];
                arr.forEach((v: unknown) => filter.OR.push({ [fieldName]: this.#filterString(v as string) }));
            } else {
                filter[fieldName] = { in: arr };
            }
            return;
        }

        // Default to string filter
        filter[fieldName] = this.#filterString(value);
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
        try {
            return JSON.parse(value);
        } catch {
            return value.slice(1, -1).split(',').map((v: string) => v.trim());
        }
    }

    /**
     * Parse numeric filter operators
     */
    #filterNumber(value: string): Record<string, number> | null {
        const numOperators = ['lt:', 'lte:', 'gt:', 'gte:', 'eq:', 'ne:', 'between:'];
        const foundOperator = numOperators.find((op: string) => value.startsWith(op));
        let numValue: string | number = value;
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
                    // Support between for decimals: between:1.5;3.7
                    const [start, end] = (numValue as string).split(';').map((v: string) => parseFloat(v.trim()));
                    if (isNaN(start) || isNaN(end)) return null;
                    return { gte: start, lte: end };
                }
            }
        }

        // Support decimal numbers
        numValue = parseFloat(numValue as string);
        if (isNaN(numValue)) return null;

        return { [prismaOp]: numValue };
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
                const date = this.#parseDate(operatorValue);
                return {
                    gte: new Date(date.getFullYear(), date.getMonth(), date.getDate()),
                    lt: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1),
                };
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
     * Parse a date string and validate it
     */
    #parseDate(dateStr: string): Date {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) {
            throw new Error(`Invalid date: ${dateStr}`);
        }
        return date;
    }

    /**
     * Parse string filters with wildcard support and URL decoding
     */
    #filterString(value: string): Record<string, string> | boolean {
        // Handle boolean literals
        if (value === 'true') return true;
        if (value === 'false') return false;

        const startsWithWildcard = value.startsWith('%');
        const endsWithWildcard = value.endsWith('%');

        // %value% -> contains
        if (startsWithWildcard && endsWithWildcard) {
            return { contains: decodeURIComponent(value.slice(1, -1)) };
        }
        // %value -> endsWith
        if (startsWithWildcard) {
            return { endsWith: decodeURIComponent(value.slice(1)) };
        }
        // value% -> startsWith
        if (endsWithWildcard) {
            return { startsWith: decodeURIComponent(value.slice(0, -1)) };
        }
        // exact match
        return { equals: decodeURIComponent(value) };
    }

    /**
     * Build base include content with omit fields and ACL filter.
     * Returns denied=true when ACL explicitly denies access (returns false).
     */
    #buildBaseIncludeContent(
        relation: RelationConfig,
        user: any,
        parentModel: string
    ): { content: Record<string, any>; hasContent: boolean; denied: boolean } {
        const acl = getAcl();
        const content: Record<string, any> = {};
        let hasContent = false;

        // Check ACL access for the related model
        if (relation.object && acl.model[relation.object]?.getAccessFilter) {
            const accessFilter = acl.model[relation.object].getAccessFilter!(user);

            // ACL explicitly denies access — skip this relation entirely
            if (accessFilter === false) {
                return { content, hasContent: false, denied: true };
            }

            // Apply ACL filter as where clause for list relations (Prisma only supports where on list includes)
            const isListRelation = this.#isListRelation(parentModel, relation.name);
            if (isListRelation && accessFilter && typeof accessFilter === 'object') {
                const cleanedFilter = this.cleanFilter(accessFilter);
                const simplifiedFilter = this.#simplifyNestedFilter(cleanedFilter, parentModel);
                if (simplifiedFilter && typeof simplifiedFilter === 'object' && Object.keys(simplifiedFilter).length > 0) {
                    content.where = simplifiedFilter;
                    hasContent = true;
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
        return content.omit || content.where ||
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
                            rel.where = exclude_rule[curr.name];
                        } else {
                            rel = { where: exclude_rule[curr.name] };
                        }
                    }
                    acc[curr.name] = rel;
                    return acc;
                }, {});
            } else {
                // Parse dot notation includes (e.g., "student.agency,course")
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
                                rel.where = exclude_rule[curr.name];
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
        const acl = getAcl();
        // Get omit fields from ACL if available
        let omit_fields = inaccessible_fields;

        if (!omit_fields && acl.model[this.name]?.getOmitFields) {
            omit_fields = acl.model[this.name].getOmitFields!(user);
        }

        if (omit_fields && Array.isArray(omit_fields)) {
            return omit_fields.reduce((acc: Record<string, boolean>, curr: string) => {
                acc[curr] = true;
                return acc;
            }, {});
        }
        return {};
    }

    /**
     * Get omit fields for a related object based on user role
     */
    getRelatedOmit(relatedModelName: string, user: any): Record<string, boolean> {
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
     * e.g. "agency.name" on obj → obj.agency = { select: { name: true } }
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
        const includeStr = typeof include === 'string' ? include : '';

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
            const rel = this.relatedObjects.find(r => r.name === relationName);
            if (!rel) continue;

            // Get ACL content for this relation (where, omit)
            const { content, denied } = this.#buildBaseIncludeContent(rel, user, this.name);
            if (denied) continue;

            const relationFields = relations.get(relationName);

            if (relationFields && relationFields.length > 0) {
                // User specified specific fields for this relation
                const relSelect: Record<string, any> = {};
                const relOmit = this.getRelatedOmit(rel.object, user);

                for (const f of relationFields) {
                    if (f.includes('.')) {
                        // Nested relation field (e.g. "agency.name" → agency: { select: { name: true } })
                        const dotIdx = f.indexOf('.');
                        const nestedRel = f.substring(0, dotIdx);
                        const nestedField = f.substring(dotIdx + 1);

                        if (!relSelect[nestedRel]) {
                            relSelect[nestedRel] = { select: {} };
                        } else if (relSelect[nestedRel] === true) {
                            relSelect[nestedRel] = { select: {} };
                        }
                        this.#setNestedField(relSelect[nestedRel].select, nestedField);
                    } else if (!relOmit[f]) {
                        relSelect[f] = true;
                    }
                }

                const entry: Record<string, any> = { select: relSelect };
                if (content.where) entry.where = content.where;
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
     * Build sort object for ordering results
     */
    sort(sortBy: string, sortOrder: string): Record<string, unknown> {
        if (typeof sortBy !== 'string') {
            throw new ErrorResponse(400, "sortby_must_be_string", { type: typeof sortBy });
        }
        if (typeof sortOrder !== 'string' || (sortOrder != 'desc' && sortOrder != 'asc')) {
            throw new ErrorResponse(400, "sortorder_invalid", { value: sortOrder });
        }
        const relation_chain = sortBy.split('.').map((e: string) => e.trim());
        const field_name = relation_chain.pop()!;

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
     */
    create(data: Record<string, unknown>, user: any = null): Record<string, unknown> {
        const acl = getAcl();
        let result: Record<string, any> = { ...data };

        // Remove fields user shouldn't be able to set
        const modelAcl = acl.model[this.name];
        const omitFields = user && modelAcl?.getOmitFields
            ? modelAcl.getOmitFields(user)
            : [];
        for (const field of omitFields) {
            delete result[field];
        }

        const keys = Object.keys(result);
        for (const key of keys) {
            const field = this.fields[key];
            const isRelationField = field?.kind === 'object';

            // Handle relation fields or unknown keys
            if (field == null || isRelationField) {
                result = this.#processCreateRelation(result, key, user);
            } else {
                // Check if this scalar field is a FK that should become a connect
                result = this.#processCreateForeignKey(result, key, user);
            }
        }

        return result;
    }

    /**
     * Process a relation field for create operation
     */
    #processCreateRelation(
        data: Record<string, any>,
        key: string,
        user: any = null
    ): Record<string, any> {
        const relatedObject = this.relatedObjects.find((e: RelationConfig) => e.name === key);
        if (!relatedObject) {
            throw new ErrorResponse(400, "unexpected_key", { key });
        }

        if (!data[key]) return data;

        this.#ensureRelations(relatedObject);

        const result: Record<string, any> = { ...data };
        if (Array.isArray(data[key])) {
            // Clone each item to avoid mutating original nested objects
            result[key] = this.#processCreateArrayRelation(
                data[key].map((item: Record<string, any>) => ({ ...item })), relatedObject, key, user
            );
        } else {
            // Clone the nested object to avoid mutating original
            result[key] = this.#processCreateSingleRelation(
                { ...data[key] }, relatedObject, key, user
            );
        }
        return result;
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
        const acl = getAcl();

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

        const createItems = items.filter((e: Record<string, any>) => !hasCompletePK(e));
        const connectOnlyItems = items.filter((e: Record<string, any>) => hasCompletePK(e) && hasOnlyPKFields(e));
        const upsertItems = items.filter((e: Record<string, any>) => hasCompletePK(e) && !hasOnlyPKFields(e));

        // Get ACL for the related model
        const relatedAcl = acl.model[relatedObject.object];
        const accessFilter = user && relatedAcl?.getAccessFilter
            ? this.cleanFilter(relatedAcl.getAccessFilter(user))
            : null;

        // Get omit fields for nested creates
        const omitFields = user && relatedAcl?.getOmitFields
            ? relatedAcl.getOmitFields(user)
            : [];

        const result: Record<string, any> = {};

        if (createItems.length > 0) {
            // Check canCreate permission for nested creates
            if (user && relatedAcl?.canCreate) {
                for (const item of createItems) {
                    if (!relatedAcl.canCreate(user, item)) {
                        throw new ErrorResponse(403, "no_permission_to_create", { model: relatedObject.object });
                    }
                }
            }

            // Remove omitted fields from create items
            result.create = createItems.map((item: Record<string, any>) => {
                const cleanedItem: Record<string, any> = { ...item };
                for (const field of omitFields) {
                    delete cleanedItem[field];
                }
                return cleanedItem;
            });
        }

        if (connectOnlyItems.length > 0) {
            if (pkFields.length > 1) {
                // Composite key - build composite where clause with ACL
                result.connect = connectOnlyItems.map((e: Record<string, any>) => {
                    const where: Record<string, any> = {};
                    pkFields.forEach((field: string) => { where[field] = e[field]; });
                    // Apply ACL access filter
                    if (accessFilter && typeof accessFilter === 'object' && Object.keys(accessFilter).length > 0) {
                        Object.assign(where, accessFilter);
                    }
                    return where;
                });
            } else {
                // Simple key with ACL
                result.connect = connectOnlyItems.map((e: Record<string, any>) => {
                    const where: Record<string, any> = { [foreignKey]: e[foreignKey] || e[pkFields[0]] };
                    // Apply ACL access filter
                    if (accessFilter && typeof accessFilter === 'object' && Object.keys(accessFilter).length > 0) {
                        Object.assign(where, accessFilter);
                    }
                    return where;
                });
            }
        }

        if (upsertItems.length > 0) {
            // Check canCreate permission for nested connectOrCreate
            if (user && relatedAcl?.canCreate) {
                for (const item of upsertItems) {
                    if (!relatedAcl.canCreate(user, item)) {
                        throw new ErrorResponse(403, "no_permission_to_create", { model: relatedObject.object });
                    }
                }
            }

            // Remove omitted fields from connectOrCreate items
            result.connectOrCreate = upsertItems.map((item: Record<string, any>) => {
                const cleanedItem: Record<string, any> = { ...item };
                for (const field of omitFields) {
                    delete cleanedItem[field];
                }

                // Build where clause from PK fields
                const where: Record<string, any> = {};
                if (pkFields.length > 1) {
                    pkFields.forEach((field: string) => { where[field] = cleanedItem[field]; });
                } else {
                    where[foreignKey] = cleanedItem[foreignKey] || cleanedItem[pkFields[0]];
                }

                // Apply ACL access filter
                if (accessFilter && typeof accessFilter === 'object' && Object.keys(accessFilter).length > 0) {
                    Object.assign(where, accessFilter);
                }

                return {
                    where,
                    create: cleanedItem,
                };
            });
        }

        return result;
    }

    /**
     * Process single relation for create operation
     */
    #processCreateSingleRelation(
        item: Record<string, any>,
        relatedObject: RelationConfig,
        relationName: string,
        user: any = null,
        depth: number = 0
    ): Record<string, any> {
        const acl = getAcl();

        if (depth > MAX_NESTING_DEPTH) {
            throw new ErrorResponse(400, "max_nesting_depth_exceeded", { depth: MAX_NESTING_DEPTH });
        }

        // Get ACL for the related model
        const relatedAcl = acl.model[relatedObject.object];

        // Check canCreate permission
        if (user && relatedAcl?.canCreate && !relatedAcl.canCreate(user, item)) {
            throw new ErrorResponse(403, "no_permission_to_create", { model: relatedObject.object });
        }

        // If item is already a Prisma operation (connect, create, etc.), skip field validation
        const prismaOps = ['connect', 'create', 'disconnect', 'set', 'update', 'upsert', 'deleteMany', 'updateMany', 'createMany'];
        if (prismaOps.some((op: string) => op in item)) {
            return { ...item };
        }

        // Get and apply omit fields
        const omitFields = user && relatedAcl?.getOmitFields
            ? relatedAcl.getOmitFields(user)
            : [];
        for (const field of omitFields) {
            delete item[field];
        }

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
                const childAcl = acl.model[childRelation.object];
                const accessFilter = user && childAcl?.getAccessFilter
                    ? this.cleanFilter(childAcl.getAccessFilter(user))
                    : null;
                if (accessFilter && typeof accessFilter === 'object' && Object.keys(accessFilter).length > 0) {
                    Object.assign(connectWhere, accessFilter);
                }

                item[childRelation.name] = { connect: connectWhere };
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
     * Process a scalar field that might be a FK needing connect transformation
     */
    #processCreateForeignKey(
        data: Record<string, any>,
        key: string,
        user: any = null
    ): Record<string, any> {
        const acl = getAcl();
        const relatedObject = this.relatedObjects.find((e: RelationConfig) => e.field === key);
        if (!relatedObject) return data;

        const result: Record<string, any> = { ...data };
        if (result[key]) {
            const targetPrimaryKey = this.getPrimaryKey(relatedObject.object);
            const foreignKey = relatedObject.foreignKey || (Array.isArray(targetPrimaryKey) ? targetPrimaryKey[0] : targetPrimaryKey);
            // Build connect where clause
            const connectWhere: Record<string, any> = { [foreignKey]: result[key] };

            // Apply ACL access filter for connect
            const relatedAcl = acl.model[relatedObject.object];
            const accessFilter = user && relatedAcl?.getAccessFilter
                ? this.cleanFilter(relatedAcl.getAccessFilter(user))
                : null;
            if (accessFilter && typeof accessFilter === 'object' && Object.keys(accessFilter).length > 0) {
                Object.assign(connectWhere, accessFilter);
            }

            result[relatedObject.name] = { connect: connectWhere };
        }
        delete result[key];
        return result;
    }

    /**
     * Process data for update operation with nested relation support
     * Transforms nested relation data into Prisma update/upsert/connect/disconnect syntax
     * Does NOT mutate the input data - returns a new transformed object
     */
    update(id: string | number, data: Record<string, unknown>, user: any = null): Record<string, unknown> {
        const acl = getAcl();
        let result: Record<string, any> = { ...data };

        // Remove fields user shouldn't be able to modify
        const modelAcl = acl.model[this.name];
        const omitFields = user && modelAcl?.getOmitFields
            ? modelAcl.getOmitFields(user)
            : [];
        for (const field of omitFields) {
            delete result[field];
        }

        const keys = Object.keys(result);
        for (const key of keys) {
            const field = this.fields[key];
            const isRelationField = field?.kind === 'object';

            // Handle relation fields or unknown keys
            if (field == null || isRelationField) {
                result = this.#processUpdateRelation(result, key, id, user);
            } else {
                // Check if this scalar field is a FK that should become a connect/disconnect
                result = this.#processUpdateForeignKey(result, key, user);
            }
        }

        return result;
    }

    /**
     * Process a relation field for update operation
     */
    #processUpdateRelation(
        data: Record<string, any>,
        key: string,
        parentId: string | number,
        user: any
    ): Record<string, any> {
        const relatedObject = this.relatedObjects.find((e: RelationConfig) => e.name === key);
        if (!relatedObject) {
            throw new ErrorResponse(400, "unexpected_key", { key });
        }

        if (!data[key]) return data;

        this.#ensureRelations(relatedObject);

        const result: Record<string, any> = { ...data };
        if (Array.isArray(data[key])) {
            // Clone each item to avoid mutating original nested objects
            result[key] = this.#processArrayRelation(
                data[key].map((item: Record<string, any>) => ({ ...item })), relatedObject, parentId, user
            );
        } else {
            // Clone the nested object to avoid mutating original
            result[key] = this.#processSingleRelation(
                { ...data[key] }, relatedObject, user
            );
        }
        return result;
    }

    /**
     * Process a scalar field that might be a FK needing connect/disconnect transformation
     */
    #processUpdateForeignKey(
        data: Record<string, any>,
        key: string,
        user: any = null
    ): Record<string, any> {
        const acl = getAcl();
        const relatedObject = this.relatedObjects.find((e: RelationConfig) => e.field === key);
        if (!relatedObject) return data;

        const result: Record<string, any> = { ...data };
        const targetPrimaryKey = this.getPrimaryKey(relatedObject.object);
        const foreignKey = relatedObject.foreignKey || (Array.isArray(targetPrimaryKey) ? targetPrimaryKey[0] : targetPrimaryKey);

        if (result[key] != null) {
            // Build connect where clause
            const connectWhere: Record<string, any> = { [foreignKey]: result[key] };

            // Apply ACL access filter for connect
            const relatedAcl = acl.model[relatedObject.object];
            const accessFilter = user && relatedAcl?.getAccessFilter
                ? this.cleanFilter(relatedAcl.getAccessFilter(user))
                : null;
            if (accessFilter && typeof accessFilter === 'object' && Object.keys(accessFilter).length > 0) {
                Object.assign(connectWhere, accessFilter);
            }

            result[relatedObject.name] = { connect: connectWhere };
        } else {
            result[relatedObject.name] = { disconnect: true };
        }
        delete result[key];
        return result;
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
        const acl = getAcl();
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

        // Get ACL filters for the related model
        const relatedAcl = acl.model[relatedObject.object];
        const accessFilter = user && relatedAcl?.getAccessFilter
            ? this.cleanFilter(relatedAcl.getAccessFilter(user))
            : null;
        const updateFilter = user && relatedAcl?.getUpdateFilter
            ? this.cleanFilter(relatedAcl.getUpdateFilter(user))
            : null;

        // Get omit fields for create/update operations
        const omitFields = user && relatedAcl?.getOmitFields
            ? relatedAcl.getOmitFields(user)
            : [];

        // Helper to remove omitted fields from an object
        const removeOmitFields = (obj: Record<string, any>): Record<string, any> => {
            const cleaned: Record<string, any> = { ...obj };
            for (const field of omitFields) {
                delete cleaned[field];
            }
            return cleaned;
        };

        // Helper to check if item has ALL PK fields
        const hasCompletePK = (item: Record<string, any>): boolean => pkFields.every((field: string) => item[field] != null);

        // Helper to check if item has ONLY the PK/FK fields (for connect)
        // For n:m relations (composite FK), checks if only the join table FK fields are present
        const hasOnlyPkFields = (item: Record<string, any>): boolean => {
            const keys = Object.keys(item);

            // For n:m relations with composite FK (e.g., StudentCourse with studentId, courseId)
            if (Array.isArray(relatedObject.fields)) {
                // Check if all keys are part of the composite FK fields
                // e.g., { courseId: 5 } should be connect, { courseId: 5, grade: 'A' } should be upsert
                return keys.every((k: string) => relatedObject.fields!.includes(k));
            }

            if (isCompositePK) {
                // For composite PK: all keys must be PK fields, and all PK fields must be present
                return keys.length === pkFields.length && keys.every((k: string) => pkFields.includes(k));
            }
            // For simple: only 1 key which is FK or PK
            return keys.length === 1 && (keys[0] === foreignKey || keys[0] === pkFields[0]);
        };

        // Helper to merge ACL filter into where clause
        const mergeAclFilter = (where: Record<string, any>, aclFilter: any): Record<string, any> => {
            if (aclFilter && typeof aclFilter === 'object' && Object.keys(aclFilter).length > 0) {
                Object.assign(where, aclFilter);
            }
            return where;
        };

        // Logic:
        // - connect: item has ONLY the PK/FK fields (just linking an existing record)
        // - upsert: item has PK AND additional data fields (update if exists, create if not)
        // - create: item has NO PK (always create new record)
        // For n:m relations: { courseId: 5 } -> connect, { courseId: 5, grade: 'A' } -> upsert
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

        // Check canCreate permission for items that may create records
        const canCreate = !user || !relatedAcl?.canCreate || relatedAcl.canCreate(user);

        // Check per-item for createItems (no PK = always creates)
        if (user && relatedAcl?.canCreate && createItems.length > 0) {
            for (const item of createItems) {
                if (!relatedAcl.canCreate(user, item)) {
                    throw new ErrorResponse(403, "no_permission_to_create", { model: relatedObject.object });
                }
            }
        }

        const result: Record<string, any> = {};

        // Build connect array with ACL access filter
        if (connectItems.length > 0) {
            result.connect = connectItems.map((e: Record<string, any>) => {
                const where: Record<string, any> = {};
                if (Array.isArray(relatedObject.fields)) {
                    // n:m relation - build composite key where clause
                    // e.g., { studentId_courseId: { studentId: parentId, courseId: e.courseId } }
                    const pair_id: Record<string, any> = {};
                    pair_id[relatedObject.fields[0]] = parentId;
                    for (const field in e) {
                        if (relatedObject.fields.includes(field)) {
                            pair_id[field] = e[field];
                        }
                    }
                    where[relatedObject.field!] = pair_id;
                } else if (isCompositePK) {
                    pkFields.forEach((field: string) => { where[field] = e[field]; });
                } else {
                    where[foreignKey] = e[foreignKey] || e[pkFields[0]];
                }
                // Apply access filter - user must have access to connect to this record
                return mergeAclFilter(where, accessFilter);
            });
        }

        // Build upsert or update array based on canCreate permission
        if (upsertItems.length > 0) {
            const buildWhereClause = (e: Record<string, any>): Record<string, any> => {
                const where: Record<string, any> = {};
                if (Array.isArray(relatedObject.fields)) {
                    // Composite key relation (n:m via join table)
                    const pair_id: Record<string, any> = {};
                    pair_id[relatedObject.fields[0]] = parentId;
                    for (const field in e) {
                        if (relatedObject.fields.includes(field)) {
                            pair_id[field] = e[field];
                        }
                    }
                    where[relatedObject.field!] = pair_id;
                } else if (isCompositePK) {
                    // Composite PK - all fields must be present
                    pkFields.forEach((field: string) => { where[field] = e[field]; });
                } else {
                    // Simple PK present
                    where[pkFields[0]] = e[pkFields[0]];
                }
                // Apply update filter - user must have permission to update
                mergeAclFilter(where, updateFilter);
                return where;
            };

            if (canCreate) {
                // User can create - use upsert (update if exists, create if not)
                result.upsert = upsertItems.map((e: Record<string, any>) => {
                    const cleanedData = removeOmitFields(e);
                    return {
                        'where': buildWhereClause(e),
                        'create': cleanedData,
                        'update': cleanedData,
                    };
                });
            } else {
                // User cannot create - use update only (fails if record doesn't exist)
                result.update = upsertItems.map((e: Record<string, any>) => {
                    const cleanedData = removeOmitFields(e);
                    return {
                        'where': buildWhereClause(e),
                        'data': cleanedData,
                    };
                });
            }
        }

        // Build create array for items without PK (only if canCreate is true)
        if (createItems.length > 0 && canCreate) {
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
        const acl = getAcl();

        // Get ACL for the related model
        const relatedAcl = acl.model[relatedObject.object];

        // Check canCreate permission since upsert may create new records
        if (user && relatedAcl?.canCreate && !relatedAcl.canCreate(user, dataObj)) {
            throw new ErrorResponse(403, "no_permission_to_create", { model: relatedObject.object });
        }

        // If dataObj is already a Prisma operation (connect, create, disconnect, etc.), skip field validation
        const prismaOps = ['connect', 'create', 'disconnect', 'set', 'update', 'upsert', 'deleteMany', 'updateMany', 'createMany'];
        if (prismaOps.some((op: string) => op in dataObj)) {
            return dataObj;
        }

        // Get omit fields
        const omitFields = user && relatedAcl?.getOmitFields
            ? relatedAcl.getOmitFields(user)
            : [];

        // Remove omitted fields from input
        for (const field of omitFields) {
            delete dataObj[field];
        }

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
                        const childAcl = acl.model[rel.object];
                        const childAccessFilter = user && childAcl?.getAccessFilter
                            ? this.cleanFilter(childAcl.getAccessFilter(user))
                            : null;
                        if (childAccessFilter && typeof childAccessFilter === 'object' && Object.keys(childAccessFilter).length > 0) {
                            Object.assign(connectWhere, childAccessFilter);
                        }

                        const connectObj = { 'connect': connectWhere };
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
     * Simplify nested filter by removing parent relation filters
     * When including appointments from student_tariff, remove {student_tariff: {...}} filters
     */
    #simplifyNestedFilter(filter: any, parentModel: string): any {
        if (!filter || typeof filter !== 'object') {
            return filter;
        }

        if (Array.isArray(filter)) {
            const simplified = filter.map((item: any) => this.#simplifyNestedFilter(item, parentModel)).filter((item: any) => item !== null);
            return simplified.length > 0 ? simplified : null;
        }

        const simplified: Record<string, any> = {};
        for (const key in filter) {
            const value = filter[key];

            // Skip filters that reference the parent model (we're already in that context)
            if (key === parentModel) {
                continue;
            }

            // Recursively process AND/OR arrays
            if (key === 'AND' || key === 'OR') {
                const simplifiedArray = this.#simplifyNestedFilter(value, parentModel);
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
            if (array.length === 1) {
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
     * Handle Prisma errors and convert to standardized error responses
     */
    static errorHandler(error: any, data: Record<string, unknown> = {}): QueryErrorResponse {
        console.error(error);

        // Default values
        let statusCode: number = error.status_code || 500;
        let message: string = error instanceof ErrorResponse
            ? error.message
            : (process.env.NODE_ENV === 'production' ? 'Something went wrong' : (error.message || String(error)));

        // Handle Prisma error codes
        if (error?.code && PRISMA_ERROR_MAP[error.code]) {
            const errorInfo = PRISMA_ERROR_MAP[error.code];
            statusCode = errorInfo.status;

            // Handle dynamic messages (e.g., P2002 duplicate)
            if (error.code === 'P2002') {
                const target = error.meta?.target;
                const modelName = error.meta?.modelName;
                message = `Duplicate entry for ${modelName}. Record with ${target}: '${data[target as string]}' already exists`;
            } else {
                message = errorInfo.message!;
            }
        }

        return { status_code: statusCode, message };
    }
}

export { QueryBuilder, prisma, prismaTransaction, PRISMA_ERROR_MAP };
