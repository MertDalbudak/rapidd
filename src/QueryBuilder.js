const {prisma, prismaTransaction, Prisma, acl} = require('../rapidd/rapidd');
const { ErrorResponse } = require('./Api');
const path = require('path');
const fs = require('fs');

const API_RESULT_LIMIT = parseInt(process.env.API_RESULT_LIMIT, 10) || 500;

class QueryBuilder {
    /**
     * Initialize QueryBuilder with model name and configuration
     * @param {string} name - The model name
     */
    constructor(name) {
        this.name = name;
        this.prismaName = name.toLowerCase();
        this.fields = prisma[this.prismaName].fields;
        this._relationshipsCache = null;
    }

    /**
     * Load relationships from relationships.json file
     * @returns {Object} Relationships configuration for this model
     */
    get relatedObjects() {
        if (this._relationshipsCache) {
            return this._relationshipsCache;
        }

        try {
            const relationshipsPath = path.resolve(__dirname, '../rapidd/relationships.json');
            const relationships = JSON.parse(fs.readFileSync(relationshipsPath, 'utf8'));
            const modelRelationships = relationships[this.name] || {};

            // Convert to array format expected by existing code
            this._relationshipsCache = Object.entries(modelRelationships).map(([name, config]) => ({
                name,
                ...config
            }));

            return this._relationshipsCache;
        } catch (error) {
            console.error(`Failed to load relationships for ${this.name}:`, error);
            return [];
        }
    }

