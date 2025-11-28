const { QueryBuilder, prisma, prismaTransaction } = require("./QueryBuilder");
const {acl} = require('../rapidd/rapidd');
const {ErrorResponse} = require('./Api');

class Model {
    /**
         * @param {string} name
         * @param {{'user': {}}} options
         */
    constructor(name, options){
        this.modelName = name;
        this.queryBuilder = new QueryBuilder(name);
        this.acl = acl.model[name] || {};
        this.options = options || {}
        this.user = this.options.user || {'id': 1, 'role': 'application'};
        this.user_id = this.user ? this.user.id : null;
    }

    get primaryKey(){
        const pkey = this.queryBuilder.getPrimaryKey();
        return Array.isArray(pkey) ? pkey.join('_') : pkey;
    }

    get fields(){
        return this.queryBuilder.fields;
    }

    _select = (fields) => this.queryBuilder.select(fields);
    _filter = (q) => this.queryBuilder.filter(q);
    _include = (include) => this.queryBuilder.include(include, this.user);
    _queryCreate = (data) => this.queryBuilder.create(data, this.user);
    _queryUpdate = (id, data) => this.queryBuilder.update(id, data, this.user);
    // ACL METHODS
    _canCreate = () => this.acl.canCreate(this.user);
    _getAccessFilter = () => this.acl.getAccessFilter?.(this.user);
    _getUpdateFilter = () => this.acl.getUpdateFilter(this.user);
    _getDeleteFilter = () => this.acl.getDeleteFilter(this.user);
    _omit = () => this.queryBuilder.omit(this.user);

    /**
     *
     * @param {string} q
     * @property {string|Object} include
     * @param {number} limit
     * @param {number} offset
     * @param {string} sortBy
     * @param {'asc'|'desc'} sortOrder
     * @param {{}} [options={}]
     * @returns {Promise<Object[]>}
     */
    _getMany = async (q = {}, include = "", limit = 25, offset = 0, sortBy = this.primaryKey, sortOrder = "asc", options = {})=>{
        const take = this.take(Number(limit));
        const skip = this.skip(Number(offset));

        sortBy = sortBy?.trim();
        sortOrder = sortOrder?.trim();
        if (!sortBy.includes('.') && this.fields[sortBy] == undefined) {
            throw new ErrorResponse(400, "invalid_sort_field", {sortBy, modelName: this.constructor.name});
        }
        
        // Query the database using Prisma with filters, pagination, and limits
        const [data, total] = await prismaTransaction([
            (tx) => tx[this.name].findMany({
                'where': this.filter(q),
                'include': this.include(include),
                'take': take,
                'skip': skip,
                'orderBy': this.sort(sortBy, sortOrder),
                'omit': this._omit(),
                ...options
            }),
            (tx) => tx[this.name].count({
                'where': this.filter(q)
            })
        ]);
        return {data, meta: {take, skip, total}};
    }
    /**
     * @param {number} id
     * @param {string | Object} include
     * @param {{}} [options={}]
     * @returns {Promise<{} | null>}
     */
    _get = async (id, include, options = {}) =>{
        const {omit, ..._options} = options;
        console.log(JSON.stringify(this.include(include)));
        // To determine if the record is inaccessible, either due to non-existence or insufficient permissions, two simultaneous queries are performed.
        const _response = this.prisma.findUnique({
            'where': {
                [this.primaryKey]: id,
            },
            'include': this.include(include),
            'omit': {...this._omit(), ...omit},
            ..._options
        });

        const _checkPermission = this.prisma.findUnique({
            'where': {
                [this.primaryKey]: id,
                ...this.getAccessFilter()
            },
            'select': {
                'id': true
            }
        });

        const [response, checkPermission] = await Promise.all([_response, _checkPermission]);
        if(response){
            if(checkPermission){
                if(response.id != checkPermission?.id){   // IN CASE access_filter CONTAINS id FIELD
                    throw new ErrorResponse(403, "no_permission");
                }
            }
            else{
                throw new ErrorResponse(403, "no_permission");
            }
        }
        else{
            throw new ErrorResponse(404, "record_not_found");
        }
        return response;
    }
    /**
     * @param {{}} data
     * @param {{}} [options={}]
     * @returns {Promise<Object>}
     */
    _create = async (data, options = {}) => {
        // CHECK CREATE PERMISSION
        if (!this.canCreate()) {
            throw new ErrorResponse(403, "no_permission_to_create");
        }

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS
        this._queryCreate(data);

        // CREATE
        return await this.prisma.create({
            'data': data,
            'include': this.include('ALL'),
            ...options
        });
    }

