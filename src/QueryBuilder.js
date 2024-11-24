const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
    'omit': {
        'user': {
            'sevdesk_contact_id': true,
            'hash': true
        },
        'address': {
            'sevdesk_address_id': true
        },
        'school':{
            'sevdesk_contact_id': true
        }
    }
});

const API_RESULT_LIMIT = 500;

class QueryBuilder {
    constructor(name, model){
        this.name = name;
        this.fields = prisma[this.name].fields;
        this.model = model;
        this.relatedObjects = this.model.relatedObjects;
        this.access_rule = this.model.access_rule;
        this.access_fields = this.model.access_fields;
        this.inaccessible_fields = this.model.inaccessible_fields;
    }

    select(fields = null){
        if(fields == null){
            fields = {}
            for(let key in this.fields){
                fields[key] = true;
            }
        }
        else{
            fields = fields.reduce((acc, curr) =>{
                acc[curr] = true;
                return acc;
            }, {});
        }
        return fields;
    }

    /**
     * 
     * @param {string} q 
     * @returns {{[key: string]: {operator: string}}}
     */
    filter(q){
        if (typeof q === 'string') {
            return q.split(',').reduce((acc, curr) => {
                const [key, value] = curr.split('=');
                const trimmedKey = key.trim();
                const trimmedValue = value ? value.trim() : null;
                if (!this.fields[trimmedKey]) {
                    throw new Error(`Field '${trimmedKey}' does not exist in user.`);
                }
                if (!trimmedValue) {
                    throw new Error(`Value for '${trimmedKey}' cannot be empty.`);
                }
                if(isNaN(trimmedValue)){
                    if (trimmedValue.startsWith('%') && trimmedValue.endsWith('%')) {
                        acc[trimmedKey] = {
                            contains: trimmedValue.replace(/%/g, '')
                        };
                    }
                    else{
                        if(trimmedValue.startsWith('%')){
                            acc[trimmedKey] = {
                                endsWith: trimmedValue.slice(1)
                            };
                        }
                        else{
                            if (trimmedValue.endsWith('%')) {
                                acc[trimmedKey] = {
                                    startsWith: trimmedValue.slice(0, -1)
                                };
                            }
                            else{
                                if(trimmedValue == "true")
                                    acc[trimmedKey] = true;
                                else if(trimmedValue == "false")
                                    acc[trimmedKey] = false;
                                else
                                    acc[trimmedKey] = {
                                        equals: trimmedValue
                                    };
                            }
                        }
                    }
                }
                else{
                    acc[trimmedKey] = {
                        equals: Number(trimmedValue)
                    };
                }
                return acc;
            }, {});
        }
        return {};
    }

