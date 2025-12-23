const { QueryBuilder, prisma, prismaTransaction } = require("./QueryBuilder");
const { acl } = require('../rapidd/rapidd');
const { modelMiddleware } = require('../rapidd/modelMiddleware');
const { ErrorResponse } = require('./Api');

/**
 * Base Model class for Rapidd ORM operations
 * Provides CRUD operations with built-in ACL (Access Control List) and middleware support
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
 *
 * @example
 * // Register middleware to auto-add timestamps
 * Model.middleware.use('before', 'create', async (ctx) => {
 *     ctx.data.createdAt = new Date();
 *     ctx.data.createdBy = ctx.user?.id;
 *     return ctx;
 * });
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
    constructor(name, options) {
        this.modelName = name;
        this.queryBuilder = this.constructor.QueryBuilder ?? new QueryBuilder(name);
        this.acl = acl.model[name] || {};
        this.options = options || {};
        this.user = this.options.user || { 'id': 1, 'role': 'application' };
        this.user_id = this.user ? this.user.id : null;
    }

    /**
     * Get the primary key field name for this model
     * For composite keys, returns fields joined with underscore
     * @returns {string}
     */
    get primaryKey() {
        const pkey = this.queryBuilder.getPrimaryKey();
        return Array.isArray(pkey) ? pkey.join('_') : pkey;
    }

    /**
     * Get all fields for this model from DMMF
     * @returns {Object<string, Object>} Field definitions keyed by field name
     */
    get fields() {
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
     * Execute middleware chain for an operation
     * @param {'before'|'after'} hook - Hook type
     * @param {string} operation - Operation name
     * @param {Object} params - Operation parameters
     * @returns {Promise<Object>} Modified context
     * @private
     */
    async _executeMiddleware(hook, operation, params) {
        const context = modelMiddleware.createContext(this, operation, params, this.user);
        return await modelMiddleware.execute(hook, operation, context);
    }

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
    _getMany = async (q = {}, include = "", limit = 25, offset = 0, sortBy = this.primaryKey, sortOrder = "asc", options = {}) => {
        const take = this.take(Number(limit));
        const skip = this.skip(Number(offset));

        sortBy = sortBy?.trim();
        sortOrder = sortOrder?.trim();

        if (!sortBy.includes('.') && this.fields[sortBy] == undefined) {
            throw new ErrorResponse(400, "invalid_sort_field", { sortBy, modelName: this.constructor.name });
        }

        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'getMany', {query: q, include, take, skip, sortBy, sortOrder, options});

        if (beforeCtx.abort) {
            return beforeCtx.result || { data: [], meta: { take, skip, total: 0 } };
        }

        // Query the database using Prisma with filters, pagination, and limits
        const [data, total] = await prismaTransaction([
            (tx) => tx[this.name].findMany({
                'where': this.filter(beforeCtx.query || q),
                'include': this.include(beforeCtx.include || include),
                'take': beforeCtx.take || take,
                'skip': beforeCtx.skip || skip,
                'orderBy': this.sort(beforeCtx.sortBy || sortBy, beforeCtx.sortOrder || sortOrder),
                'omit': this._omit(),
                ...(beforeCtx.options || options)
            }),
            (tx) => tx[this.name].count({
                'where': this.filter(beforeCtx.query || q)
            })
        ]);

        const result = { data, meta: { take: beforeCtx.take || take, skip: beforeCtx.skip || skip, total } };

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'getMany', { result });
        return afterCtx.result || result;
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
    _get = async (id, include, options = {}) => {
        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'get', { id, include, options });

        if (beforeCtx.abort) {
            return beforeCtx.result;
        }

        const { omit, ..._options } = beforeCtx.options || options;
        const targetId = beforeCtx.id || id;

        // Parallel queries: one for data, one for permission check
        const _response = this.prisma.findUnique({
            'where': {
                [this.primaryKey]: targetId,
            },
            'include': this.include(beforeCtx.include || include),
            'omit': { ...this._omit(), ...omit },
            ..._options
        });

        const _checkPermission = this.prisma.findUnique({
            'where': {
                [this.primaryKey]: targetId,
                ...this.getAccessFilter()
            },
            'select': {
                [this.primaryKey]: true
            }
        });

        const [response, checkPermission] = await Promise.all([_response, _checkPermission]);
        if (response) {
            if (checkPermission) {
                if (response.id != checkPermission?.id) {
                    throw new ErrorResponse(403, "no_permission");
                }
            } else {
                throw new ErrorResponse(403, "no_permission");
            }
        } else {
            throw new ErrorResponse(404, "record_not_found");
        }

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'get', { id: targetId, result: response });
        return afterCtx.result || response;
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

        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'create', { data: { ...data }, options });

        if (beforeCtx.abort) {
            return beforeCtx.result;
        }

        const createData = beforeCtx.data || data;

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS
        this._queryCreate(createData);

        // CREATE
        const result = await this.prisma.create({
            'data': createData,
            ...(beforeCtx.options || options)
        });

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'create', { data: createData, result });
        return afterCtx.result || result;
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

        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'update', { id, data: { ...data }, options });

        if (beforeCtx.abort) {
            return beforeCtx.result;
        }

        const targetId = beforeCtx.id || id;
        const updateData = beforeCtx.data || data;

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS
        this._queryUpdate(targetId, updateData);

        const result = await this.prisma.update({
            'where': {
                [this.primaryKey]: targetId,
                ...updateFilter
            },
            'data': updateData,
            'include': this.include('ALL'),
            ...(beforeCtx.options || options)
        });

        if (!result) {
            throw new ErrorResponse(403, "no_permission");
        }

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'update', { id: targetId, data: updateData, result });
        return afterCtx.result || result;
    }

    /**
     * Internal method to create or update a record based on unique key
     * @param {Object} data - The record data
     * @param {string} [unique_key=this.primaryKey] - The unique field to match on
     * @param {Object} [options={}] - Additional Prisma options
     * @returns {Promise<Object>} The created or updated record with all relations
     * @protected
     */
    async _upsert(data, unique_key = this.primaryKey, options = {}) {
        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'upsert', { data: { ...data }, unique_key, options });
        
        if (beforeCtx.abort) {
            return beforeCtx.result;
        }

        const upsertData = beforeCtx.data || data;
        const targetKey = beforeCtx.unique_key || unique_key;

        // Deep clone to avoid mutation of original data
        const createData = JSON.parse(JSON.stringify(upsertData));
        const updateData = JSON.parse(JSON.stringify(upsertData));
        this.queryBuilder.create(createData, this.user);
        const updatePrimaryKey = updateData[this.primaryKey];
        this.queryBuilder.update(updatePrimaryKey, updateData, this.user);       

        const result = await this.prisma.upsert({
            'where': {
                [targetKey]: upsertData[targetKey]
            },
            'create': createData,
            'update': updateData,
            ...(beforeCtx.options || options)
        });

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'upsert', { data: upsertData, result });
        return afterCtx.result || result;
    }

    /**
     * Internal method to create or update multiple records based on unique key
     * Uses a transaction to atomically handle creates and updates
     * @param {Object[]} data - Array of record data
     * @param {string} [unique_key=this.primaryKey] - The unique field to match on
     * @param {Object} [options={}] - Additional Prisma options
     * @param {boolean} [validateRelation=false] - Whether to validate relations
     * @returns {Promise<Object>} Result object with created and updated counts
     * @protected
     */
    async _upsertMany(data, unique_key = this.primaryKey, options = {}, validateRelation = false) {
        if (!Array.isArray(data) || data.length === 0) {
            return { created: 0, updated: 0, total: 0 };
        }
        const accessFilter = this.getAccessFilter();
        const canCreate = this.canCreate();
        const updateFilter = this.getUpdateFilter();

        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'upsertMany', { data, unique_key, options });
        
        if (beforeCtx.abort) {
            return beforeCtx.result;
        }

        const upsertData = beforeCtx.data || data;
        const targetKey = beforeCtx.unique_key || unique_key;

        // Extract unique key values to check which records exist
        const uniqueValues = upsertData.map(record => record[targetKey]).filter(v => v != null);

        const result = await prismaTransaction(async (tx) => {
            // Find existing records
            const existingRecords = await tx[this.name].findMany({
                'where': {
                    [targetKey]: {
                        'in': uniqueValues
                    },
                    ...accessFilter
                },
                'select': {
                    [targetKey]: true
                }
            });

            const existingKeys = existingRecords.map(r => r[targetKey]);

            // Separate data into creates and updates
            const createRecords = [];
            const updateRecords = [];

            for (const record of upsertData) {
                if (existingKeys.find(e => e == record[targetKey])) {
                    // Record exists, prepare for update
                    const updatePrimaryKey = record[this.primaryKey];
                    this.queryBuilder.update(updatePrimaryKey, record, this.user);
                    updateRecords.push(record);
                } else {
                    // Record doesn't exist, prepare for create
                    if(validateRelation) {
                        this.queryBuilder.create(record, this.user);
                    }
                    createRecords.push(record);
                }
            }

            let createdCount = 0;
            let updatedCount = 0;

            // Batch create
            if (createRecords.length > 0) {
                if(canCreate === false) {
                    throw new ErrorResponse(403, "no_permission_to_create");
                }
                if(validateRelation === false) {
                    const createResult = await tx[this.name].createMany({
                        'data': createRecords,
                        'skipDuplicates': true,
                        ...(beforeCtx.options || options)
                    });
                    createdCount = createResult.count;
                }
                else {
                    for (const createRecord of createRecords) {
                        await tx[this.name].create({
                            'data': createRecord,
                            ...(beforeCtx.options || options)
                        });
                        createdCount++;
                    }
                }
            }

            // Batch update
            if (updateRecords.length > 0) {
                if (updateFilter === false) {
                    throw new ErrorResponse(403, "no_permission_to_update");
                }
                for (const updateRecord of updateRecords) {
                    await tx[this.name].update({
                        'where': {
                            [targetKey]: updateRecord[targetKey],
                            ...updateFilter,
                        },
                        'data': updateRecord,
                        ...(beforeCtx.options || options)
                    });
                    updatedCount++;
                }
            }

            return {
                created: createdCount,
                updated: updatedCount,
                total: createdCount + updatedCount
            };
        });

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'upsertMany', { data: upsertData, result });
        return afterCtx.result || result;
    }

    /**
     * Internal method to count records matching a filter
     * @param {Object} [q={}] - Filter query object
     * @returns {Promise<number>} The count of matching records
     * @protected
     */
    _count = async (q = {}) => {
        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'count', { query: q });

        if (beforeCtx.abort) {
            return beforeCtx.result || 0;
        }

        const result = await this.prisma.count({
            'where': this.filter(beforeCtx.query || q)
        });

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'count', { query: beforeCtx.query || q, result });
        return afterCtx.result ?? result;
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

        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'delete', { id, options });

        if (beforeCtx.abort) {
            return beforeCtx.result;
        }

        const targetId = beforeCtx.id || id;

        // Support soft delete via middleware
        if (beforeCtx.softDelete && beforeCtx.data) {
            try {
                const result = await this.prisma.update({
                    'where': {
                        [this.primaryKey]: targetId,
                        ...deleteFilter
                    },
                    'data': beforeCtx.data,
                    'select': {
                        [this.primaryKey]: true
                    },
                    ...(beforeCtx.options || options)
                });

                const afterCtx = await this._executeMiddleware('after', 'delete', { id: targetId, result, softDelete: true });
                return afterCtx.result || result;
            } catch (error) {
                throw new ErrorResponse(403, "no_permission", { error });
            }
        }

        const result = await this.prisma.delete({
            'where': {
                [this.primaryKey]: targetId,
                ...deleteFilter
            },
            'select': {
                [this.primaryKey]: true
            },
            ...(beforeCtx.options || options)
        });

        if (!result) {
            throw new ErrorResponse(403, "no_permission");
        }

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'delete', { id: targetId, result });
        return afterCtx.result || result;
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
    async getMany(q = {}, include = "", limit = 25, offset = 0, sortBy = this.primaryKey, sortOrder = "asc") {
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
    async get(id, include, options = {}) {
        return await this._get(id, include, options);
    }

    /**
     * Create a new record
     * @param {Object} data - The record data
     * @param {Object} [options={}] - Additional Prisma options
     * @returns {Promise<Object>} The created record
     * @throws {ErrorResponse} 403 if no permission
     */
    async create(data, options = {}) {
        return await this._create(data, options);
    }

    /**
     * Update an existing record by primary key
     * @param {string|number} id - The primary key value
     * @param {Object} data - The update data
     * @param {Object} [options={}] - Additional Prisma options
     * @returns {Promise<Object>} The updated record
     * @throws {ErrorResponse} 403 if no permission
     */
    async update(id, data, options = {}) {
        return await this._update(id, data, options);
    }

    /**
     * Create or update a record based on unique key
     * @param {Object} data - The record data
     * @param {string} [unique_key=this.primaryKey] - The unique field to match on
     * @param {Object} [options={}] - Additional Prisma options
     * @returns {Promise<Object>} The created or updated record
     */
    async upsert(data, unique_key = this.primaryKey, options = {}) {
        return await this._upsert(data, unique_key, options);
    }

    /**
     * Create or update multiple records based on unique key
     * Performs atomic batch operations with transaction support
     * @param {Object[]} data - Array of record data
     * @param {string} [unique_key=this.primaryKey] - The unique field to match on
     * @param {Object} [options={}] - Additional Prisma options
     * @returns {Promise<Object>} Result with created, updated, and total counts
     * @example
     * const result = await contact.upsertMany([
     *     { contact_id: '1', first_name: 'John' },
     *     { contact_id: '2', first_name: 'Jane' }
     * ], 'contact_id');
     * // { created: 1, updated: 1, total: 2 }
     */
    async upsertMany(data, unique_key = this.primaryKey, options = {}) {
        return await this._upsertMany(data, unique_key, options);
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
    async delete(id, options = {}) {
        return await this._delete(id, options);
    }

    /**
     * Build a select clause for queries
     * @param {string[]|Object} [fields] - Fields to select
     * @returns {Object} Prisma select object
     */
    select(fields) {
        return this._select(fields);
    }

    /**
     * Build a filter/where clause with ACL applied
     * @param {string|Object} include - Filter specification
     * @returns {Object} Prisma where object with access filters
     */
    filter(include) {
        return { ...this._filter(include), ...this.getAccessFilter() };
    }

    /**
     * Build an include clause for relations
     * @param {string|Object} include - Relations to include
     * @returns {Object} Prisma include object
     */
    include(include) {
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
    take(limit) {
        return this.queryBuilder.take(Number(limit));
    }

    /**
     * Normalize and validate the offset (skip) value
     * @param {number|string} offset - Requested offset
     * @returns {number} Validated offset value (minimum 0)
     */
    skip(offset) {
        const parsed = parseInt(offset);
        if (isNaN(parsed) || parsed < 0) {
            return 0;
        }
        return parsed;
    }

    /**
     * Get access filter for read operations
     * Returns empty filter for 'application' role or when ACL returns true
     * @returns {Object} Prisma where clause for access control
     */
    getAccessFilter() {
        const filter = this._getAccessFilter();
        if (this.user.role == "application" || filter === true) {
            return {};
        }
        return filter;
    }

    /**
     * Check if user has permission to create records
     * @returns {boolean} True if user can create
     */
    canCreate() {
        if (this.user.role == "application") return true;
        return this._canCreate();
    }

    /**
     * Get filter for update operations
     * Returns empty filter for 'application' role or when ACL returns true
     * @returns {Object|false} Prisma where clause or false if denied
     */
    getUpdateFilter() {
        const filter = this._getUpdateFilter();
        if (this.user.role == "application" || filter === true) {
            return {};
        }
        return filter;
    }

    /**
     * Get filter for delete operations
     * Returns empty filter for 'application' role or when ACL returns true
     * @returns {Object|false} Prisma where clause or false if denied
     */
    getDeleteFilter() {
        const filter = this._getDeleteFilter();
        if (this.user.role == "application" || filter === true) {
            return {};
        }
        return filter;
    }

    /**
     * Removes relation data from a data object
     * @param {*} data 
     */
    removeRelationData(data){
        for(let i = 0; i < this.queryBuilder.relatedObjects.length; i++){
            delete data[this.queryBuilder.relatedObjects[i].name];
        }
        return data;
    }

    /**
     * Set the model name and initialize the Prisma client delegate
     * @param {string} name - The Prisma model name
     */
    set modelName(name) {
        this.name = name;
        this.prisma = prisma[name];
    }

    /** @type {typeof ErrorResponse} Error class for throwing API errors */
    static Error = ErrorResponse;

    /**
     * Access to the model middleware system
     * @type {Object}
     * @example
     * Model.middleware.use('before', 'create', async (ctx) => {
     *     ctx.data.createdAt = new Date();
     *     return ctx;
     * });
     */
    static middleware = modelMiddleware;

    static prismaTransaction = prismaTransaction;
}

module.exports = { Model, QueryBuilder, prisma };