    /**
     * Get primary key field(s) for a given model
     * @param {string} modelName - The model name
     * @returns {string|Array} Primary key field name or array of field names for composite keys
     */
    getPrimaryKey(modelName) {
        const model = Prisma.dmmf.datamodel.models.find(m => m.name === modelName.toLowerCase());
        if (!model) {
            // Fallback to 'id' if model not found
            return 'id';
        }

        // Check for composite primary key
        if (model.primaryKey && model.primaryKey.fields && model.primaryKey.fields.length > 0) {
            return model.primaryKey.fields.length === 1 ? model.primaryKey.fields[0] : model.primaryKey.fields;
        }

        // Check for single primary key field
        const idField = model.fields.find(f => f.isId);
        if (idField) {
            return idField.name;
        }

        // Default fallback
        return 'id';
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
        if (typeof q === 'string') {
            return q.split(/,(?![^\[]*\])/).reduce((acc, curr) => {
                const [key, value] = curr.split('=');
                const relation = key.split('.').map(e => e.trim());
                const trimmedKey = relation.pop();
                const trimmedValue = value ? value.trim() : null;

                if (relation.length === 0 && !this.fields[trimmedKey]) {
                    throw new ErrorResponse(400, "invalid_filter_field", {field: trimmedKey});
                }

                let filter = acc;
                const relationPrisma = relation.reduce((_acc, _curr) => {
                    let rel;
                    if (Array.isArray(_acc)) {
                        rel = _acc.find(rel => rel.name === _curr);
                        if (!rel) {
                            throw new ErrorResponse(400, "relation_not_exist", {relation: _curr, modelName: Array.isArray(_acc) ? this.name : _acc.name});
                        }
                    } else {
                        rel = _acc?.relation?.find(rel => rel.name === _curr);
                    }
                    if (!filter[rel.name]) {
                        if (!rel.field || (!prisma[rel.object].fields[rel.field] && (Array.isArray(_acc) ? this.fields[rel.field] : prisma[_acc.object].fields[rel.field]))) {
                            filter[rel.name] = {};
                            filter = filter[rel.name];
                        } else {
                            const listSearch = {
                                'some': {}
                            };
                            filter[rel.name] = listSearch;
                            filter = listSearch['some'];
                        }
                    } else {
                        if (filter[rel.name]['some']) {
                            filter = filter[rel.name]['some'];
                        } else {
                            filter = filter[rel.name];
                        }
                    }

                    return rel;
                }, this.relatedObjects);

                // #NULL and not:#NULL handling
                if (trimmedValue === '#NULL') {
                    filter[trimmedKey] = null;
                    return acc;
                }
                if (trimmedValue === 'not:#NULL') {
                    filter[trimmedKey] = { not: null };
                    return acc;
                }

                // Universal not: operator for all types
                if (trimmedValue && trimmedValue.startsWith('not:')) {
                    const negValue = trimmedValue.substring(4);

                    // not:#NULL (is not null)
                    if (negValue === '#NULL') {
                        filter[trimmedKey] = { not: null };
                        return acc;
                    }

                    // Array exclusion with wildcards
                    if (negValue.startsWith('[') && negValue.endsWith(']')) {
                        let arr;
                        try {
                            arr = JSON.parse(negValue);
                        } catch {
                            arr = negValue.slice(1, -1).split(',').map(v => v.trim());
                        }
                        // If any value contains %, treat as string filter
                        if (arr.some(v => typeof v === 'string' && v.includes('%'))) {
                            // Build NOT array for Prisma
                            filter.NOT = arr.map(v => ({
                                [trimmedKey]: this.#filterString(v)
                            }));
                        } else {
                            filter[trimmedKey] = { notIn: arr };
                        }
                        return acc;
                    }

                    // Special handling for between: with dates/numbers
                    if (negValue.startsWith('between:')) {
                        const operatorValue = negValue.substring('between:'.length);
                        const [start, end] = operatorValue.split(';').map(v => v.trim());

                        if (!start || !end) {
                            throw new ErrorResponse(400, "between_requires_two_values");
                        }

                        // Check if values are pure numbers
                        const isStartNumber = /^-?\d+(\.\d+)?$/.test(start);
                        const isEndNumber = /^-?\d+(\.\d+)?$/.test(end);

                        if (isStartNumber && isEndNumber) {
                            // Handle numeric not:between: - exclude values between start and end
                            const startNum = parseFloat(start);
                            const endNum = parseFloat(end);
                            // Add NOT condition with AND logic (exclude range)
                            filter.NOT = (filter.NOT || []).concat([{
                                AND: [
                                    { [trimmedKey]: { gte: startNum } },
                                    { [trimmedKey]: { lte: endNum } }
                                ]
                            }]);
                        } else {
                            // Handle date not:between: - exclude dates between start and end
                            const startDate = new Date(start);
                            const endDate = new Date(end);
                            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                                throw new ErrorResponse(400, "invalid_date_range", {start, end});
                            }
                            // Add NOT condition with AND logic (exclude range)
                            filter.NOT = (filter.NOT || []).concat([{
                                AND: [
                                    { [trimmedKey]: { gte: startDate } },
                                    { [trimmedKey]: { lte: endDate } }
                                ]
                            }]);
                        }
                        return acc;
                    }

                    // Date
                    const dateFilter = this.#filterDateTime(negValue);
                    if (dateFilter) {
                        filter[trimmedKey] = { not: dateFilter };
                        return acc;
                    }

                    // Number
                    if (!isNaN(negValue) || ['lt:', 'lte:', 'gt:', 'gte:', 'eq:', 'ne:'].some(op => negValue.startsWith(op))) {
                        const numFilter = this.#filterNumber(negValue);
                        if (numFilter) {
                            filter[trimmedKey] = { not: numFilter };
                        } else {
                            filter[trimmedKey] = { not: Number(negValue) };
                        }
                        return acc;
                    }

                    // String
                    filter[trimmedKey] = { not: this.#filterString(negValue) };
                    return acc;
                }

                if (!trimmedValue) {
                    filter[trimmedKey] = null;
                } else {
                    // Check for date patterns first (since between: can be both numeric and date)
                    const isoDateRegex = /^\d{4}-\d{2}-\d{2}(T.*)?$/;
                    const dateOperators = ['before:', 'after:', 'from:', 'to:', 'on:'];
                    const hasDateOperator = dateOperators.some(op => trimmedValue.startsWith(op));
                    const isBetweenWithDates = trimmedValue.startsWith('between:') &&
                        (trimmedValue.includes('-') && trimmedValue.includes('T') ||
                         trimmedValue.substring(8).split(';').some(part => part.trim().match(isoDateRegex)));

                    if (hasDateOperator || isBetweenWithDates || isoDateRegex.test(trimmedValue)) {
                        const dateFilter = this.#filterDateTime(trimmedValue);
                        if (dateFilter) {
                            filter[trimmedKey] = dateFilter;
                            return acc;
                        }
                    }

                    // Try numeric operators
                    if (!isNaN(trimmedValue) || ['lt:', 'lte:', 'gt:', 'gte:', 'eq:', 'ne:', 'between:'].some(op => trimmedValue.startsWith(op))) {
                        const numFilter = this.#filterNumber(trimmedValue);
                        if (numFilter) {
                            filter[trimmedKey] = numFilter;
                            return acc;
                        }
                    }
                    // If numeric parsing failed but it's a number, treat as equals
                    if (!isNaN(trimmedValue)) {
                        filter[trimmedKey] = {
                            'equals': Number(trimmedValue)
                        };
                    } 
                    // For normal array inclusion
                    else if (trimmedValue.startsWith('[') && trimmedValue.endsWith(']')) {
                        let arr;
                        try {
                            arr = JSON.parse(trimmedValue);
                        } catch {
                            arr = trimmedValue.slice(1, -1).split(',').map(v => v.trim());
                        }
                        // If any value contains %, treat as string filter
                        if (arr.some(v => typeof v === 'string' && v.includes('%'))) {
                            // Build OR array in the current filter context (not top-level)
                            if (!filter.OR) filter.OR = [];
                            arr.forEach(v => {
                                filter.OR.push({ [trimmedKey]: this.#filterString(v) });
                            });
                        } else {
                            filter[trimmedKey] = { in: arr };
                        }
                    } else {
                        filter[trimmedKey] = this.#filterString(trimmedValue);
                    }
                }
                return acc;
            }, {});
        }
        return {};
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
        const dateOperators = ['before:', 'after:', 'from:', 'to:', 'between:', 'on:'];
        const foundOperator = dateOperators.find(op => value.startsWith(op));

        if (!foundOperator) {
            return null;
        }

        const operatorValue = value.substring(foundOperator.length);

        try {
            switch (foundOperator) {
                case 'before:':
                    const beforeDate = new Date(operatorValue);
                    if (isNaN(beforeDate.getTime())) {
                        throw new Error(`Invalid date: ${operatorValue}`);
                    }
                    return { lt: beforeDate };
                case 'after:':
                    const afterDate = new Date(operatorValue);
                    if (isNaN(afterDate.getTime())) {
                        throw new Error(`Invalid date: ${operatorValue}`);
                    }
                    return { gt: afterDate };
                case 'from:':
                    const fromDate = new Date(operatorValue);
                    if (isNaN(fromDate.getTime())) {
                        throw new Error(`Invalid date: ${operatorValue}`);
                    }
                    return { gte: fromDate };
                case 'to:':
                    const toDate = new Date(operatorValue);
                    if (isNaN(toDate.getTime())) {
                        throw new Error(`Invalid date: ${operatorValue}`);
                    }
                    return { lte: toDate };
                case 'on:':
                    const date = new Date(operatorValue);
                    if (isNaN(date.getTime())) {
                        throw new Error(`Invalid date: ${operatorValue}`);
                    }
                    const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
                    const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
                    return {
                        gte: startOfDay,
                        lt: endOfDay
                    };
                case 'between:':
                    const [startDate, endDate] = operatorValue.split(';').map(d => d.trim());
                    if (!startDate || !endDate) {
                        throw new ErrorResponse(400, "between_requires_two_values");
                    }

                    // If both values look like pure numbers (not dates), let the number filter handle it
                    const isStartNumber = /^-?\d+(\.\d+)?$/.test(startDate);
                    const isEndNumber = /^-?\d+(\.\d+)?$/.test(endDate);
                    if (isStartNumber && isEndNumber) {
                        return null; // Let #filterNumber handle numeric between
                    }

                    const startDateObj = new Date(startDate);
                    const endDateObj = new Date(endDate);
                    if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
                        throw new ErrorResponse(400, "invalid_date_range", {start: startDate, end: endDate});
                    }
                    return {
                        gte: startDateObj,
                        lte: endDateObj
                    };
                default:
                    return null;
            }
        } catch (error) {
            throw new ErrorResponse(400, "invalid_date_format", {value, error: error.message});
        }
    }

    /**
     * Parse string filters with wildcard support and URL decoding
     * @param {string} value - String filter value
     * @returns {Object|boolean} Prisma string filter or boolean value
     */
    #filterString(value){
        if (value.startsWith('%') && value.endsWith('%')) {
            // Remove the outer % signs, then decode the inner content
            const innerValue = value.slice(1, -1);
            return {
                'contains': decodeURIComponent(innerValue)
            };
        }
        else{
            if(value.startsWith('%')){
                // Remove the leading %, then decode
                const innerValue = value.slice(1);
                return {
                    'endsWith': decodeURIComponent(innerValue)
                };
            }
            else{
                if (value.endsWith('%')) {
                    // Remove the trailing %, then decode
                    const innerValue = value.slice(0, -1);
                    return {
                        'startsWith': decodeURIComponent(innerValue)
                    };
                }
                else{
                    switch(value){
                        case "true":
                            return true;
                        case "false":
                            return false;
                        default:
                            return {
                                'equals': decodeURIComponent(value)
                            };
                    }
                }
            }
        }
    }

