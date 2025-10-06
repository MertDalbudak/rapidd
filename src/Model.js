const { QueryBuilder, prisma, rls } = require("./QueryBuilder");
const {ErrorResponse} = require('./Api');

class Model {
    /**
         * @param {string} name
         * @param {{'user': {}}} options
         */
    constructor(name, options){
        this.modelName = name;
        this.options = options || {}
        this.user = this.options.user || {'id': 1, 'role': 'application'};
        this.user_id = this.user ? this.user.id : null;

        // Initialize queryBuilder for this model instance
        if (!this.constructor.queryBuilder || this.constructor.queryBuilder.name !== name) {
            this.constructor.queryBuilder = new QueryBuilder(name, this.constructor);
        }
    }

    _select = (fields) => this.constructor.queryBuilder.select(fields);
    _filter = (q) => this.constructor.queryBuilder.filter(q);
    _include = (include) => this.constructor.queryBuilder.include(include, this.user);
    _getAccessFilter = () => this.getAccessFilterFromRLS(this.user);
    _hasAccess = (data) => this.hasAccessFromRLS(data, this.user) || false;
    _omit = () => this.constructor.queryBuilder.omit(this.user);

    /**
     * Get access filter from RLS configuration
     * @param {Object} user - User object with role
     * @returns {Object} Access filter object
     */
    getAccessFilterFromRLS(user) {
        if (rls.model[this.name]?.getAccessFilter) {
            return rls.model[this.name].getAccessFilter(user);
        }
        return {};
    }

    /**
     * Check if user has access to data from RLS configuration
     * @param {Object} data - Data to check access for
     * @param {Object} user - User object with role
     * @returns {boolean} True if user has access
     */
    hasAccessFromRLS(data, user) {
        if (rls.model[this.name]?.hasAccess) {
            return rls.model[this.name].hasAccess(data, user);
        }
        return true; // Default to allowing access if no RLS defined
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
    _getMany = async (q = {}, include = "", limit = 25, offset = 0, sortBy = "id", sortOrder = "asc", options = {})=>{
        const take = this.take(Number(limit));
        const skip = this.skip(Number(offset));

        sortBy = sortBy.trim();
        sortOrder = sortOrder.trim();
        if (!sortBy.includes('.') && this.fields[sortBy] == undefined) {
            throw new ErrorResponse(`Parameter sortBy '${sortBy}' is not a valid field of ${this.constructor.name}`, 400);
        }

        // Query the database using Prisma with filters, pagination, and limits
        return await this.prisma.findMany({
            'where': this.filter(q),
            'include': this.include(include),
            'take': take,
            'skip': skip,
            'orderBy': this.sort(sortBy, sortOrder),
            'omit': this._omit(),
            ...options
        });
    }
    /**
     * @param {number} id 
     * @param {string | Object} include 
     * @returns {Promise<{} | null>}
     */
    _get = async (id, include, options = {}) =>{
        const {omit, ..._options} = options;
        id = Number(id)
        // To determine if the record is inaccessible, either due to non-existence or insufficient permissions, two simultaneous queries are performed.
        const _response = this.prisma.findUnique({
            'where': {
                'id': id,
                ...this.getAccessFilter()
            },
            'include': this.include(include),
            'omit': {...this._omit(), ...omit},
            ..._options
        });
        
        const _checkExistence = this.prisma.findUnique({
            'where': {
                'id': id
            },
            'select': {
                'id': true
            }
        });

        const [response, checkExistence] = await Promise.all([_response, _checkExistence]);
        
        if(response == null){
            if(checkExistence == null){
                throw new ErrorResponse("Record not found", 404);
            }
            throw new ErrorResponse("No permission", 403);
        }
        if(response.id != checkExistence?.id){   // IN CASE access_filter CONTAINS id FIELD
            throw new ErrorResponse("No permission", 403);
        }
        return response;
    }
    /**
     * @param {{}} data
     * @returns {Promise<Object>}
     */
    _create = async (data, options = {}) => {
        // Check if user can create records
        if (rls.model[this.name]?.canCreate && !rls.model[this.name].canCreate(this.user)) {
            throw new ErrorResponse("You don't have permission to create records", 403);
        }

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS
        this.constructor.queryBuilder.create(data, this.user_id);

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
     * @returns {Promise<Object>}
     */
    _update = async (id, data, options = {}) => {
        id = Number(id);
        // GET DATA FIRST
        const current_data = await this._get(id, "ALL");

        // Check update filter from RLS
        if (rls.model[this.name]?.getUpdateFilter) {
            const updateFilter = rls.model[this.name].getUpdateFilter(this.user);
            // Check if the record passes the update filter
            const canUpdate = await this.prisma.findFirst({
                where: {
                    id: id,
                    ...updateFilter
                },
                select: { id: true }
            });
            if (!canUpdate) {
                throw new ErrorResponse("You don't have permission to update this record", 403);
            }
        }

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS
        this.constructor.queryBuilder.update(id, data, this.user_id);
        return await this.prisma.update({
            'where': {
                'id': id
            },
            'data': data,
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
     * @returns {Promise<Object>}
     */
    _delete = async (id, options = {}) => {
        // GET DATA FIRST
        const current_data = await this._get(id);

        // Check delete filter from RLS
        if (rls.model[this.name]?.getDeleteFilter) {
            const deleteFilter = rls.model[this.name].getDeleteFilter(this.user);
            // Check if the record passes the delete filter
            const canDelete = await this.prisma.findFirst({
                where: {
                    id: parseInt(id),
                    ...deleteFilter
                },
                select: { id: true }
            });
            if (!canDelete) {
                throw new ErrorResponse("You don't have permission to delete this record", 403);
            }
        }

        return await this.prisma.delete({
            'where': {
                id: parseInt(id)
            },
            'select': this.select(),
            ...options
        });
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
     * @returns {Promise<{} | null>}
     */
    async get(id, include, options = {}){
        return await this._get(Number(id), include, options);
    }

    /**
     * @param {number} id 
     * @param {{}} data 
     * @returns {Promise<Object>}
     */
    async update(id, data, options = {}){
        return await this._update(Number(id), data, options);
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
        return await this._delete(Number(id), data, options);
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
        return this.constructor.queryBuilder.sort(sortBy, sortOrder);
    }
    take(limit){
        return this.constructor.queryBuilder.take(Number(limit));
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
        if(this.user.role == "application" || filter == true){
            return {};
        }
        return this._getAccessFilter();
    }

    /**
     * 
     * @param {*} data 
     * @returns {boolean}
     */
    hasAccess(data) {
        return this.user.role == "application" ? true : this._hasAccess(data, this.user);
    }

    set modelName (name){
        this.name = name;
        this.prisma = prisma[name];
        this.fields = this.prisma.fields;
    }

    static Error = ErrorResponse;
}

module.exports = {Model, QueryBuilder, prisma, rls};