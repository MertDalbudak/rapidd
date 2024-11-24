const { QueryBuilder, prisma } = require("./QueryBuilder");
const {ErrorResponse} = require('./Api');

class Model {
    /**
         * @param {string} name 
         * @param {{'user': {}}} options 
         */
    constructor(name, options){
        this.modelName = name;
        this.options = options || {}
        this.user = this.options.user || {'id': 2, 'role': 'admin'};
        this.user_id = this.user ? this.user.id : null;
    }

    _select = (q) => this.constructor.queryBuilder.select();
    _filter = (q) => this.constructor.queryBuilder.filter(q);
    _include = (include) => this.constructor.queryBuilder.include(include, this.user);
    _getAccessFilter = () => this.constructor.queryBuilder.getAccessFilter(this.user);
    _hasAccess = (data) => this.constructor.queryBuilder.hasAccess(data, this.user);
    _omit = () => this.constructor.queryBuilder.omit(this.user);

    /**
     * 
     * @param {string} q 
     * @param {string} include 
     * @param {number} limit 
     * @param {number} offset 
     * @param {string} sortBy 
     * @param {string} sortOrder 
     * @returns {Object[]}
     */
    _getAll = async (q = {}, include = {}, limit = 25, offset = 0, sortBy = "id", sortOrder = "asc", options = {})=>{
        // Offset and Limit
        const take = this.take(limit);
        const skip = this.skip(offset);

        // Handle sorting
        sortBy = sortBy.trim();
        sortOrder = sortOrder.trim();
        if (this.fields[sortBy] == undefined) {
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
     * @returns {{} | null}
     */
    _get = async (id, include, options = {}) =>{
        // To determine if the record is inaccessible, either due to non-existence or insufficient permissions, two simultaneous queries are performed.
        const _response = this.prisma.findUnique({
            'where': {
                'id': parseInt(id),
                ...this._getAccessFilter()
            },
            'include': this.include(include),
            'omit': this._omit(),
            ...options
        });
        const _checkExistence = this.prisma.findUnique({
            'where': {
                'id': parseInt(id)
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
     * @returns {Object}
     */
    _create = async (data, options = {}) => {
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
     * @returns {Object}
     */
    _update = async (id, data, options = {}) => {
        // GET DATA FIRST
        const current_data = await this._get(id, "ALL");

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS
        this.constructor.queryBuilder.update(id, data, this.user_id);

        return await this.prisma.update({
            'data': data,
            'where': {
                'id': parseInt(id)
            },
            'include': this.include('ALL'),
            ...options
        });
    }

    /**
     * @param {number} id 
     * @returns {boolean}
     */
    _delete = async (id, options = {}) => {
        // GET DATA FIRST
        const current_data = this._get(id);

        return await this.prisma.delete({
            where: {
                id: parseInt(id)
            },
            'select': this.select(),
            ...options
        });
    }

    /**
     * 
     * @param {string} q 
     * @param {string} include 
     * @param {number} limit 
     * @param {number} offset 
     * @param {string} sortBy 
     * @param {string} sortOrder 
     * @returns {Object[]}
     */
    async getAll(...args){
        return await this._getAll(...args);
    }

    /**
     * @param {number} id 
     * @param {string | Object} include 
     * @returns {{} | null}
     */
    async get(id, include, options = {}){
        return await this._get(id, include, options);
    }

    /**
     * @param {number} id 
     * @param {{}} data 
     * @returns {Object}
     */
    async update(id, data, options = {}){
        return await this._update(id, data, options);
    }

    /**
     * @param {number} id 
     * @returns {Object}
     */
    async delete(id, data, options = {}){
        return await this._delete(id, data, options);
    }

    select(){
        return this._select();
    }
    filter(include){
        return {...this._filter(include), ...this._getAccessFilter()};
    }
    include(include){
        return this._include(include);
    }
    sort(sortBy, sortOrder) {
        return this.constructor.queryBuilder.sort(sortBy, sortOrder);
    }
    take(limit){
        return this.constructor.queryBuilder.take(limit);
    }
    skip(offset){
        return isNaN(offset) ? 0 : parseInt(offset)
    }

    set modelName (name){
        this.name = name;
        this.prisma = prisma[name];
        this.fields = this.prisma.fields;
    }

    static relatedObjects = [];
    static access_rule = [];
    static Error = ErrorResponse;
}

module.exports = {Model, QueryBuilder, prisma};