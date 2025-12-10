const {prisma, prismaTransaction, acl} = require('../rapidd/rapidd');
const { ErrorResponse } = require('./Api');
const dmmf = require('../rapidd/dmmf');

const API_RESULT_LIMIT = parseInt(process.env.API_RESULT_LIMIT, 10) || 500;

// Pre-compiled regex patterns for better performance
const FILTER_PATTERNS = {
    // Split on comma, but not inside brackets
    FILTER_SPLIT: /,(?![^\[]*\])/,
    // ISO date format: 2024-01-01 or 2024-01-01T00:00:00
    ISO_DATE: /^\d{4}-\d{2}-\d{2}(T.*)?$/,
    // Pure number (integer or decimal, optionally negative)
    PURE_NUMBER: /^-?\d+(\.\d+)?$/,
    // Numeric operators
    NUMERIC_OPS: ['lt:', 'lte:', 'gt:', 'gte:', 'eq:', 'ne:', 'between:'],
    // Date operators
    DATE_OPS: ['before:', 'after:', 'from:', 'to:', 'on:', 'between:']
};

/**
 * QueryBuilder - Builds Prisma queries with relation handling, filtering, and ACL support
 *
 * @description
 * A comprehensive query builder that translates simplified API requests into valid Prisma queries.
 * Handles nested relations, field validation, filtering with operators, and access control.
 *
 * @example
 * const qb = new QueryBuilder('users');
 * const filter = qb.filter('name=%John%,age=gt:18');
 * const include = qb.include('posts.comments', user);
 */
class QueryBuilder {
    /**
     * Initialize QueryBuilder with model name and configuration
     * @param {string} name - The Prisma model name (e.g., 'users', 'company_profiles')
     */
    constructor(name) {
        /** @type {string} The model name */
        this.name = name;
        /** @private @type {Object[]|null} Cached relationships configuration */
        this._relationshipsCache = null;
        /** @private @type {Object|null} Cached fields for related models */
        this._relatedFieldsCache = {};
    }

    /**
     * Get all fields for this model from DMMF (including relation fields)
     * @returns {Object<string, Object>} Object with field names as keys and DMMF field objects as values
     */
    get fields() {
        return dmmf.getFields(this.name);
    }

    /**
     * Get only scalar fields (non-relation) for this model from DMMF
     * @returns {Object<string, Object>} Object with scalar field names as keys
     */
    get scalarFields() {
        return dmmf.getScalarFields(this.name);
    }

    /**
     * Get relationships configuration for this model from DMMF
     * Builds relationships dynamically from Prisma schema
     * @returns {Object[]} Array of relationship configurations with nested relation info
     */
    get relatedObjects() {
        if (this._relationshipsCache) {
            return this._relationshipsCache;
        }

        this._relationshipsCache = dmmf.buildRelationships(this.name);
        return this._relationshipsCache;
    }

    /**
     * Get DMMF model object by name
     * @param {string} [name=this.name] - The model name
     * @returns {Object|undefined} DMMF model object or undefined if not found
     */
    getDmmfModel(name = this.name) {
        return dmmf.getModel(name);
    }

    /**
     * Get primary key field(s) for a given model
     * @param {string} [modelName=this.name] - The model name
     * @returns {string|string[]} Primary key field name or array of field names for composite keys
     */
    getPrimaryKey(modelName = this.name) {
        return dmmf.getPrimaryKey(modelName);
    }

