const { QueryBuilder, prisma, prismaTransaction } = require("./QueryBuilder");
const {acl} = require('../rapidd/rapidd');
const {ErrorResponse} = require('./Api');

/**
 * Base Model class for Rapidd ORM operations
 * Provides CRUD operations with built-in ACL (Access Control List) support
 *
 * @example
 * class Users extends Model {
 *     constructor(options) {
 *         super('users', options);
 *     }
 * }
 *
 * const users = new Users({ user: { id: '123', role: 'admin' } });
 * const result = await users.getMany({}, 'profile', 10, 0);
 */
class Model {
    /**
     * Create a new Model instance
     * @param {string} name - The Prisma model name (e.g., 'users', 'company_profiles')
     * @param {Object} [options={}] - Configuration options
     * @param {Object} [options.user] - The authenticated user context
     * @param {string} options.user.id - User ID for RLS and audit fields
     * @param {string} options.user.role - User role for ACL checks
     */
    constructor(name, options){
        this.modelName = name;
        this.queryBuilder = new QueryBuilder(name);
        this.acl = acl.model[name] || {};
        this.options = options || {}
        this.user = this.options.user || {'id': 1, 'role': 'application'};
        this.user_id = this.user ? this.user.id : null;
    }

    /**
     * Get the primary key field name for this model
     * For composite keys, returns fields joined with underscore
     * @returns {string}
     */
    get primaryKey(){
        const pkey = this.queryBuilder.getPrimaryKey();
        return Array.isArray(pkey) ? pkey.join('_') : pkey;
    }

    /**
     * Get all fields for this model from DMMF
     * @returns {Object<string, Object>} Field definitions keyed by field name
     */
    get fields(){
        return this.queryBuilder.fields;
    }

    /** @private Build select clause */
    _select = (fields) => this.queryBuilder.select(fields);
    /** @private Build filter/where clause */
    _filter = (q) => this.queryBuilder.filter(q);
    /** @private Build include clause for relations */
    _include = (include) => this.queryBuilder.include(include, this.user);
    /** @private Transform data for create operation */
    _queryCreate = (data) => this.queryBuilder.create(data, this.user);
    /** @private Transform data for update operation */
    _queryUpdate = (id, data) => this.queryBuilder.update(id, data, this.user);

    // ACL METHODS
    /** @private Check if user can create records */
    _canCreate = () => this.acl.canCreate(this.user);
    /** @private Get access filter from ACL */
    _getAccessFilter = () => this.acl.getAccessFilter?.(this.user);
    /** @private Get update filter from ACL */
    _getUpdateFilter = () => this.acl.getUpdateFilter(this.user);
    /** @private Get delete filter from ACL */
    _getDeleteFilter = () => this.acl.getDeleteFilter(this.user);
    /** @private Get fields to omit from response */
    _omit = () => this.queryBuilder.omit(this.user);