    #includeDeepRelationships(relation, user){
        const child_relation = relation.relation;
        let content = {};
        if(typeof relation.access === "object" && Array.isArray(relation.access[user.role])){
            content.select = relation.access[user.role].reduce((acc, curr) => {
                acc[curr] = true;
                return acc;
            }, {});
        }
        else{
            content.include = {};
        }
        if(Array.isArray(child_relation)){
            for(let i = 0; i < child_relation.length; i++){
                const _child_relation = this.#includeDeepRelationships(child_relation[i], user);
                if(typeof child_relation[i].access !== "object" || child_relation[i].access[user.role] !== false){
                    if(content.hasOwnProperty('select')){
                        content['select'][child_relation[i].name] = _child_relation;
                    }
                    else{
                        content['include'][child_relation[i].name] = _child_relation;
                    }
                }
            }
        }
        return content.hasOwnProperty('select') || (content.hasOwnProperty('include') && Object.keys(content.include).length > 0) ? content : true;
    }

    /**
     * 
     * @param {string} include 
     * @returns {{[key: string]: true}}
     */
    include(include = "ALL", user){
        if(typeof include === 'string'){
            let includeRelated = this.relatedObjects.reduce((acc, curr) => {
                if(typeof curr.access !== "object" || curr.access[user.role] !== false){
                    acc[curr.name] = this.#includeDeepRelationships(curr, user);
                }
                return acc;
            }, {});
            
            if(include != "ALL"){
                const includeList = include.split(',').map(item => item.trim());
                for(let key in includeRelated){
                    if(!includeList.includes(key)){
                        delete includeRelated[key];
                    }
                }
            }
            return includeRelated;
        }
        return {};
    }

    omit(user, inaccessible_fields = null){
        const omit_fields = inaccessible_fields || this.inaccessible_fields['role'][user.role];
        if(omit_fields){
            return omit_fields.reduce((acc, curr)=>{
                acc[curr] = true;
                return acc;
            }, {});
        }
        return {};
    }

    /**
     * 
     * @param {*} limit 
     * @returns {number}
     */
    take(limit){
        return limit > QueryBuilder.API_RESULT_LIMIT ? QueryBuilder.API_RESULT_LIMIT : parseInt(limit)
    }

    /**
     * 
     * @param {string} sortBy 
     * @param {string} sortOrder 
     * @returns {{[key: string]: 'asc' | 'desc'}}
     */
    sort(sortBy, sortOrder){
        if(typeof sortBy !== 'string'){
            throw new Error(`sortBy must be a string. '${typeof sortBy}' given.`);
        }
        if(typeof sortOrder !== 'string' || (sortOrder != 'desc' && sortOrder != 'asc')){
            throw new Error(`sortOrder can only be 'asc' ord 'desc'. '${sortOrder}' given.`);
        }
        return {
            [sortBy.trim()]: sortOrder
        };
    }

    /**
     * 
     * @param {{}} data 
     * @param {number} user_id
     */
    create(data, user_id){
        delete data.created_by;
        delete data.updated_by;
        delete data.create_date;
        delete data.update_date;
        for(let key in data){
            if(this.fields[key] == undefined){
                const relatedObject = this.relatedObjects.find(e => e.name == key);
                if(relatedObject == undefined){
                    throw new Error(`Given key '${key}' is not expected`);
                }
                else{
                    if(data[key]){
                        if(Array.isArray(data[key])){
                            for(let i = 0; i < data[key].length; i++){
                                delete data[key][i].created_by;
                                delete data[key][i].updated_by;
                                delete data[key][i].create_date;
                                delete data[key][i].update_date;
                                // CHECK EXPECTED KEYS FOR RELATION
                                for(let _key in data[key][i]){
                                    if(prisma[relatedObject.object].fields[_key] == undefined){
                                        throw new Error(`Given key '${key}.${_key}' is not expected`);
                                    }
                                }
                                //data[key][i].createdBy = {'connect': {'id': user_id}};
                                if(data[key][i].id == undefined){
                                    data[key][i].created_by = user_id;
                                }
                            }
                            
                            data[key] = {
                                'create': data[key].filter(e => e.id == undefined),
                                'connect': data[key].filter(e => e.id)
                            };
                        }
                        else{
                            // CHECK EXPECTED KEYS FOR RELATION
                            for(let _key in data[key]){
                                delete data[key].created_by;
                                delete data[key].updated_by;
                                delete data[key].create_date;
                                delete data[key].update_date;
                                if(prisma[relatedObject.object].fields[_key] == undefined){
                                    throw new Error(`Given key '${key}.${_key}' is not expected`);
                                }
                            }
                            data[key] = {
                                'create': {
                                    ...data[key],
                                    'createdBy': {'connect': {'id': user_id}}
                                }
                            };
                        }
                    }
                }
            }
            else{
                const relatedObject = this.relatedObjects.find(e => e.field == key);
                if(relatedObject){
                    data[relatedObject.name] = {'connect': {'id': data[key]}};
                    delete data[key];
                }
            }
        }
        data.createdBy = {'connect': {'id': user_id}};
    }

    /**
     * 
     * @param {{}} data 
     * @param {number} user_id
     */
    update(id, data, user_id){
        delete data.created_by;
        delete data.updated_by;
        delete data.create_date;
        delete data.update_date;
        for(let key in data){
            if(this.fields[key] == undefined){
                const relatedObject = this.relatedObjects.find(e => e.name == key);
                if(relatedObject == undefined){
                    throw new Error(`Given key '${key}' is not expected`);
                }
                else{
                    if(data[key]){
                        // CHECK EXPECTED KEYS FOR RELATION
                        if(Array.isArray(data[key])){
                            for(let i = 0; i < data[key].length; i++){
                                delete data[key][i].created_by;
                                delete data[key][i].updated_by;
                                delete data[key][i].create_date;
                                delete data[key][i].update_date;
                                // CHECK EXPECTED KEYS FOR RELATION
                                for(let _key in data[key][i]){
                                    if(prisma[relatedObject.object].fields[_key] == undefined){
                                        throw new Error(`Given key '${key}.${_key}' is not expected`);
                                    }
                                }
                            }
                            data[key] = {
                                'upsert': data[key].map(e => {
                                    const where = {};
                                    if(e.id){
                                        where.id = e.id;
                                    }
                                    else{
                                        if(Array.isArray(relatedObject.fields)){
                                            const pair_id = {};
                                            pair_id[relatedObject.fields[0]] = id;
                                            for(let field in e){
                                                if(relatedObject.fields.includes(field)){
                                                    pair_id[field] = e[field];
                                                }
                                            }
                                            where[relatedObject.fields.join('_')] = pair_id;
                                        }
                                        else{
                                            where[relatedObject.field || 'id'] = e[relatedObject.field || 'id'] || -1;
                                        }
                                    }
                                    return {
                                        'where': where,
                                        'create': {...e, 'created_by': user_id},
                                        'update': {...e, 'updated_by': user_id}
                                    }
                                })
                            };
                        }
                        else{
                            for(let _key in data[key]){
                                if(prisma[relatedObject.object].fields[_key] == undefined){
                                    throw new Error(`Given key '${key}.${_key}' is not expected`);
                                }
                            }
                            data[key] = {
                                'upsert': {
                                    'create': {
                                        ...data[key],
                                        'createdBy': {'connect': {'id': user_id}}
                                    },
                                    'update': {
                                        ...data[key],
                                        'updatedBy': {'connect': {'id': user_id}}
                                    }
                                }
                            };
                        }
                    }
                }
            }
            else{
                const relatedObject = this.relatedObjects.find(e => e.field == key);
                if(relatedObject){
                    data[relatedObject.name] = {'connect': {'id': data[key]}};
                    delete data[key];
                }
            }
        }
        data.updatedBy = {'connect': {'id': user_id}};
    }

    /**
     * 
     * @param {{}} user 
     * @returns {{}} access_filter
     */
    getAccessFilter(user){
        const getAccessCriteria = (access_criteria) => {
            const criteria = {};
            if(access_criteria === true){
                return {};
            }
            if(access_criteria === false){
                return {"access": false};
            }
            for(let key in access_criteria){
                if(Array.isArray(access_criteria[key])){
                    criteria[key] = getCriteriaValue(access_criteria[key]);
                }
                else{
                    criteria[key] = getAccessCriteria(access_criteria[key]);
                }
            }
            return criteria;
        };

        const getCriteriaValue = (value_path) => {
            let value = user;
            for(let i = 0; i < value_path.length; i++){
                value = value[value_path[i]];
            }
            return value;
        };

        let access_filter = {};
        if(this.access_rule != null){
            for(let field in this.access_rule){
                const access_criteria = this.access_rule[field][user[field]];
                access_filter = {...access_filter, ...getAccessCriteria(access_criteria)};
            }
        }
        
        return access_filter;
    }

    /**
     * 
     * @param {{}} data 
     * @param {{}} user 
     * @returns {boolean} access
     */
    hasAccess(data, user){
        const checkCriteria = (data, access_criteria)=>{
            for(let key in access_criteria){
                if(typeof access_criteria[key] === 'object'){
                    console.log(key, data);
                    
                    if(key === 'some' && Array.isArray(data)){
                        const found = data[key]((e, i) => {
                            return checkCriteria(e, access_criteria[key])
                        });
                        if(!found){
                            return false;
                        }
                    }
                    else{
                        const criteria = checkCriteria(data[key], access_criteria[key]);
                        if(criteria === false){
                            return false;
                        }
                    }
                }
                else{
                    if(data[key] !== access_criteria[key]){
                        return false;
                    }
                }
            }
            return true;
        };
        return checkCriteria(data, this.getAccessFilter(user));
    }

    static get API_RESULT_LIMIT (){
        return API_RESULT_LIMIT;
    }
}

/**
 * 
 * @param {Error | string} error
 * @param {{}} data 
 * @returns {{'status_code': number, 'message': string}}
 */
QueryBuilder.errorHandler = (error, data = {})=>{
    console.error(error);

    let status_code = 500, message = error.toString();
    if(error?.code){
        switch(error.code){
            case "P1001":
                message = `Connection to the database couldn't be established`;
                break;
            case "P2002":
                status_code = 409;
                message = `Duplicate entry for ${error.meta.modelName}. Record with ${error.meta.target}: '${data[error.meta.target]}' already exists`;
                break;
            case "P2025":
                status_code = 404;
                message = `Operation failed because it depends on one or more records that were required but not found`;
                break;
        }
    }
    return {'status_code': status_code, 'message': message};
}

module.exports = {QueryBuilder, prisma};