    /**
     * @param {number} id
     * @param {{}} data
     * @param {{}} [options={}]
     * @returns {Promise<Object>}
     */
    _update = async (id, data, options = {}) => {
        delete data.createdAt;
        delete data.createdBy;
        // CHECK UPDATE PERMISSION
        const updateFilter = this.getUpdateFilter();
        if (updateFilter === false) {
            throw new ErrorResponse(403, "no_permission_to_update");
        }

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS
        this._queryUpdate(id, data);
        const response = await this.prisma.update({
            'where': {
                [this.primaryKey]: id,
                ...updateFilter
            },
            'data': data,
            'include': this.include('ALL'),
            ...options
        });
        if(response){
            return response;
        }
        throw new ErrorResponse(403, "no_permission");
    }

    /**
     * @param {{}} data
     * @param {string} [unique_key=this.primaryKey]
     * @param {{}} [options={}]
     * @returns {Promise<Object>}
     */
    async _upsert(data, unique_key = this.primaryKey, options = {}){
        const createData = data;
        const updateData = JSON.parse(JSON.stringify(data));
        this.queryBuilder.create(createData, this.user);
        this.queryBuilder.update(updateData, this.user);
        return await this.prisma.upsert({
            'where': {
                [unique_key]: data[unique_key]
            },
            'create': createData,
            'update': updateData,
            'include': this.include('ALL'),
            ...options
        });
    }

    /**
     *
     * @param {string} q
     * @returns {Promise<number>}
     */
    _count = async (q = {}) => {
        return await this.prisma.count({
            'where': this.filter(q)
        });
    }

    /**
     * @param {number} id
     * @param {{}} [options={}]
     * @returns {Promise<Object>}
     */
    _delete = async (id, options = {}) => {
        // CHECK DELETE PERMISSION
        const deleteFilter = this.getDeleteFilter();
        if (deleteFilter === false) {
            throw new ErrorResponse(403, "no_permission_to_delete");
        }

        const response = await this.prisma.delete({
            'where': {
                [this.primaryKey]: id,
                ...deleteFilter
            },
            'select': this.select(),
            ...options
        });
        if(response){
            return response;
        }
        throw new ErrorResponse(403, "no_permission");
    }

    /**
     *
     * @param {string} q
     * @property {string|Object} include
     * @param {number} limit
     * @param {number} offset
     * @param {string} sortBy
     * @param {'asc'|'desc'} sortOrder
     * @returns {Promise<Object[]>}
     */
    async getMany(q = {}, include = "", limit = 25, offset = 0, sortBy = "id", sortOrder = "asc"){
        return await this._getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder);
    }
    /**
     * @param {number} id
     * @param {string | Object} include
     * @param {{}} [options={}]
     * @returns {Promise<{} | null>}
     */
    async get(id, include, options = {}){
        return await this._get(id, include, options);
    }

    /**
     * @param {number} id
     * @param {{}} data
     * @param {{}} [options={}]
     * @returns {Promise<Object>}
     */
    async update(id, data, options = {}){
        return await this._update(id, data, options);
    }

    /**
     * @param {{}} data
     * @param {string} [unique_key=this.primaryKey]
     * @param {{}} [options={}]
     * @returns {Promise<Object>}
     */
    async upsert(data, unique_key = this.primaryKey, options = {}){
        return await this._upsert(data, unique_key, options);
    }

    /**
     *
     * @param {string} q
     * @returns {Promise<number>}
     */
    async count(q = {}) {
        return await this._count(q);
    }

    /**
     * @param {number} id
     * @returns {Promise<Object>}
     */
    async delete(id, data, options = {}){
        return await this._delete(id, data, options);
    }

    select(fields){
        return this._select(fields);
    }
    filter(include){
        return {...this._filter(include), ...this.getAccessFilter()};
    }
    include(include){
        return this._include(include);
    }
    sort(sortBy, sortOrder) {
        return this.queryBuilder.sort(sortBy, sortOrder);
    }
    take(limit){
        return this.queryBuilder.take(Number(limit));
    }
    skip(offset){
        const parsed = parseInt(offset);
        if(isNaN(parsed) || parsed < 0){
            return 0;
        }
        return parsed;
    }

    /**
     *
     * @returns {Object}
     */
    getAccessFilter(){
        const filter = this._getAccessFilter()
        if(this.user.role == "application" || filter === true){
            return {};
        }
        return this._getAccessFilter();
    }

    /**
     * Check if user can create records
     * @returns {boolean}
     */
    canCreate() {
        if(this.user.role == "application") return true;
        return this._canCreate();
    }

    /**
     * Get update filter for ACL
     * @returns {Object|false}
     */
    getUpdateFilter(){
        const filter = this._getUpdateFilter();
        if(this.user.role == "application" || filter === true){
            return {};
        }
        return filter;
    }

    /**
     * Get delete filter for ACL
     * @returns {Object|false}
     */
    getDeleteFilter(){
        const filter = this._getDeleteFilter();
        if(this.user.role == "application" || filter === true){
            return {};
        }
        return filter;
    }

    set modelName (name){
        this.name = name;
        this.prisma = prisma[name];
    }

    static relatedObjects = [];
    static Error = ErrorResponse;
}

module.exports = {Model, QueryBuilder, prisma};