    /**
     * Build deep relationship include object with access controls
     * @param {Object} relation - Relation configuration
     * @param {Object} user - User object with role
     * @returns {Object} Prisma include/select object
     */
    #includeDeepRelationships(relation, user) {
        const child_relation = relation.relation;
        let content = {};
        if (typeof relation.access === "object" && Array.isArray(relation.access[user.role])) {
            content.select = relation.access[user.role].reduce((acc, curr) => {
                acc[curr] = true;
                return acc;
            }, {});
        } else {
            content.include = {};
        }

        // Add omit fields for this relation if available
        const omitFields = this.getRelatedOmit(relation.object, user);
        if (Object.keys(omitFields).length > 0) {
            content.omit = omitFields;
        }

        // Apply ACL access filter for this relation (for all relations, not just list relations)
        if (relation.object && acl.model[relation.object]?.getAccessFilter) {
            const accessFilter = acl.model[relation.object].getAccessFilter(user);
            const cleanedFilter = this.cleanFilter(accessFilter);
            const simplifiedFilter = this.#simplifyNestedFilter(cleanedFilter, this.name);
            if (simplifiedFilter && typeof simplifiedFilter === 'object' && Object.keys(simplifiedFilter).length > 0) {
                content.where = simplifiedFilter;
            }
        }

