const { PrismaClient } = require('../prisma/client');
const { ErrorResponse } = require('./Api');

const prisma = new PrismaClient({
    'omit': {
        'user': {
            'hash': true
        }
    }
});

const API_RESULT_LIMIT = parseInt(process.env.API_RESULT_LIMIT, 10) || 500;

class QueryBuilder {
    constructor(name, model) {
        this.name = name;
        this.model = model;
        this.fields = prisma[this.name].fields;
        this.relatedObjects = this.model.relatedObjects;
        this.inaccessible_fields = this.model.inaccessible_fields;
    }

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

    filter(q) {
        if (typeof q === 'string') {
            return q.split(/,(?![^\[]*\])/).reduce((acc, curr) => {
                const [key, value] = curr.split('=');
                const relation = key.split('.').map(e => e.trim());
                const trimmedKey = relation.pop();
                const trimmedValue = value ? value.trim() : null;

                if (relation.length === 0 && !this.fields[trimmedKey]) {
                    throw new ErrorResponse(`Invalid filter field: ${trimmedKey}.`, 400);
                }

                let filter = acc;
                const relationPrisma = relation.reduce((_acc, _curr) => {
                    let rel;
                    if (Array.isArray(_acc)) {
                        rel = _acc.find(rel => rel.name === _curr);
                        if (!rel) {
                            throw new ErrorResponse(`Relation '${_curr}' does not exist in ${Array.isArray(_acc) ? this.model.name : _acc.name}.`, 400);
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
                        }
                        filter = filter[rel.name];
                    }

                    return rel;
                }, this.relatedObjects);

                if (relation.length > 0 && !prisma[relationPrisma.object].fields[trimmedKey]) {
                    throw new ErrorResponse(`Field '${trimmedKey}' does not exist in ${relationPrisma.object}.`, 400);
                }

                if (!trimmedValue) {
                    filter[trimmedKey] = null;
                } else {
                    if (isNaN(trimmedValue)) {
                        if (trimmedValue.startsWith('[') && trimmedValue.endsWith(']')) {
                            if (!Array.isArray(filter['AND'])) {
                                filter['AND'] = [];
                            }

                            const listValues = trimmedValue.slice(1, -1)?.split(',');
                            const condition = {
                                'OR': []
                            };

                            filter['AND'].push(condition);
                            listValues.forEach(listValue => {
                                const listSearch = {};
                                listValue = listValue ? listValue.trim() : null;
                                if (listValue) {
                                    if (isNaN(listValue)) {
                                        listSearch[trimmedKey] = this.#filterString(listValue);
                                    } else {
                                        listSearch[trimmedKey] = {
                                            equals: Number(listValue)
                                        };
                                    }
                                } else {
                                    listSearch[trimmedKey] = null;
                                }
                                condition['OR'].push(listSearch);
                            });
                        } else {
                            const dateFilter = this.#filterDateTime(trimmedValue);
                            if (dateFilter) {
                                filter[trimmedKey] = dateFilter;
                            } else {
                                filter[trimmedKey] = this.#filterString(trimmedValue);
                            }
                        }
                    } else {
                        filter[trimmedKey] = {
                            'equals': Number(trimmedValue)
                        };
                    }
                }
                return acc;
            }, {});
        }
        return {};
    }

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
                    return { lt: new Date(operatorValue) };
                case 'after:':
                    return { gt: new Date(operatorValue) };
                case 'from:':
                    return { gte: new Date(operatorValue) };
                case 'to:':
                    return { lte: new Date(operatorValue) };
                case 'on:':
                    const date = new Date(operatorValue);
                    const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
                    const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
                    return {
                        gte: startOfDay,
                        lt: endOfDay
                    };
                case 'between:':
                    const [startDate, endDate] = operatorValue.split(';').map(d => d.trim());
                    if (!startDate || !endDate) {
                        throw new ErrorResponse('Between operator requires two dates separated by semicolon', 400);
                    }
                    return {
                        gte: new Date(startDate),
                        lte: new Date(endDate)
                    };
                default:
                    return null;
            }
        } catch (error) {
            throw new ErrorResponse(`Invalid date format in filter: ${value}. Error: ${error.message}`, 400);
        }
    }

    #filterString(value) {
        if (value.startsWith('%') && value.endsWith('%')) {
            return {
                'contains': decodeURI(value.replace(/%/g, ''))
            };
        } else {
            if (value.startsWith('%')) {
                return {
                    'endsWith': decodeURI(value.slice(1))
                };
            } else {
                if (value.endsWith('%')) {
                    return {
                        'startsWith': decodeURI(value.slice(0, -1))
                    };
                } else {
                    switch (value) {
                        case "true":
                            return true;
                        case "false":
                            return false;
                        default:
                            return {
                                'equals': value
                            };
                    }
                }
            }
        }
    }

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
        return content.hasOwnProperty('select') || (content.hasOwnProperty('include') && Object.keys(content.include).length > 0) ? content : true;
    }

    include(include = "ALL", user) {
        let include_query = typeof include === 'string' ? include : typeof include === 'object' ? include.query : null;
        let exclude_rule = typeof include === 'object' ? include.rule : null;
        if (include_query) {
            let includeRelated = this.relatedObjects.reduce((acc, curr) => {
                if (typeof curr.access !== "object" || curr.access[user.role] !== false) {
                    const rel = this.#includeDeepRelationships(curr, user);
                    if (exclude_rule && exclude_rule[curr.name]) {
                        rel.where = exclude_rule[curr.name];
                    }
                    acc[curr.name] = rel;
                }
                return acc;
            }, {});

            if (include_query != "ALL") {
                const includeList = include_query.split(',').map(item => item.trim());
                for (let key in includeRelated) {
                    if (!includeList.includes(key)) {
                        delete includeRelated[key];
                    }
                }
            }
            return includeRelated;
        }
        return {};
    }

    omit(user, inaccessible_fields = null) {
        const omit_fields = inaccessible_fields || this.model.getOmitFields(user);
        if (omit_fields) {
            return omit_fields.reduce((acc, curr) => {
                acc[curr] = true;
                return acc;
            }, {});
        }
        return {};
    }

    take(limit) {
        if (!Number.isInteger(limit) || limit <= 0) {
            throw new ErrorResponse("Invalid limit", 400);
        }
        return limit > QueryBuilder.API_RESULT_LIMIT ? QueryBuilder.API_RESULT_LIMIT : limit;
    }

    sort(sortBy, sortOrder) {
        if (typeof sortBy !== 'string') {
            throw new ErrorResponse(`sortBy must be a string. '${typeof sortBy}' given.`, 400);
        }
        if (typeof sortOrder !== 'string' || (sortOrder != 'desc' && sortOrder != 'asc')) {
            throw new ErrorResponse(`sortOrder can only be 'asc' or 'desc'. '${sortOrder}' given.`, 400);
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

    create(data, user_id) {
        delete data.created_job_by;
        delete data.updated_job_by;
        delete data.created_job_date;
        delete data.updated_job_date;
        for (let key in data) {
            if (this.fields[key] == null) {
                const relatedObject = this.relatedObjects.find(e => e.name === key);
                if (relatedObject == null) {
                    throw new ErrorResponse(`Given key '${key}' is not expected`, 400);
                } else {
                    if (data[key]) {
                        if (Array.isArray(data[key])) {
                            for (let i = 0; i < data[key].length; i++) {
                                delete data[key][i].created_job_by;
                                delete data[key][i].updated_job_by;
                                delete data[key][i].created_job_date;
                                delete data[key][i].updated_job_date;
                                let relation = false;
                                for (let _key in data[key][i]) {
                                    if (prisma[relatedObject.object].fields[_key] == null) {
                                        throw new ErrorResponse(`Given key '${key}.${_key}' is not expected`, 400);
                                    }
                                    if (relatedObject.fields && relatedObject.fields.includes(_key)) {
                                        const sub_data_clone = { ...data[key][i] };
                                        delete sub_data_clone[_key];
                                        const index = relatedObject.fields.findIndex(f => f === _key);
                                        if (index > 0) {
                                            data[key][i] = {
                                                [relatedObject.relation[index - 1].name]: {
                                                    'connect': {
                                                        [relatedObject.relation[index - 1].foreignKey || 'id']: data[key][i][_key]
                                                    }
                                                },
                                                ...sub_data_clone,
                                                'createdBy': {
                                                    'connect': {
                                                        'id': user_id
                                                    }
                                                }
                                            };
                                            relation = true;
                                        } else {
                                            delete data[key][i][_key];
                                        }
                                    }
                                }
                                if (!relation && data[key][i].id == null) {
                                    data[key][i].created_job_by = user_id;
                                }
                            }

                            data[key] = {
                                'create': data[key].filter(e => e.id == null),
                                'connect': data[key].filter(e => e.id).map(e => ({
                                    [relatedObject.foreignKey || 'id']: e[relatedObject.foreignKey || 'id']
                                }))
                            };
                        } else {
                            delete data[key].created_job_by;
                            delete data[key].updated_job_by;
                            delete data[key].created_job_date;
                            delete data[key].updated_job_date;

                            for (let _key in data[key]) {
                                if (prisma[relatedObject.object].fields[_key] == null) {
                                    throw new ErrorResponse(`Given key '${key}.${_key}' is not expected`, 400);
                                }
                                const child_relation = relatedObject?.relation?.find(e => e.field === _key);
                                if (child_relation) {
                                    if(data[key][_key]){
                                        data[key][child_relation.name] = {
                                            'connect': {
                                                [child_relation.foreignKey || 'id']: data[key][_key]
                                            }
                                        };
                                    }
                                    delete data[key][_key];
                                }
                            }
                            data[key] = {
                                'create': {
                                    ...data[key],
                                    'createdBy': { 'connect': { 'id': user_id } }
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
        data.createdBy = { 'connect': { 'id': user_id } };
    }

    update(id, data, user_id) {
        delete data.created_job_by;
        delete data.updated_job_by;
        delete data.created_job_date;
        delete data.updated_job_date;
        for (let key in data) {
            if (this.fields[key] == null) {
                const relatedObject = this.relatedObjects.find(e => e.name === key);
                if (relatedObject == null) {
                    throw new ErrorResponse(`Given key '${key}' is not expected`, 400);
                } else {
                    if (data[key]) {
                        if (Array.isArray(data[key])) {
                            for (let i = 0; i < data[key].length; i++) {
                                delete data[key][i].created_job_by;
                                delete data[key][i].updated_job_by;
                                delete data[key][i].created_job_date;
                                delete data[key][i].updated_job_date;
                                for (let _key in data[key][i]) {
                                    if (prisma[relatedObject.object].fields[_key] == null) {
                                        throw new ErrorResponse(`Given key '${key}.${_key}' is not expected`, 400);
                                    }
                                }
                            }
                            data[key] = {
                                'connect': data[key].filter(e => !Array.isArray(relatedObject.fields) && Object.keys(e).length === 1).map(e => {
                                    return { [relatedObject.foreignKey || 'id']: e[relatedObject.foreignKey || 'id'] };
                                }),
                                'updateMany': data[key].filter(e => e.id && Object.keys(e).length > 1).map(e => {
                                    return {
                                        'where': {
                                            [relatedObject.foreignKey || 'id']: e[relatedObject.foreignKey || 'id']
                                        },
                                        'data': { ...e, 'updated_job_by': user_id }
                                    };
                                }),
                                'upsert': data[key].filter(e => e.id == null).map(e => {
                                    const where = {};
                                    if (Array.isArray(relatedObject.fields)) {
                                        const pair_id = {};
                                        pair_id[relatedObject.fields[0]] = id;
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
                                        'create': { ...e, 'created_job_by': user_id },
                                        'update': { ...e, 'updated_job_by': user_id }
                                    };
                                })
                            };
                        } else {
                            for (let _key in data[key]) {
                                if (prisma[relatedObject.object].fields[_key] == null) {
                                    throw new ErrorResponse(`Given key '${key}.${_key}' is not expected`, 400);
                                }
                            }

                            for (let relation_key in data[key]) {
                                if (relatedObject.relation) {
                                    const rel = relatedObject.relation.find(e => e.field === relation_key);
                                    if (rel) {
                                        if (data[key][relation_key] != null) {
                                            data[key][rel.name] = {
                                                'connect': {
                                                    [rel.foreignKey || 'id']: data[key][relation_key]
                                                }
                                            };
                                        } else {
                                            data[key][rel.name] = {
                                                'disconnect': true
                                            };
                                        }
                                        delete data[key][relation_key];
                                    }
                                }
                            }

                            data[key] = {
                                'upsert': {
                                    'create': {
                                        ...data[key],
                                        'createdBy': { 'connect': { 'id': user_id } }
                                    },
                                    'update': {
                                        ...data[key],
                                        'updatedBy': { 'connect': { 'id': user_id } }
                                    }
                                }
                            };
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
        data.updatedBy = { 'connect': { 'id': user_id } };
    }

    static get API_RESULT_LIMIT() {
        return API_RESULT_LIMIT;
    }
}

QueryBuilder.errorHandler = (error, data = {}) => {
    console.error(error);

    let status_code = error.status_code || 500;
    let message = error instanceof ErrorResponse == false && process.env.NODE_ENV == "production" ? "Something went wrong" : (error.message || error.toString());

    if (error?.code) {
        switch (error.code) {
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
    return { 'status_code': status_code, 'message': message };
}

module.exports = { QueryBuilder, prisma };