    /**
     * Internal method to fetch multiple records with filtering and pagination
     * @param {Object} [q={}] - Filter query object
     * @param {string|Object} [include=""] - Relations to include (comma-separated or object)
     * @param {number} [limit=25] - Maximum records to return
     * @param {number} [offset=0] - Number of records to skip
     * @param {string} [sortBy] - Field to sort by (supports dot notation for relations)
     * @param {'asc'|'desc'} [sortOrder="asc"] - Sort direction
     * @param {Object} [options={}] - Additional Prisma options
     * @returns {Promise<{data: Object[], meta: {take: number, skip: number, total: number}}>}
     * @throws {ErrorResponse} 400 if sortBy field is invalid
     * @protected
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
     * Internal method to fetch a single record by primary key
     * Performs parallel permission check to distinguish 404 vs 403 errors
     * @param {string|number} id - The primary key value
     * @param {string|Object} [include] - Relations to include
     * @param {Object} [options={}] - Additional Prisma options
     * @param {Object} [options.omit] - Fields to omit from response
     * @returns {Promise<Object>} The found record
     * @throws {ErrorResponse} 404 if record not found
     * @throws {ErrorResponse} 403 if user lacks permission to access
     * @protected
     */
    _get = async (id, include, options = {}) =>{
        const {omit, ..._options} = options;
        // Parallel queries: one for data, one for permission check
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
     * Internal method to create a new record
     * @param {Object} data - The record data (may include nested relations)
     * @param {Object} [options={}] - Additional Prisma options
     * @returns {Promise<Object>} The created record with all relations
     * @throws {ErrorResponse} 403 if user lacks create permission
     * @protected
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
     * Internal method to update an existing record
     * Automatically removes createdAt/createdBy from update data
     * @param {string|number} id - The primary key value
     * @param {Object} data - The update data (may include nested relations)
     * @param {Object} [options={}] - Additional Prisma options
     * @returns {Promise<Object>} The updated record with all relations
     * @throws {ErrorResponse} 403 if user lacks update permission
     * @protected
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
     * Internal method to create or update a record based on unique key
     * @param {Object} data - The record data
     * @param {string} [unique_key=this.primaryKey] - The unique field to match on
     * @param {Object} [options={}] - Additional Prisma options
     * @returns {Promise<Object>} The created or updated record with all relations
     * @protected
     */
    async _upsert(data, unique_key = this.primaryKey, options = {}){
        // Deep clone to avoid mutation of original data
        const createData = JSON.parse(JSON.stringify(data));
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
     * Internal method to count records matching a filter
     * @param {Object} [q={}] - Filter query object
     * @returns {Promise<number>} The count of matching records
     * @protected
     */
    _count = async (q = {}) => {
        return await this.prisma.count({
            'where': this.filter(q)
        });
    }

    /**
     * Internal method to delete a record by primary key
     * @param {string|number} id - The primary key value
     * @param {Object} [options={}] - Additional Prisma options
     * @returns {Promise<Object>} The deleted record
     * @throws {ErrorResponse} 403 if user lacks delete permission
     * @protected
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
     * Fetch multiple records with filtering, pagination, and sorting
     * @param {Object} [q={}] - Filter query object
     * @param {string|Object} [include=""] - Relations to include
     * @param {number} [limit=25] - Maximum records to return
     * @param {number} [offset=0] - Number of records to skip
     * @param {string} [sortBy] - Field to sort by
     * @param {'asc'|'desc'} [sortOrder="asc"] - Sort direction
     * @returns {Promise<{data: Object[], meta: {take: number, skip: number, total: number}}>}
     */
    async getMany(q = {}, include = "", limit = 25, offset = 0, sortBy = this.primaryKey, sortOrder = "asc"){
        return await this._getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder);
    }

    /**
     * Fetch a single record by primary key
     * @param {string|number} id - The primary key value
     * @param {string|Object} [include] - Relations to include
     * @param {Object} [options={}] - Additional Prisma options
     * @returns {Promise<Object>} The found record
     * @throws {ErrorResponse} 404 if not found, 403 if no permission
     */
    async get(id, include, options = {}){
        return await this._get(id, include, options);
    }

    /**
     * Update an existing record by primary key
     * @param {string|number} id - The primary key value
     * @param {Object} data - The update data
     * @param {Object} [options={}] - Additional Prisma options
     * @returns {Promise<Object>} The updated record
     * @throws {ErrorResponse} 403 if no permission
     */
    async update(id, data, options = {}){
        return await this._update(id, data, options);
    }

    /**
     * Create or update a record based on unique key
     * @param {Object} data - The record data
     * @param {string} [unique_key=this.primaryKey] - The unique field to match on
     * @param {Object} [options={}] - Additional Prisma options
     * @returns {Promise<Object>} The created or updated record
     */
    async upsert(data, unique_key = this.primaryKey, options = {}){
        return await this._upsert(data, unique_key, options);
    }

    /**
     * Count records matching a filter
     * @param {Object} [q={}] - Filter query object
     * @returns {Promise<number>} The count of matching records
     */
    async count(q = {}) {
        return await this._count(q);
    }

    /**
     * Delete a record by primary key
     * @param {string|number} id - The primary key value
     * @param {Object} [options={}] - Additional Prisma options
     * @returns {Promise<Object>} The deleted record
     * @throws {ErrorResponse} 403 if no permission
     */
    async delete(id, options = {}){
        return await this._delete(id, options);
    }

    /**
     * Build a select clause for queries
     * @param {string[]|Object} [fields] - Fields to select
     * @returns {Object} Prisma select object
     */
    select(fields){
        return this._select(fields);
    }

    /**
     * Build a filter/where clause with ACL applied
     * @param {string|Object} include - Filter specification
     * @returns {Object} Prisma where object with access filters
     */
    filter(include){
        return {...this._filter(include), ...this.getAccessFilter()};
    }

    /**
     * Build an include clause for relations
     * @param {string|Object} include - Relations to include
     * @returns {Object} Prisma include object
     */
    include(include){
        return this._include(include);
    }

    /**
     * Build an orderBy clause
     * @param {string} sortBy - Field to sort by
     * @param {'asc'|'desc'} sortOrder - Sort direction
     * @returns {Object} Prisma orderBy object
     */
    sort(sortBy, sortOrder) {
        return this.queryBuilder.sort(sortBy, sortOrder);
    }

    /**
     * Normalize and validate the limit (take) value
     * @param {number} limit - Requested limit
     * @returns {number} Validated limit value
     */
    take(limit){
        return this.queryBuilder.take(Number(limit));
    }

    /**
     * Normalize and validate the offset (skip) value
     * @param {number|string} offset - Requested offset
     * @returns {number} Validated offset value (minimum 0)
     */
    skip(offset){
        const parsed = parseInt(offset);
        if(isNaN(parsed) || parsed < 0){
            return 0;
        }
        return parsed;
    }

    /**
     * Get access filter for read operations
     * Returns empty filter for 'application' role or when ACL returns true
     * @returns {Object} Prisma where clause for access control
     */
    getAccessFilter(){
        const filter = this._getAccessFilter();
        if(this.user.role == "application" || filter === true){
            return {};
        }
        return filter;
    }

    /**
     * Check if user has permission to create records
     * @returns {boolean} True if user can create
     */
    canCreate() {
        if(this.user.role == "application") return true;
        return this._canCreate();
    }

    /**
     * Get filter for update operations
     * Returns empty filter for 'application' role or when ACL returns true
     * @returns {Object|false} Prisma where clause or false if denied
     */
    getUpdateFilter(){
        const filter = this._getUpdateFilter();
        if(this.user.role == "application" || filter === true){
            return {};
        }
        return filter;
    }

    /**
     * Get filter for delete operations
     * Returns empty filter for 'application' role or when ACL returns true
     * @returns {Object|false} Prisma where clause or false if denied
     */
    getDeleteFilter(){
        const filter = this._getDeleteFilter();
        if(this.user.role == "application" || filter === true){
            return {};
        }
        return filter;
    }

    /**
     * Set the model name and initialize the Prisma client delegate
     * @param {string} name - The Prisma model name
     */
    set modelName (name){
        this.name = name;
        this.prisma = prisma[name];
    }

    /** @type {Object[]} Related objects configuration (deprecated, use DMMF) */
    static relatedObjects = [];

    /** @type {typeof ErrorResponse} Error class for throwing API errors */
    static Error = ErrorResponse;
}

module.exports = {Model, QueryBuilder, prisma};