    /**
     * Get fields for a related model (cached for performance)
     * @param {string} modelName - The related model name
     * @returns {Object<string, Object>} Object with field names as keys
     * @private
     */
    #getRelatedModelFields(modelName) {
        if (!this._relatedFieldsCache[modelName]) {
            this._relatedFieldsCache[modelName] = dmmf.getFields(modelName);
        }
        return this._relatedFieldsCache[modelName];
    }

    /**
     * Check if a field exists on a model
     * @param {string} modelName - The model name
     * @param {string} fieldName - The field name to check
     * @returns {boolean} True if field exists
     * @private
     */
    #fieldExistsOnModel(modelName, fieldName) {
        const fields = this.#getRelatedModelFields(modelName);
        return fields[fieldName] != null;
    }

    /**
     * Build select object for specified fields
     * @param {Array|null} fields - Fields to select, null for all
     * @returns {Object} Prisma select object
     */
    select(fields = null) {
        if (fields == null) {
            fields = {};
            for (let key in this.fields) {
                fields[key] = true;
            }
        } else {
            fields = fields.reduce((acc, curr) => {
                acc[curr] = true;
                return acc;
            }, {});
        }
        return fields;
    }

    /**
     * Parse filter string into Prisma where conditions
     * Supports: numeric/date/string operators, not:, #NULL, not:#NULL
     * @param {string} q - Filter query string
     * @returns {Object} Prisma where object
     */
    filter(q) {
        if (typeof q !== 'string' || q.trim() === '') {
            return {};
        }

        const result = {};
        const filterParts = q.split(FILTER_PATTERNS.FILTER_SPLIT);

        for (const part of filterParts) {
            // Split only on first '=' to handle values containing '='
            const eqIndex = part.indexOf('=');
            if (eqIndex === -1) continue; // Skip invalid filter parts without '='
            const key = part.substring(0, eqIndex);
            const value = part.substring(eqIndex + 1);
            const relationPath = key.split('.').map(e => e.trim());
            const fieldName = relationPath.pop();
            const trimmedValue = value?.trim() ?? null;

            // Validate field exists on model (for non-relation filters)
            if (relationPath.length === 0 && !this.fields[fieldName]) {
                throw new ErrorResponse(400, "invalid_filter_field", {field: fieldName});
            }

            // Navigate to the correct filter context for nested relations
            const filterContext = this.#navigateToFilterContext(result, relationPath);

            // Apply the filter value
            this.#applyFilterValue(filterContext, fieldName, trimmedValue);
        }

        return result;
    }

    /**
     * Navigate through relation path and return the filter context object
     * @param {Object} rootFilter - Root filter object
     * @param {string[]} relationPath - Array of relation names
     * @returns {Object} The nested filter context to apply conditions to
     * @private
     */
    #navigateToFilterContext(rootFilter, relationPath) {
        let filter = rootFilter;
        let currentRelations = this.relatedObjects;

        for (const relationName of relationPath) {
            // Find the relation in current context
            const rel = Array.isArray(currentRelations)
                ? currentRelations.find(r => r.name === relationName)
                : currentRelations?.relation?.find(r => r.name === relationName);

            if (!rel) {
                throw new ErrorResponse(400, "relation_not_exist", {
                    relation: relationName,
                    modelName: this.name
                });
            }

            // Create or navigate to the relation filter
            if (!filter[rel.name]) {
                const parentModelName = Array.isArray(currentRelations) ? this.name : currentRelations.object;
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

            currentRelations = rel;
        }

        return filter;
    }

    /**
     * Apply a filter value to a field in the filter context
     * @param {Object} filter - Filter context object
     * @param {string} fieldName - Field name to filter
     * @param {string|null} value - Filter value
     * @private
     */
    #applyFilterValue(filter, fieldName, value) {
        // Handle null values
        if (value === '#NULL') {
            filter[fieldName] = null;
            return;
        }
        if (value === 'not:#NULL') {
            filter[fieldName] = { not: null };
            return;
        }

        // Handle not: prefix (negation)
        if (value?.startsWith('not:')) {
            this.#applyNegatedFilter(filter, fieldName, value.substring(4));
            return;
        }

        // Handle empty/null value
        if (!value) {
            filter[fieldName] = null;
            return;
        }

        // Try to apply typed filter (date, number, array, string)
        this.#applyTypedFilter(filter, fieldName, value);
    }

    /**
     * Apply a negated filter (not:value)
     * @param {Object} filter - Filter context
     * @param {string} fieldName - Field name
     * @param {string} value - Value after not: prefix
     * @private
     */
    #applyNegatedFilter(filter, fieldName, value) {
        // not:#NULL
        if (value === '#NULL') {
            filter[fieldName] = { not: null };
            return;
        }

        // not:[array]
        if (value.startsWith('[') && value.endsWith(']')) {
            const arr = this.#parseArrayValue(value);
            if (arr.some(v => typeof v === 'string' && v.includes('%'))) {
                filter.NOT = arr.map(v => ({ [fieldName]: this.#filterString(v) }));
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
     * @param {Object} filter - Filter context
     * @param {string} fieldName - Field name
     * @param {string} rangeValue - Range value (start;end)
     * @private
     */
    #applyNotBetween(filter, fieldName, rangeValue) {
        const [start, end] = rangeValue.split(';').map(v => v.trim());

        if (!start || !end) {
            throw new ErrorResponse(400, "between_requires_two_values");
        }

        const isNumeric = FILTER_PATTERNS.PURE_NUMBER.test(start) && FILTER_PATTERNS.PURE_NUMBER.test(end);

        if (isNumeric) {
            filter.NOT = (filter.NOT || []).concat([{
                AND: [
                    { [fieldName]: { gte: parseFloat(start) } },
                    { [fieldName]: { lte: parseFloat(end) } }
                ]
            }]);
        } else {
            const startDate = new Date(start);
            const endDate = new Date(end);
            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                throw new ErrorResponse(400, "invalid_date_range", {start, end});
            }
            filter.NOT = (filter.NOT || []).concat([{
                AND: [
                    { [fieldName]: { gte: startDate } },
                    { [fieldName]: { lte: endDate } }
                ]
            }]);
        }
    }

    /**
     * Apply typed filter (auto-detect type: date, number, array, string)
     * @param {Object} filter - Filter context
     * @param {string} fieldName - Field name
     * @param {string} value - Filter value
     * @private
     */
    #applyTypedFilter(filter, fieldName, value) {
        // Check for date patterns first
        const hasDateOperator = FILTER_PATTERNS.DATE_OPS.some(op => value.startsWith(op));
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
            if (!isNaN(value)) {
                filter[fieldName] = { equals: Number(value) };
                return;
            }
        }

        // Array filter
        if (value.startsWith('[') && value.endsWith(']')) {
            const arr = this.#parseArrayValue(value);
            if (arr.some(v => typeof v === 'string' && v.includes('%'))) {
                if (!filter.OR) filter.OR = [];
                arr.forEach(v => filter.OR.push({ [fieldName]: this.#filterString(v) }));
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
     * @param {string} value - Value to check
     * @returns {boolean}
     * @private
     */
    #looksLikeNumber(value) {
        return !isNaN(value) || FILTER_PATTERNS.NUMERIC_OPS.some(op => value.startsWith(op));
    }

    /**
     * Check if between: value contains dates
     * @param {string} value - Full between: value
     * @returns {boolean}
     * @private
     */
    #looksLikeDateRange(value) {
        const rangeValue = value.substring(8); // Remove 'between:'
        return (value.includes('-') && value.includes('T')) ||
            rangeValue.split(';').some(part => FILTER_PATTERNS.ISO_DATE.test(part.trim()));
    }

    /**
     * Parse array value from string
     * @param {string} value - Array string like "[1,2,3]"
     * @returns {Array}
     * @private
     */
    #parseArrayValue(value) {
        try {
            return JSON.parse(value);
        } catch {
            return value.slice(1, -1).split(',').map(v => v.trim());
        }
    }

    /**
     * Parse numeric filter operators
     * @param {string} value - Filter value with operator
     * @returns {Object|null} Prisma numeric filter or null
     */
    #filterNumber(value) {
        const numOperators = ['lt:', 'lte:', 'gt:', 'gte:', 'eq:', 'ne:', 'between:'];
        const foundOperator = numOperators.find(op => value.startsWith(op));
        let numValue = value;
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
                    const [start, end] = numValue.split(';').map(v => parseFloat(v.trim()));
                    if (isNaN(start) || isNaN(end)) return null;
                    return { gte: start, lte: end };
                }
            }
        }

        // Support decimal numbers
        numValue = parseFloat(numValue);
        if (isNaN(numValue)) return null;

        return { [prismaOp]: numValue };
    }

    /**
     * Parse date/datetime filter operators
     * @param {string} value - Filter value with date operator
     * @returns {Object|null} Prisma date filter or null
     */
    #filterDateTime(value) {
        const foundOperator = FILTER_PATTERNS.DATE_OPS.find(op => value.startsWith(op));
        if (!foundOperator) {
            return null;
        }

        const operatorValue = value.substring(foundOperator.length);

        try {
            // Map operators to Prisma comparison operators
            const simpleOperatorMap = {
                'before:': 'lt',
                'after:': 'gt',
                'from:': 'gte',
                'to:': 'lte'
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
                    lt: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)
                };
            }

            // Handle 'between:'
            if (foundOperator === 'between:') {
                const [start, end] = operatorValue.split(';').map(d => d.trim());
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
        } catch (error) {
            if (error instanceof ErrorResponse) throw error;
            throw new ErrorResponse(400, "invalid_date_format", {value, error: error.message});
        }
    }

    /**
     * Parse a date string and validate it
     * @param {string} dateStr - Date string to parse
     * @returns {Date} Parsed date
     * @throws {Error} If date is invalid
     * @private
     */
    #parseDate(dateStr) {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) {
            throw new Error(`Invalid date: ${dateStr}`);
        }
        return date;
    }

    /**
     * Parse string filters with wildcard support and URL decoding
     * @param {string} value - String filter value
     * @returns {Object|boolean} Prisma string filter or boolean value
     */
    #filterString(value) {
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
     * Build base include content with omit fields and ACL filter
     * @param {Object} relation - Relation configuration
     * @param {Object} user - User object with role
     * @param {string} parentModel - Parent model name
     * @returns {{content: Object|true, hasContent: boolean}} Include content and whether it has properties
     * @private
     */
    #buildBaseIncludeContent(relation, user, parentModel) {
        const content = {};
        let hasContent = false;

        // Add omit fields for this relation if available
        const omitFields = this.getRelatedOmit(relation.object, user);
        if (Object.keys(omitFields).length > 0) {
            content.omit = omitFields;
            hasContent = true;
        }

        // Apply ACL access filter (only for list relations - Prisma restriction)
        const isListRelation = this.#isListRelation(parentModel, relation.name);
        if (isListRelation && relation.object && acl.model[relation.object]?.getAccessFilter) {
            const accessFilter = acl.model[relation.object].getAccessFilter(user);
            const cleanedFilter = this.cleanFilter(accessFilter);
            const simplifiedFilter = this.#simplifyNestedFilter(cleanedFilter, parentModel);
            if (simplifiedFilter && typeof simplifiedFilter === 'object' && Object.keys(simplifiedFilter).length > 0) {
                content.where = simplifiedFilter;
                hasContent = true;
            }
        }

        return { content, hasContent };
    }

    /**
     * Check if include content has meaningful properties
     * @param {Object} content - Include content object
     * @returns {boolean}
     * @private
     */
    #hasIncludeContent(content) {
        return content.omit || content.where ||
            (content.include && Object.keys(content.include).length > 0);
    }

    /**
     * Get relationships configuration for a specific model
     * @param {string} modelName - The model name
     * @returns {Array} Array of relationship configurations for the model
     */
    #getRelationshipsForModel(modelName) {
        return modelName ? dmmf.buildRelationships(modelName) : [];
    }

    /**
     * Build top-level only relationship include (no deep relations)
     * @param {Object} relation - Relation configuration
     * @param {Object} user - User object with role
     * @param {string} [parentModel] - Parent model name that owns this relation
     * @returns {Object|true} Prisma include/select object for top-level only
     */
    #includeTopLevelOnly(relation, user, parentModel = null) {
        const currentParent = parentModel || this.name;
        const { content, hasContent } = this.#buildBaseIncludeContent(relation, user, currentParent);
        return hasContent ? content : true;
    }

    /**
     * Build selective deep relationship include based on dot notation paths
     * @param {Object} relation - Relation configuration
     * @param {Object} user - User object with role
     * @param {string[]} deepPaths - Array of deep paths (e.g., ['agency', 'courses.subject'])
     * @param {string} [parentModel] - Parent model name that owns this relation
     * @returns {Object|true} Prisma include/select object with selective deep relations
     */
    #includeSelectiveDeepRelationships(relation, user, deepPaths, parentModel = null) {
        const currentParent = parentModel || this.name;
        const { content } = this.#buildBaseIncludeContent(relation, user, currentParent);
        content.include = {};

        // Process deep paths if any
        if (deepPaths?.length > 0) {
            // Group paths by first-level relation
            const pathsByRelation = this.#groupPathsByFirstLevel(deepPaths);
            const childRelationships = this.#getRelationshipsForModel(relation.object);

            for (const [relationName, paths] of Object.entries(pathsByRelation)) {
                const childRelation = childRelationships.find(r => r.name === relationName);
                if (!childRelation) continue;

                const childPaths = paths.filter(p => p !== '');
                content.include[relationName] = childPaths.length > 0
                    ? this.#includeSelectiveDeepRelationships(childRelation, user, childPaths, relation.object)
                    : this.#includeTopLevelOnly(childRelation, user, relation.object);
            }
        }

        return this.#hasIncludeContent(content) ? content : true;
    }

    /**
     * Group dot-notation paths by their first level
     * @param {string[]} paths - Array of paths like ['agency', 'courses.subject']
     * @returns {Object<string, string[]>} Paths grouped by first level
     * @private
     */
    #groupPathsByFirstLevel(paths) {
        const grouped = {};
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
     * @param {string|Object} include - Include specification
     * @param {Object} user - User object with role
     * @returns {Object} Prisma include object
     */
    include(include = "ALL", user) {
        let include_query = typeof include === 'string' ? include : typeof include === 'object' ? include.query : null;
        let exclude_rule = typeof include === 'object' ? include.rule : null;
        if (include_query) {
            let includeRelated = {};

            if (include_query === "ALL") {
                // Load all first-level relationships only (no deep nesting to avoid endless relation loading)
                includeRelated = this.relatedObjects.reduce((acc, curr) => {
                    let rel = this.#includeTopLevelOnly(curr, user);
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
                const includeList = include_query.split(',').map(item => item.trim());
                const topLevelIncludes = new Set();
                const deepIncludes = {};

                // Separate top-level and deep includes
                includeList.forEach(item => {
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
                this.relatedObjects.forEach(curr => {
                    if (topLevelIncludes.has(curr.name)) {
                        let rel;

                        if (deepIncludes[curr.name]) {
                            // Build selective deep relationships
                            rel = this.#includeSelectiveDeepRelationships(curr, user, deepIncludes[curr.name]);
                        } else {
                            // Only include top-level (no deep relationships)
                            rel = this.#includeTopLevelOnly(curr, user);
                        }

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
     * @param {Object} user - User object with role
     * @param {Array|null} inaccessible_fields - Override fields to omit
     * @returns {Object} Prisma omit object
     */
    omit(user, inaccessible_fields = null) {
        // Get omit fields from ACL if available
        let omit_fields = inaccessible_fields;

        if (!omit_fields && acl.model[this.name]?.getOmitFields) {
            omit_fields = acl.model[this.name].getOmitFields(user);
        }

        if (omit_fields && Array.isArray(omit_fields)) {
            return omit_fields.reduce((acc, curr) => {
                acc[curr] = true;
                return acc;
            }, {});
        }
        return {};
    }

    /**
     * Get omit fields for a related object based on user role
     * @param {string} relatedModelName - The related model name
     * @param {Object} user - User object with role
     * @returns {Object} Prisma omit object for the related model
     */
    getRelatedOmit(relatedModelName, user) {
        if (acl.model[relatedModelName]?.getOmitFields) {
            const omit_fields = acl.model[relatedModelName].getOmitFields(user);
            if (omit_fields && Array.isArray(omit_fields)) {
                return omit_fields.reduce((acc, curr) => {
                    acc[curr] = true;
                    return acc;
                }, {});
            }
        }
        return {};
    }

    /**
     * Validate and limit result count
     * @param {number} limit - Requested limit
     * @returns {number} Validated limit within API constraints
     */
    take(limit) {
        if (!Number.isInteger(limit) || limit <= 0) {
            throw new ErrorResponse(400, "invalid_limit");
        }
        return limit > QueryBuilder.API_RESULT_LIMIT ? QueryBuilder.API_RESULT_LIMIT : limit;
    }

    /**
     * Build sort object for ordering results
     * @param {string} sortBy - Field to sort by (supports dot notation)
     * @param {string} sortOrder - 'asc' or 'desc'
     * @returns {Object} Prisma orderBy object
     */
    sort(sortBy, sortOrder) {
        if (typeof sortBy !== 'string') {
            throw new ErrorResponse(400, "sortby_must_be_string", {type: typeof sortBy});
        }
        if (typeof sortOrder !== 'string' || (sortOrder != 'desc' && sortOrder != 'asc')) {
            throw new ErrorResponse(400, "sortorder_invalid", {value: sortOrder});
        }
        const relation_chain = sortBy.split('.').map(e => e.trim());
        const field_name = relation_chain.pop();

        const sort = {};
        let curr = sort;
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
     * @param {Object} data - Data to create (mutated in place)
     * @param {Object} [user=null] - User object for audit fields
     */
    create(data, user = null) {
        // Remove fields user shouldn't be able to set
        const modelAcl = acl.model[this.name];
        const omitFields = user && modelAcl?.getOmitFields
            ? modelAcl.getOmitFields(user)
            : [];
        for (const field of omitFields) {
            delete data[field];
        }

        for (const key of Object.keys(data)) {
            const field = this.fields[key];
            const isRelationField = field?.kind === 'object';

            // Handle relation fields or unknown keys
            if (field == null || isRelationField) {
                this.#processCreateRelation(data, key, user);
            } else {
                // Check if this scalar field is a FK that should become a connect
                this.#processCreateForeignKey(data, key, user);
            }
        }
    }

    /**
     * Process a relation field for create operation
     * @param {Object} data - Parent data object
     * @param {string} key - Relation field name
     * @param {Object} [user=null] - User object for ACL
     * @private
     */
    #processCreateRelation(data, key, user = null) {
        const relatedObject = this.relatedObjects.find(e => e.name === key);
        if (!relatedObject) {
            throw new ErrorResponse(400, "unexpected_key", {key});
        }

        if (!data[key]) return;

        if (Array.isArray(data[key])) {
            data[key] = this.#processCreateArrayRelation(data[key], relatedObject, key, user);
        } else {
            data[key] = this.#processCreateSingleRelation(data[key], relatedObject, key, user);
        }
    }

    /**
     * Process array relation for create operation
     * @param {Array} items - Array of relation items
     * @param {Object} relatedObject - Relation configuration
     * @param {string} relationName - Name of the relation
     * @param {Object} [user=null] - User object for ACL
     * @returns {Object} Prisma create/connect structure
     * @private
     */
    #processCreateArrayRelation(items, relatedObject, relationName, user = null) {
        for (let i = 0; i < items.length; i++) {
            this.#validateAndTransformRelationItem(items[i], relatedObject, relationName);
        }

        const relatedPrimaryKey = this.getPrimaryKey(relatedObject.object);
        const pkFields = Array.isArray(relatedPrimaryKey) ? relatedPrimaryKey : [relatedPrimaryKey];
        const foreignKey = relatedObject.foreignKey || pkFields[0];

        // For composite keys, check if ALL PK fields are present
        const hasCompletePK = (item) => pkFields.every(field => item[field] != null);

        const createItems = items.filter(e => !hasCompletePK(e));
        const connectItems = items.filter(e => hasCompletePK(e));

        // Get ACL for the related model
        const relatedAcl = acl.model[relatedObject.object];
        const accessFilter = user && relatedAcl?.getAccessFilter
            ? this.cleanFilter(relatedAcl.getAccessFilter(user))
            : null;

        // Get omit fields for nested creates
        const omitFields = user && relatedAcl?.getOmitFields
            ? relatedAcl.getOmitFields(user)
            : [];

        const result = {};

        if (createItems.length > 0) {
            // Check canCreate permission for nested creates
            if (user && relatedAcl?.canCreate && !relatedAcl.canCreate(user)) {
                throw new ErrorResponse(403, "no_permission_to_create", { model: relatedObject.object });
            }

            // Remove omitted fields from create items
            result.create = createItems.map(item => {
                const cleanedItem = { ...item };
                for (const field of omitFields) {
                    delete cleanedItem[field];
                }
                return cleanedItem;
            });
        }

        if (connectItems.length > 0) {
            if (pkFields.length > 1) {
                // Composite key - build composite where clause with ACL
                result.connect = connectItems.map(e => {
                    const where = {};
                    pkFields.forEach(field => { where[field] = e[field]; });
                    // Apply ACL access filter
                    if (accessFilter && typeof accessFilter === 'object' && Object.keys(accessFilter).length > 0) {
                        Object.assign(where, accessFilter);
                    }
                    return where;
                });
            } else {
                // Simple key with ACL
                result.connect = connectItems.map(e => {
                    const where = { [foreignKey]: e[foreignKey] || e[pkFields[0]] };
                    // Apply ACL access filter
                    if (accessFilter && typeof accessFilter === 'object' && Object.keys(accessFilter).length > 0) {
                        Object.assign(where, accessFilter);
                    }
                    return where;
                });
            }
        }

        return result;
    }

    /**
     * Process single relation for create operation
     * @param {Object} item - Relation data
     * @param {Object} relatedObject - Relation configuration
     * @param {string} relationName - Name of the relation
     * @param {Object} [user=null] - User object for ACL
     * @returns {Object} Prisma create structure
     * @private
     */
    #processCreateSingleRelation(item, relatedObject, relationName, user = null) {
        // Get ACL for the related model
        const relatedAcl = acl.model[relatedObject.object];

        // Check canCreate permission
        if (user && relatedAcl?.canCreate && !relatedAcl.canCreate(user)) {
            throw new ErrorResponse(403, "no_permission_to_create", { model: relatedObject.object });
        }

        // Get and apply omit fields
        const omitFields = user && relatedAcl?.getOmitFields
            ? relatedAcl.getOmitFields(user)
            : [];
        for (const field of omitFields) {
            delete item[field];
        }

        for (const fieldKey of Object.keys(item)) {
            if (!this.#fieldExistsOnModel(relatedObject.object, fieldKey)) {
                throw new ErrorResponse(400, "unexpected_key", {key: `${relationName}.${fieldKey}`});
            }

            // Check if this field is a FK that should become a nested connect
            const childRelation = relatedObject?.relation?.find(e => e.field === fieldKey);
            if (childRelation && item[fieldKey]) {
                const targetPrimaryKey = childRelation.foreignKey || this.getPrimaryKey(childRelation.object);
                const connectWhere = {};

                // Handle composite primary keys
                if (Array.isArray(targetPrimaryKey)) {
                    // For composite PKs, the value should be an object with all key fields
                    if (typeof item[fieldKey] === 'object' && item[fieldKey] !== null) {
                        targetPrimaryKey.forEach(pk => {
                            if (item[fieldKey][pk] != null) {
                                connectWhere[pk] = item[fieldKey][pk];
                            }
                        });
                    } else {
                        // Single value for composite PK - use first field
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
            }
        }

        return { create: { ...item } };
    }

    /**
     * Validate relation item fields and transform nested FK references
     * @param {Object} item - Relation item to validate/transform
     * @param {Object} relatedObject - Relation configuration
     * @param {string} relationName - Parent relation name for error messages
     * @private
     */
    #validateAndTransformRelationItem(item, relatedObject, relationName) {
        for (const fieldKey of Object.keys(item)) {
            if (!this.#fieldExistsOnModel(relatedObject.object, fieldKey)) {
                throw new ErrorResponse(400, "unexpected_key", {key: `${relationName}.${fieldKey}`});
            }

            // Handle composite FK fields
            if (relatedObject.fields?.includes(fieldKey)) {
                const index = relatedObject.fields.findIndex(f => f === fieldKey);
                if (index > 0 && relatedObject.relation?.[index - 1]) {
                    const rel = relatedObject.relation[index - 1];
                    const relPrimaryKey = rel.foreignKey || this.getPrimaryKey(rel.object);
                    const restData = { ...item };
                    delete restData[fieldKey];

                    Object.assign(item, {
                        [rel.name]: { connect: { [relPrimaryKey]: item[fieldKey] } },
                        ...restData
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
     * @param {Object} data - Parent data object
     * @param {string} key - Field name
     * @param {Object} [user=null] - User object for ACL
     * @private
     */
    #processCreateForeignKey(data, key, user = null) {
        const relatedObject = this.relatedObjects.find(e => e.field === key);
        if (!relatedObject) return;

        if (data[key]) {
            const targetPrimaryKey = this.getPrimaryKey(relatedObject.object);
            const foreignKey = relatedObject.foreignKey || (Array.isArray(targetPrimaryKey) ? targetPrimaryKey[0] : targetPrimaryKey);
            // Build connect where clause
            const connectWhere = { [foreignKey]: data[key] };

            // Apply ACL access filter for connect
            const relatedAcl = acl.model[relatedObject.object];
            const accessFilter = user && relatedAcl?.getAccessFilter
                ? this.cleanFilter(relatedAcl.getAccessFilter(user))
                : null;
            if (accessFilter && typeof accessFilter === 'object' && Object.keys(accessFilter).length > 0) {
                Object.assign(connectWhere, accessFilter);
            }

            data[relatedObject.name] = { connect: connectWhere };
        }
        delete data[key];
    }

    /**
     * Process data for update operation with nested relation support
     * Transforms nested relation data into Prisma update/upsert/connect/disconnect syntax
     * @param {string|number} id - ID of record to update
     * @param {Object} data - Data to update (mutated in place)
     * @param {Object} [user=null] - User object for ACL checks
     */
    update(id, data, user = null) {
        // Remove fields user shouldn't be able to modify
        const modelAcl = acl.model[this.name];
        const omitFields = user && modelAcl?.getOmitFields
            ? modelAcl.getOmitFields(user)
            : [];
        for (const field of omitFields) {
            delete data[field];
        }

        for (const key of Object.keys(data)) {
            const field = this.fields[key];
            const isRelationField = field?.kind === 'object';

            // Handle relation fields or unknown keys
            if (field == null || isRelationField) {
                this.#processUpdateRelation(data, key, id, user);
            } else {
                // Check if this scalar field is a FK that should become a connect/disconnect
                this.#processUpdateForeignKey(data, key, user);
            }
        }
    }

    /**
     * Process a relation field for update operation
     * @param {Object} data - Parent data object
     * @param {string} key - Relation field name
     * @param {string|number} parentId - Parent record ID
     * @param {Object} user - User for ACL
     * @private
     */
    #processUpdateRelation(data, key, parentId, user) {
        const relatedObject = this.relatedObjects.find(e => e.name === key);
        if (!relatedObject) {
            throw new ErrorResponse(400, "unexpected_key", {key});
        }

        if (!data[key]) return;

        if (Array.isArray(data[key])) {
            data[key] = this.#processArrayRelation(data[key], relatedObject, parentId, user);
        } else {
            data[key] = this.#processSingleRelation(data[key], relatedObject, user);
        }
    }

    /**
     * Process a scalar field that might be a FK needing connect/disconnect transformation
     * @param {Object} data - Parent data object
     * @param {string} key - Field name
     * @param {Object} [user=null] - User object for ACL
     * @private
     */
    #processUpdateForeignKey(data, key, user = null) {
        const relatedObject = this.relatedObjects.find(e => e.field === key);
        if (!relatedObject) return;

        const targetPrimaryKey = this.getPrimaryKey(relatedObject.object);
        const foreignKey = relatedObject.foreignKey || (Array.isArray(targetPrimaryKey) ? targetPrimaryKey[0] : targetPrimaryKey);

        if (data[key] != null) {
            // Build connect where clause
            const connectWhere = { [foreignKey]: data[key] };

            // Apply ACL access filter for connect
            const relatedAcl = acl.model[relatedObject.object];
            const accessFilter = user && relatedAcl?.getAccessFilter
                ? this.cleanFilter(relatedAcl.getAccessFilter(user))
                : null;
            if (accessFilter && typeof accessFilter === 'object' && Object.keys(accessFilter).length > 0) {
                Object.assign(connectWhere, accessFilter);
            }

            data[relatedObject.name] = { connect: connectWhere };
        } else {
            data[relatedObject.name] = { disconnect: true };
        }
        delete data[key];
    }
    
    /**
     * Process array relations for update operations
     * @param {Array} dataArray - Array of relation data
     * @param {Object} relatedObject - Relation configuration
     * @param {number} parentId - Parent record ID
     * @param {Object} user - User object for ACL checks
     * @returns {Object} Prisma array relation operations
     */
    #processArrayRelation(dataArray, relatedObject, parentId, user = null) {
        for (let i = 0; i < dataArray.length; i++) {
            // Validate all fields exist on the related model
            for (let _key in dataArray[i]) {
                if (!this.#fieldExistsOnModel(relatedObject.object, _key)) {
                    throw new ErrorResponse(400, "unexpected_key", {key: `${relatedObject.name}.${_key}`});
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
        const removeOmitFields = (obj) => {
            const cleaned = { ...obj };
            for (const field of omitFields) {
                delete cleaned[field];
            }
            return cleaned;
        };

        // Helper to check if item has ALL PK fields
        const hasCompletePK = (item) => pkFields.every(field => item[field] != null);

        // Helper to check if item has ONLY the PK/FK fields (for connect)
        // For n:m relations (composite FK), checks if only the join table FK fields are present
        const hasOnlyPkFields = (item) => {
            const keys = Object.keys(item);

            // For n:m relations with composite FK (e.g., StudentCourse with studentId, courseId)
            if (Array.isArray(relatedObject.fields)) {
                // Check if all keys are part of the composite FK fields
                // e.g., { courseId: 5 } should be connect, { courseId: 5, grade: 'A' } should be upsert
                return keys.every(k => relatedObject.fields.includes(k));
            }

            if (isCompositePK) {
                // For composite PK: all keys must be PK fields, and all PK fields must be present
                return keys.length === pkFields.length && keys.every(k => pkFields.includes(k));
            }
            // For simple: only 1 key which is FK or PK
            return keys.length === 1 && (keys[0] === foreignKey || keys[0] === pkFields[0]);
        };

        // Helper to merge ACL filter into where clause
        const mergeAclFilter = (where, aclFilter) => {
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
        const connectItems = [];
        const upsertItems = [];
        const createItems = [];

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

        // Check canCreate permission once for items that may create records
        const canCreate = !user || !relatedAcl?.canCreate || relatedAcl.canCreate(user);

        // If user can't create and has items without PK, throw error
        if (!canCreate && createItems.length > 0) {
            throw new ErrorResponse(403, "no_permission_to_create", { model: relatedObject.object });
        }

        const result = {};

        // Build connect array with ACL access filter
        if (connectItems.length > 0) {
            result.connect = connectItems.map(e => {
                const where = {};
                if (Array.isArray(relatedObject.fields)) {
                    // n:m relation - build composite key where clause
                    // e.g., { studentId_courseId: { studentId: parentId, courseId: e.courseId } }
                    const pair_id = {};
                    pair_id[relatedObject.fields[0]] = parentId;
                    for (let field in e) {
                        if (relatedObject.fields.includes(field)) {
                            pair_id[field] = e[field];
                        }
                    }
                    where[relatedObject.field] = pair_id;
                } else if (isCompositePK) {
                    pkFields.forEach(field => { where[field] = e[field]; });
                } else {
                    where[foreignKey] = e[foreignKey] || e[pkFields[0]];
                }
                // Apply access filter - user must have access to connect to this record
                return mergeAclFilter(where, accessFilter);
            });
        }

        // Build upsert or update array based on canCreate permission
        if (upsertItems.length > 0) {
            const buildWhereClause = (e) => {
                const where = {};
                if (Array.isArray(relatedObject.fields)) {
                    // Composite key relation (n:m via join table)
                    const pair_id = {};
                    pair_id[relatedObject.fields[0]] = parentId;
                    for (let field in e) {
                        if (relatedObject.fields.includes(field)) {
                            pair_id[field] = e[field];
                        }
                    }
                    where[relatedObject.field] = pair_id;
                } else if (isCompositePK) {
                    // Composite PK - all fields must be present
                    pkFields.forEach(field => { where[field] = e[field]; });
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
                result.upsert = upsertItems.map(e => {
                    const cleanedData = removeOmitFields(e);
                    return {
                        'where': buildWhereClause(e),
                        'create': cleanedData,
                        'update': cleanedData
                    };
                });
            } else {
                // User cannot create - use update only (fails if record doesn't exist)
                result.update = upsertItems.map(e => {
                    const cleanedData = removeOmitFields(e);
                    return {
                        'where': buildWhereClause(e),
                        'data': cleanedData
                    };
                });
            }
        }

        // Build create array for items without PK (only if canCreate is true)
        if (createItems.length > 0 && canCreate) {
            result.create = createItems.map(e => removeOmitFields(e));
        }

        return result;
    }

    /**
     * Process single relation for update operations with create/update separation
     * @param {Object} dataObj - Relation data object
     * @param {Object} relatedObject - Relation configuration
     * @param {Object} user - User object for ACL checks
     * @returns {Object|null} Prisma upsert operation or null
     */
    #processSingleRelation(dataObj, relatedObject, user = null) {
        // Get ACL for the related model
        const relatedAcl = acl.model[relatedObject.object];

        // Check canCreate permission since upsert may create new records
        if (user && relatedAcl?.canCreate && !relatedAcl.canCreate(user)) {
            throw new ErrorResponse(403, "no_permission_to_create", { model: relatedObject.object });
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
        for (let _key in dataObj) {
            if (!this.#fieldExistsOnModel(relatedObject.object, _key)) {
                throw new ErrorResponse(400, "unexpected_key", {key: `${relatedObject.name}.${_key}`});
            }
        }

        // Process nested relations recursively if they exist
        let processedData = dataObj;
        if (relatedObject.relation) {
            processedData = this.#processNestedRelations(dataObj, relatedObject.relation, user);
        }

        // Prepare separate data objects for create and update
        let createData = {...processedData};
        let updateData = {...processedData};
        let hasDisconnects = false;

        // Process direct relations
        if (relatedObject.relation) {
            for (let relation_key in processedData) {
                const rel = relatedObject.relation.find(e => e.field === relation_key);
                if (rel) {
                    if (processedData[relation_key] != null) {
                        // Build connect where clause
                        const targetPK = this.getPrimaryKey(rel.object);
                        const connectKey = rel.foreignKey || (Array.isArray(targetPK) ? targetPK[0] : targetPK);
                        const connectWhere = {
                            [connectKey]: processedData[relation_key]
                        };

                        // Apply ACL access filter for connect
                        const childAcl = acl.model[rel.object];
                        const accessFilter = user && childAcl?.getAccessFilter
                            ? this.cleanFilter(childAcl.getAccessFilter(user))
                            : null;
                        if (accessFilter && typeof accessFilter === 'object' && Object.keys(accessFilter).length > 0) {
                            Object.assign(connectWhere, accessFilter);
                        }

                        const connectObj = { 'connect': connectWhere };
                        createData[rel.name] = connectObj;
                        updateData[rel.name] = connectObj;
                    } else {
                        // For update, use disconnect when value is null
                        updateData[rel.name] = {
                            'disconnect': true
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
        const upsertObj = {};

        if (hasCreateContent) {
            upsertObj.create = {
                ...createData
            };
        }

        if (hasUpdateContent) {
            upsertObj.update = {
                ...updateData
            };
        }

        // Only return upsert if we have at least one operation
        return Object.keys(upsertObj).length > 0 ? { 'upsert': upsertObj } : null;
    }
    
    /**
     * Recursively process nested relations in data objects
     * @param {Object} dataObj - Data object to process
     * @param {Array} relatedObjects - Array of relation configurations
     * @param {Object} user - User object for ACL checks
     * @returns {Object} Processed data object
     */
    #processNestedRelations(dataObj, relatedObjects, user = null) {
        const processedData = {...dataObj};

        for (let key in processedData) {
            const nestedRelation = relatedObjects.find(rel => rel.name === key);

            if (nestedRelation && processedData[key] && typeof processedData[key] === 'object') {
                if (Array.isArray(processedData[key])) {
                    // Process nested array relation recursively
                    processedData[key] = this.#processArrayRelation(processedData[key], nestedRelation, null, user);
                } else {
                    // Process nested single relation recursively
                    const nestedResult = this.#processSingleRelation(processedData[key], nestedRelation, user);
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
     * @param {Object} dataObj - Data object to check
     * @returns {boolean} True if object has meaningful content
     */
    #hasMeaningfulContent(dataObj) {
        return Object.keys(dataObj).length > 0 && 
            Object.keys(dataObj).some(key => {
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
     * @param {Object|any} filter - Filter object to clean
     * @returns {Object|null} Cleaned filter or null if empty
     */
    cleanFilter(filter) {
        if (!filter || typeof filter !== 'object') {
            return filter === undefined ? null : filter;
        }

        if (Array.isArray(filter)) {
            const cleaned = filter.map(item => this.cleanFilter(item)).filter(item => item !== null && item !== undefined);
            return cleaned.length > 0 ? cleaned : null;
        }

        const cleaned = {};
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
     * @param {string} parentModel - The parent model name
     * @param {string} relationName - The relation field name
     * @returns {boolean} True if the relation is a list (array) relation
     */
    #isListRelation(parentModel, relationName) {
        return dmmf.isListRelation(parentModel, relationName);
    }

    /**
     * Simplify nested filter by removing parent relation filters
     * When including appointments from student_tariff, remove {student_tariff: {...}} filters
     * @param {Object|any} filter - Filter object to simplify
     * @param {string} parentModel - Parent model name
     * @returns {Object|null} Simplified filter
     */
    #simplifyNestedFilter(filter, parentModel) {
        if (!filter || typeof filter !== 'object') {
            return filter;
        }

        if (Array.isArray(filter)) {
            const simplified = filter.map(item => this.#simplifyNestedFilter(item, parentModel)).filter(item => item !== null);
            return simplified.length > 0 ? simplified : null;
        }

        const simplified = {};
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
     * @returns {number} Maximum API result limit
     */
    static get API_RESULT_LIMIT() {
        return API_RESULT_LIMIT;
    }
}

/**
 * Prisma error code mappings
 * Maps Prisma error codes to HTTP status codes and user-friendly messages
 */
const PRISMA_ERROR_MAP = {
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
    P2034: { status: 409, message: 'Transaction failed due to write conflict or deadlock' }
};

/**
 * Handle Prisma errors and convert to standardized error responses
 * @param {Error|string} error - Error object or message
 * @param {Object} [data={}] - Additional data context for error messages
 * @returns {{status_code: number, message: string}} Standardized error response
 */
QueryBuilder.errorHandler = (error, data = {}) => {
    console.error(error);

    // Default values
    let statusCode = error.status_code || 500;
    let message = error instanceof ErrorResponse
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
            message = `Duplicate entry for ${modelName}. Record with ${target}: '${data[target]}' already exists`;
        } else {
            message = errorInfo.message;
        }
    }

    return { status_code: statusCode, message };
};

module.exports = {QueryBuilder, prisma, prismaTransaction};