        if (Array.isArray(child_relation)) {
            for (let i = 0; i < child_relation.length; i++) {
                const _child_relation = this.#includeDeepRelationships(child_relation[i], user);
                if (typeof child_relation[i].access !== "object" || child_relation[i].access[user.role] !== false) {
                    if (content.hasOwnProperty('select')) {
                        content['select'][child_relation[i].name] = _child_relation;
                    } else {
                        content['include'][child_relation[i].name] = _child_relation;
                    }
                }
            }
        }
        return content.hasOwnProperty('select') || content.hasOwnProperty('omit') || content.hasOwnProperty('where') || (content.hasOwnProperty('include') && Object.keys(content.include).length > 0) ? content : true;
    }

    /**
     * Get relationships configuration for a specific model
     * @param {string} modelName - The model name
     * @returns {Array} Array of relationship configurations for the model
     */
    #getRelationshipsForModel(modelName) {
        if (!modelName) {
            return [];
        }

        try {
            const relationshipsPath = path.resolve(__dirname, '../rapidd/relationships.json');
            const relationships = JSON.parse(fs.readFileSync(relationshipsPath, 'utf8'));
            const modelRelationships = relationships[modelName] || {};

            // Convert to array format
            return Object.entries(modelRelationships).map(([name, config]) => ({
                name,
                ...config
            }));
        } catch (error) {
            console.error(`Failed to load relationships for ${modelName}:`, error);
            return [];
        }
    }

    /**
     * Build top-level only relationship include (no deep relations)
     * @param {Object} relation - Relation configuration
     * @param {Object} user - User object with role
     * @returns {Object} Prisma include/select object for top-level only
     */
    #includeTopLevelOnly(relation, user) {
        let content = {};
        if (typeof relation.access === "object" && Array.isArray(relation.access[user.role])) {
            content.select = relation.access[user.role].reduce((acc, curr) => {
                acc[curr] = true;
                return acc;
            }, {});
        } else {
            // Check if there are omit fields for this relation
            const omitFields = this.getRelatedOmit(relation.object, user);
            if (Object.keys(omitFields).length > 0) {
                content = { omit: omitFields };
            } else {
                content = true; // Include all fields but no nested relations
            }
        }

        // Apply ACL access filter for this relation (for all relations, not just list relations)
        if (relation.object && acl.model[relation.object]?.getAccessFilter) {
            const accessFilter = acl.model[relation.object].getAccessFilter(user);
            const cleanedFilter = this.cleanFilter(accessFilter);
            const simplifiedFilter = this.#simplifyNestedFilter(cleanedFilter, this.name);
            if (simplifiedFilter && typeof simplifiedFilter === 'object' && Object.keys(simplifiedFilter).length > 0) {
                if (content === true) {
                    content = { where: simplifiedFilter };
                } else if (typeof content === 'object') {
                    content.where = simplifiedFilter;
                }
            }
        }

        return content;
    }

    /**
     * Build selective deep relationship include based on dot notation paths
     * @param {Object} relation - Relation configuration
     * @param {Object} user - User object with role
     * @param {Array} deepPaths - Array of deep paths (e.g., ['agency', 'courses.subject'])
     * @returns {Object} Prisma include/select object with selective deep relations
     */
    #includeSelectiveDeepRelationships(relation, user, deepPaths) {
        let content = {};
        if (typeof relation.access === "object" && Array.isArray(relation.access[user.role])) {
            content.select = relation.access[user.role].reduce((acc, curr) => {
                acc[curr] = true;
                return acc;
            }, {});
        } else {
            content.include = {};
        }

        // Add omit fields for this relation if available
        const omitFields = this.getRelatedOmit(relation.object, user);
        if (Object.keys(omitFields).length > 0) {
            content.omit = omitFields;
        }

        // Apply ACL access filter for this relation (for all relations, not just list relations)
        if (relation.object && acl.model[relation.object]?.getAccessFilter) {
            const accessFilter = acl.model[relation.object].getAccessFilter(user);
            const cleanedFilter = this.cleanFilter(accessFilter);
            const simplifiedFilter = this.#simplifyNestedFilter(cleanedFilter, this.name);
            if (simplifiedFilter && typeof simplifiedFilter === 'object' && Object.keys(simplifiedFilter).length > 0) {
                content.where = simplifiedFilter;
            }
        }

        // Process each deep path
        if (deepPaths && deepPaths.length > 0) {
            const pathsByRelation = {};

            // Group paths by their first level relation
            deepPaths.forEach(path => {
                const parts = path.split('.');
                const firstLevel = parts[0];
                if (!pathsByRelation[firstLevel]) {
                    pathsByRelation[firstLevel] = [];
                }
                if (parts.length > 1) {
                    pathsByRelation[firstLevel].push(parts.slice(1).join('.'));
                } else {
                    pathsByRelation[firstLevel].push(''); // Mark as include this level
                }
            });

            // Load child object's relationships from relationships.json
            const childRelationships = this.#getRelationshipsForModel(relation.object);

            // Build includes for each requested relation
            for (const relationName in pathsByRelation) {
                const childRelation = childRelationships.find(r => r.name === relationName);

                if (childRelation && (typeof childRelation.access !== "object" || childRelation.access[user.role] !== false)) {
                    let childInclude;
                    const childPaths = pathsByRelation[relationName].filter(p => p !== '');

                    if (childPaths.length > 0) {
                        // Recursively build selective deep relationships
                        childInclude = this.#includeSelectiveDeepRelationships(childRelation, user, childPaths);
                    } else {
                        // Only include this level
                        childInclude = this.#includeTopLevelOnly(childRelation, user);
                    }

                    if (content.hasOwnProperty('select')) {
                        content['select'][relationName] = childInclude;
                    } else {
                        content['include'][relationName] = childInclude;
                    }
                }
            }
        }

        return content.hasOwnProperty('select') || content.hasOwnProperty('omit') || content.hasOwnProperty('where') || (content.hasOwnProperty('include') && Object.keys(content.include).length > 0) ? content : true;
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
                // Keep the old behavior for "ALL" - load all deep relationships
                includeRelated = this.relatedObjects.reduce((acc, curr) => {
                    if (typeof curr.access !== "object" || curr.access[user.role] !== false) {
                        const rel = this.#includeDeepRelationships(curr, user);
                        if (exclude_rule && exclude_rule[curr.name]) {
                            rel.where = exclude_rule[curr.name];
                        }
                        acc[curr.name] = rel;
                    }
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
                    if (topLevelIncludes.has(curr.name) && (typeof curr.access !== "object" || curr.access[user.role] !== false)) {
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
     * @param {Object} data - Data to create
     * @param {number} user_id - ID of creating user
     */
    create(data, user_id) {
        this.#cleanTimestampFields(data);
        for (let key in data) {
            if (this.fields[key] == null) {
                const relatedObject = this.relatedObjects.find(e => e.name === key);
                if (relatedObject == null) {
                    throw new ErrorResponse(400, "unexpected_key", {key});
                } else {
                    if (data[key]) {
                        if (Array.isArray(data[key])) {
                            for (let i = 0; i < data[key].length; i++) {
                                this.#cleanTimestampFields(data[key][i]);
                                let relation = false;
                                for (let _key in data[key][i]) {
                                    if (prisma[relatedObject.object].fields[_key] == null) {
                                        throw new ErrorResponse(400, "unexpected_key", {key: `${key}.${_key}`});
                                    }
                                    if (relatedObject.fields && relatedObject.fields.includes(_key)) {
                                        const sub_data_clone = { ...data[key][i] };
                                        delete sub_data_clone[_key];
                                        const index = relatedObject.fields.findIndex(f => f === _key);
                                        if (index > 0) {
                                            const relPrimaryKey = relatedObject.relation[index - 1].foreignKey || this.getPrimaryKey(relatedObject.relation[index - 1].object);
                                            data[key][i] = {
                                                [relatedObject.relation[index - 1].name]: {
                                                    'connect': {
                                                        [relPrimaryKey]: data[key][i][_key]
                                                    }
                                                },
                                                ...sub_data_clone
                                            };
                                            relation = true;
                                        } else {
                                            delete data[key][i][_key];
                                        }
                                    }
                                }
                            }

                            data[key] = {
                                'create': data[key].filter(e => e.id == null),
                                'connect': data[key].filter(e => e.id).map(e => ({
                                    [relatedObject.foreignKey || 'id']: e[relatedObject.foreignKey || 'id']
                                }))
                            };
                        } else {
                            this.#cleanTimestampFields(data[key]);

                            for (let _key in data[key]) {
                                if (prisma[relatedObject.object].fields[_key] == null) {
                                    throw new ErrorResponse(400, "unexpected_key", {key: `${key}.${_key}`});
                                }
                                const child_relation = relatedObject?.relation?.find(e => e.field === _key);
                                if (child_relation) {
                                    if(data[key][_key]){
                                        const childPrimaryKey = child_relation.foreignKey || this.getPrimaryKey(child_relation.object);
                                        data[key][child_relation.name] = {
                                            'connect': {
                                                [childPrimaryKey]: data[key][_key]
                                            }
                                        };
                                    }
                                    delete data[key][_key];
                                }
                            }
                            data[key] = {
                                'create': {
                                    ...data[key]
                                }
                            };
                        }
                    }
                }
            } else {
                const relatedObject = this.relatedObjects.find(e => e.field === key);
                if (relatedObject) {
                    if(data[key]){
                        data[relatedObject.name] = {
                            'connect': {
                                [relatedObject.foreignKey || 'id']: data[key]
                            }
                        };
                    }
                    delete data[key];
                }
            }
        }
    }

    /**
     * Process data for update operation with nested relation support
     * @param {number} id - ID of record to update
     * @param {Object} data - Data to update
     * @param {number} user_id - ID of updating user
     */
    update(id, data, user_id) {
        this.#cleanTimestampFields(data);

        for (let key in data) {
            if (this.fields[key] == null) {
                const relatedObject = this.relatedObjects.find(e => e.name === key);
                if (relatedObject == null) {
                    throw new ErrorResponse(400, "unexpected_key", {key});
                } else {
                    if (data[key]) {
                        if (Array.isArray(data[key])) {
                            data[key] = this.#processArrayRelation(data[key], relatedObject, id, user_id);
                        } else {
                            data[key] = this.#processSingleRelation(data[key], relatedObject, user_id);
                        }
                    }
                }
            } else {
                const relatedObject = this.relatedObjects.find(e => e.field === key);
                if (relatedObject) {
                    if (data[key] != null) {
                        data[relatedObject.name] = {
                            'connect': {
                                [relatedObject.foreignKey || 'id']: data[key]
                            }
                        };
                    } else {
                        data[relatedObject.name] = { 'disconnect': true };
                    }
                    delete data[key];
                }
            }
        }
    }
    
    /**
     * Process array relations for update operations
     * @param {Array} dataArray - Array of relation data
     * @param {Object} relatedObject - Relation configuration
     * @param {number} parentId - Parent record ID
     * @param {number} user_id - User ID
     * @returns {Object} Prisma array relation operations
     */
    #processArrayRelation(dataArray, relatedObject, parentId, user_id) {
        for (let i = 0; i < dataArray.length; i++) {
            this.#cleanTimestampFields(dataArray[i]);
            
            // Validate all fields
            for (let _key in dataArray[i]) {
                if (prisma[relatedObject.object].fields[_key] == null) {
                    throw new ErrorResponse(400, "unexpected_key", {key: `${relatedObject.name}.${_key}`});
                }
            }
            
            // Process nested relations recursively if they exist
            if (relatedObject.relation) {
                dataArray[i] = this.#processNestedRelations(dataArray[i], relatedObject.relation, user_id);
            }
        }
        
        return {
            'connect': dataArray.filter(e => !Array.isArray(relatedObject.fields) && Object.keys(e).length === 1).map(e => {
                return { [relatedObject.foreignKey || 'id']: e[relatedObject.foreignKey || 'id'] };
            }),
            'updateMany': dataArray.filter(e => e.id && Object.keys(e).length > 1).map(e => {
                return {
                    'where': {
                        [relatedObject.foreignKey || 'id']: e[relatedObject.foreignKey || 'id']
                    },
                    'data': { ...e }
                };
            }),
            'upsert': dataArray.filter(e => e.id == null).map(e => {
                const where = {};
                if (Array.isArray(relatedObject.fields)) {
                    const pair_id = {};
                    pair_id[relatedObject.fields[0]] = parentId;
                    for (let field in e) {
                        if (relatedObject.fields.includes(field)) {
                            pair_id[field] = e[field];
                        }
                    }
                    where[relatedObject.field] = pair_id;
                } else {
                    where[relatedObject.field || relatedObject.foreignKey || 'id'] = e[relatedObject.field || relatedObject.foreignKey || 'id'] || -1;
                }
                return {
                    'where': where,
                    'create': { ...e },
                    'update': { ...e }
                };
            })
        };
    }
    
    /**
     * Process single relation for update operations with create/update separation
     * @param {Object} dataObj - Relation data object
     * @param {Object} relatedObject - Relation configuration
     * @param {number} user_id - User ID
     * @returns {Object|null} Prisma upsert operation or null
     */
    #processSingleRelation(dataObj, relatedObject, user_id) {
        // Validate all fields first
        for (let _key in dataObj) {
            if (prisma[relatedObject.object].fields[_key] == null) {
                throw new ErrorResponse(400, "unexpected_key", {key: `${relatedObject.name}.${_key}`});
            }
        }
    
        // Process nested relations recursively if they exist
        let processedData = dataObj;
        if (relatedObject.relation) {
            processedData = this.#processNestedRelations(dataObj, relatedObject.relation, user_id);
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
                        // For both create and update, use connect when value is not null
                        const connectObj = {
                            'connect': {
                                [rel.foreignKey || 'id']: processedData[relation_key]
                            }
                        };
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
     * @param {number} user_id - User ID
     * @returns {Object} Processed data object
     */
    #processNestedRelations(dataObj, relatedObjects, user_id) {
        const processedData = {...dataObj};
        
        for (let key in processedData) {
            const nestedRelation = relatedObjects.find(rel => rel.name === key);
            
            if (nestedRelation && processedData[key] && typeof processedData[key] === 'object') {
                if (Array.isArray(processedData[key])) {
                    // Process nested array relation recursively
                    processedData[key] = this.#processArrayRelation(processedData[key], nestedRelation, null, user_id);
                } else {
                    // Process nested single relation recursively
                    const nestedResult = this.#processSingleRelation(processedData[key], nestedRelation, user_id);
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
     * Remove timestamp fields from data object
     * @param {Object} dataObj - Data object to clean
     */
    #cleanTimestampFields(dataObj) {
        delete dataObj.created_by;
        delete dataObj.updated_by;
        delete dataObj.created_date;
        delete dataObj.updated_date;
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
 * Handle Prisma errors and convert to standardized error responses
 * @param {Error|string} error - Error object or message
 * @param {Object} data - Additional data context
 * @returns {Object} Standardized error response with status_code and message
 */
QueryBuilder.errorHandler = (error, data = {})=>{
    console.error(error);

    let status_code = error.status_code || 500;
    let message = error instanceof ErrorResponse == false && process.env.NODE_ENV == "production" ? "Something went wrong" :  (error.message || error.toString());

    if(error?.code){
        switch(error.code){
            case "P1001":
                message = `Connection to the database couldn't be established`;
                break;
            case "P2000":
                status_code = 400;
                message = `The provided value for the column is too long`;
                break;
            case "P2001":
                status_code = 404;
                message = `The record searched for in the where condition does not exist`;
                break;
            case "P2002":
                status_code = 409;
                message = `Duplicate entry for ${error.meta?.modelName}. Record with ${error.meta?.target}: '${data[error.meta?.target]}' already exists`;
                break;
            case "P2003":
                status_code = 400;
                message = `Foreign key constraint failed`;
                break;
            case "P2004":
                status_code = 400;
                message = `A constraint failed on the database`;
                break;
            case "P2005":
                status_code = 400;
                message = `The value stored in the database is invalid for the field's type`;
                break;
            case "P2006":
                status_code = 400;
                message = `The provided value is not valid`;
                break;
            case "P2007":
                status_code = 400;
                message = `Data validation error`;
                break;
            case "P2008":
                status_code = 400;
                message = `Failed to parse the query`;
                break;
            case "P2009":
                status_code = 400;
                message = `Failed to validate the query`;
                break;
            case "P2010":
                status_code = 500;
                message = `Raw query failed`;
                break;
            case "P2011":
                status_code = 400;
                message = `Null constraint violation`;
                break;
            case "P2012":
                status_code = 400;
                message = `Missing a required value`;
                break;
            case "P2013":
                status_code = 400;
                message = `Missing the required argument`;
                break;
            case "P2014":
                status_code = 400;
                message = `The change you are trying to make would violate the required relation`;
                break;
            case "P2015":
                status_code = 404;
                message = `A related record could not be found`;
                break;
            case "P2016":
                status_code = 400;
                message = `Query interpretation error`;
                break;
            case "P2017":
                status_code = 400;
                message = `The records for relation are not connected`;
                break;
            case "P2018":
                status_code = 404;
                message = `The required connected records were not found`;
                break;
            case "P2019":
                status_code = 400;
                message = `Input error`;
                break;
            case "P2020":
                status_code = 400;
                message = `Value out of range for the type`;
                break;
            case "P2021":
                status_code = 404;
                message = `The table does not exist in the current database`;
                break;
            case "P2022":
                status_code = 404;
                message = `The column does not exist in the current database`;
                break;
            case "P2023":
                status_code = 400;
                message = `Inconsistent column data`;
                break;
            case "P2024":
                status_code = 408;
                message = `Timed out fetching a new connection from the connection pool`;
                break;
            case "P2025":
                status_code = 404;
                message = `Operation failed because it depends on one or more records that were required but not found`;
                break;
            case "P2026":
                status_code = 400;
                message = `The current database provider doesn't support a feature that the query used`;
                break;
            case "P2027":
                status_code = 500;
                message = `Multiple errors occurred on the database during query execution`;
                break;
            case "P2028":
                status_code = 500;
                message = `Transaction API error`;
                break;
            case "P2030":
                status_code = 404;
                message = `Cannot find a fulltext index to use for the search`;
                break;
            case "P2033":
                status_code = 400;
                message = `A number used in the query does not fit into a 64 bit signed integer`;
                break;
            case "P2034":
                status_code = 409;
                message = `Transaction failed due to a write conflict or a deadlock`;
                break;
        }
    }
    return {'status_code': status_code, 'message': message};
}

module.exports = {QueryBuilder, prisma, prismaTransaction};