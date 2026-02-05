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
        this.user = this.options.user || { 'id': 'system', 'role': 'application' };
        this.user_id = this.user ? this.user.id : null;
    }

    /**
     * Get the primary key field name for this model
     * For composite keys, returns fields joined with underscore (Prisma composite key format)
     * @returns {string}
     */
    get primaryKey() {
        const pkey = this.queryBuilder.getPrimaryKey();
        return Array.isArray(pkey) ? pkey.join('_') : pkey;
    }

    /**
     * Get raw primary key field(s) from DMMF
     * Returns string for simple PKs, string[] for composite PKs
     * @returns {string|string[]}
     */
    get primaryKeyFields() {
        return this.queryBuilder.getPrimaryKey();
    }

    /**
     * Get the default sort field for this model
     * For composite keys, returns the first field
     * @returns {string}
     */
    get defaultSortField() {
        const pk = this.primaryKeyFields;
        return Array.isArray(pk) ? pk[0] : pk;
    }

    /**
     * Whether this model has a composite primary key
     * @returns {boolean}
     */
    get isCompositePK() {
        return Array.isArray(this.primaryKeyFields);
    }

    /**
     * Build a Prisma where clause for the given ID value(s)
     * For simple PKs: { id: value }
     * For composite PKs with object: { email_companyId: { email: '...', companyId: '...' } }
     * For composite PKs with tilde-delimited string: parses "val1~val2" into fields
     * @param {string|number|Object} id - The primary key value(s)
     * @returns {Object} Prisma where clause
     */
    buildWhereId(id) {
        const pkFields = this.primaryKeyFields;

        if (!Array.isArray(pkFields)) {
            // Simple PK
            return { [pkFields]: id };
        }

        // Composite PK
        const compositeKeyName = pkFields.join('_');

        if (typeof id === 'object' && id !== null) {
            // Already an object with field values
            return { [compositeKeyName]: id };
        }

        if (typeof id === 'string' && id.includes('~')) {
            // Tilde-delimited string from URL
            const parts = id.split('~');
            if (parts.length !== pkFields.length) {
                throw new ErrorResponse(400, "invalid_composite_key", {
                    expected: pkFields,
                    received: parts.length
                });
            }
            const values = {};
            pkFields.forEach((field, i) => {
                values[field] = this.#coercePrimaryKeyValue(field, parts[i]);
            });
            return { [compositeKeyName]: values };
        }

        throw new ErrorResponse(400, "invalid_composite_key_format", {
            message: "Composite key requires either an object or tilde-separated string",
            fields: pkFields
        });
    }

    /**
     * Build a Prisma where clause for a unique key (used in upsert)
     * @param {string|string[]} uniqueKey - The unique field(s)
     * @param {Object} data - Record data containing the key values
     * @returns {Object} Prisma where clause
     */
    buildWhereUniqueKey(uniqueKey, data) {
        if (Array.isArray(uniqueKey)) {
            const compositeKeyName = uniqueKey.join('_');
            const compositeKeyValues = {};
            uniqueKey.forEach(key => {
                compositeKeyValues[key] = data[key];
            });
            return { [compositeKeyName]: compositeKeyValues };
        }
        return { [uniqueKey]: data[uniqueKey] };
    }

    /**
     * Build a Prisma select clause for primary key fields
     * @returns {Object} Prisma select object
     * @private
     */
    #buildPrimaryKeySelect() {
        const pkFields = this.primaryKeyFields;
        if (!Array.isArray(pkFields)) {
            return { [pkFields]: true };
        }
        return pkFields.reduce((acc, f) => { acc[f] = true; return acc; }, {});
    }

    /**
     * Compare two records by their primary key fields
     * @param {Object} a - First record
     * @param {Object} b - Second record
     * @returns {boolean} True if PKs match
     * @private
     */
    #primaryKeysMatch(a, b) {
        if (!a || !b) return false;
        const pkFields = this.primaryKeyFields;
        const fields = Array.isArray(pkFields) ? pkFields : [pkFields];
        return fields.every(f => a[f] != null && String(a[f]) === String(b[f]));
    }

    /**
     * Coerce a string PK value to the correct type based on DMMF field type
     * @param {string} fieldName - The field name
     * @param {string} value - The string value to coerce
     * @returns {*} Coerced value
     * @private
     */
    #coercePrimaryKeyValue(fieldName, value) {
        const field = this.fields[fieldName];
        if (!field) return value;
        if (field.type === 'Int') return parseInt(value, 10);
        if (field.type === 'Float' || field.type === 'Decimal') return parseFloat(value);
        if (field.type === 'Boolean') return value === 'true';
        return value;
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
        const context = modelMiddleware.createContext(this.name, operation, params, this.user);
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
    _getMany = async (q = {}, include = "", limit = 25, offset = 0, sortBy = this.defaultSortField, sortOrder = "asc", options = {}) => {
        const take = this.take(Number(limit));
        const skip = this.skip(Number(offset));

        sortBy = sortBy?.trim();
        sortOrder = sortOrder?.trim();

        // Validate sort field - fall back to default for composite PK names
        if (!sortBy.includes('.') && this.fields[sortBy] == undefined) {
            // If the sortBy is a composite key name (e.g., "email_companyId"), use first PK field
            if (sortBy === this.primaryKey && this.isCompositePK) {
                sortBy = this.defaultSortField;
            } else {
                throw new ErrorResponse(400, "invalid_sort_field", { sortBy, modelName: this.constructor.name });
            }
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
        const whereId = this.buildWhereId(targetId);

        // Parallel queries: one for data, one for permission check
        const _response = this.prisma.findUnique({
            'where': whereId,
            'include': this.include(beforeCtx.include || include),
            'omit': { ...this._omit(), ...omit },
            ..._options
        });

        const _checkPermission = this.prisma.findUnique({
            'where': {
                ...whereId,
                ...this.getAccessFilter()
            },
            'select': this.#buildPrimaryKeySelect()
        });

        const [response, checkPermission] = await Promise.all([_response, _checkPermission]);
        if (response) {
            if (checkPermission) {
                if (!this.#primaryKeysMatch(response, checkPermission)) {
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

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS (returns new transformed object)
        const transformedData = this._queryCreate(createData);

        // CREATE
        const result = await this.prisma.create({
            'data': transformedData,
            'include': this.include('ALL'),
            ...(beforeCtx.options || options)
        });

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'create', { data: transformedData, result });
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
        // Create a copy to avoid mutating the caller's data
        const inputData = { ...data };
        delete inputData.createdAt;
        delete inputData.createdBy;

        // CHECK UPDATE PERMISSION
        const updateFilter = this.getUpdateFilter();
        if (updateFilter === false) {
            throw new ErrorResponse(403, "no_permission_to_update");
        }

        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'update', { id, data: { ...inputData }, options });

        if (beforeCtx.abort) {
            return beforeCtx.result;
        }

        const targetId = beforeCtx.id || id;
        const updateData = beforeCtx.data || inputData;

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS (returns new transformed object)
        const transformedData = this._queryUpdate(targetId, updateData);

        const result = await this.prisma.update({
            'where': {
                ...this.buildWhereId(targetId),
                ...updateFilter
            },
            'data': transformedData,
            'include': this.include('ALL'),
            ...(beforeCtx.options || options)
        });

        if (!result) {
            throw new ErrorResponse(403, "no_permission");
        }

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'update', { id: targetId, data: transformedData, result });
        return afterCtx.result || result;
    }

    /**
     * Internal method to create or update a record based on unique key
     * Supports both single and composite primary keys
     * @param {Object} data - The record data
     * @param {string|string[]} [unique_key=this.primaryKey] - The unique field(s) to match on
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

        // create() and update() are now pure - they return new objects without mutating input
        const createData = this.queryBuilder.create(upsertData, this.user);

        const updatePrimaryKey = Array.isArray(targetKey) ? targetKey[0] : this.primaryKey;
        const updateData = this.queryBuilder.update(updatePrimaryKey, upsertData, this.user);

        // Build where clause that supports composite keys
        const whereClause = this.buildWhereUniqueKey(targetKey, upsertData);

        const result = await this.prisma.upsert({
            'where': whereClause,
            'create': createData,
            'update': updateData,
            'include': this.include('ALL'),
            ...(beforeCtx.options || options)
        });

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'upsert', { data: upsertData, result });
        return afterCtx.result || result;
    }

    /**
     * Internal method to create or update multiple records based on unique key
     * Supports both transactional and non-transactional operations with optional relation validation
     * @param {Object[]} data - Array of record data
     * @param {string} [unique_key=this.primaryKey] - The unique field to match on
     * @param {Object} [prismaOptions={}] - Prisma database options
     * @param {Object} [options={}] - Operation options
     * @param {boolean} [options.validateRelation=false] - Whether to validate relations
     * @param {boolean} [options.transaction=true] - Whether to use a transaction (default true)
     * @param {number} [options.timeout=30000] - Transaction timeout in milliseconds
     * @returns {Promise<Object>} Result object with created and updated counts
     * @protected
     */
    async _upsertMany(data, unique_key = this.primaryKey, prismaOptions = {}, options = {}) {
        if (!Array.isArray(data) || data.length === 0) {
            return { created: 0, updated: 0, total: 0 };
        }

        // Extract operation-specific options
        const validateRelation = options.validateRelation ?? false;
        const useTransaction = options.transaction ?? true;
        const timeout = options.timeout ?? 30000;

        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'upsertMany', { data, unique_key, prismaOptions });
        
        if (beforeCtx.abort) {
            return beforeCtx.result;
        }

        const upsertData = beforeCtx.data || data;
        const targetKey = beforeCtx.unique_key || unique_key;
        const _prismaOptions = beforeCtx.prismaOptions || prismaOptions;

        // Define the upsert operation logic
        const executeUpsertMany = async (tx) => {
            // Find existing records - handle both simple and composite keys
            let existingRecords;
            if (Array.isArray(targetKey)) {
                // Composite key: use OR clause for lookup
                const whereConditions = upsertData
                    .map(record => {
                        const compositeKeyName = targetKey.join('_');
                        const values = {};
                        targetKey.forEach(k => { values[k] = record[k]; });
                        if (Object.values(values).some(v => v == null)) return null;
                        return { [compositeKeyName]: values };
                    })
                    .filter(Boolean);

                existingRecords = whereConditions.length > 0
                    ? await tx[this.name].findMany({
                        'where': { OR: whereConditions },
                        'select': targetKey.reduce((acc, k) => { acc[k] = true; return acc; }, {})
                    })
                    : [];
            } else {
                const uniqueValues = upsertData.map(record => record[targetKey]).filter(v => v != null);
                existingRecords = uniqueValues.length > 0
                    ? await tx[this.name].findMany({
                        'where': { [targetKey]: { 'in': uniqueValues } },
                        'select': { [targetKey]: true }
                    })
                    : [];
            }

            // Build existence check helper
            const existsInDb = (record) => {
                if (Array.isArray(targetKey)) {
                    return existingRecords.some(existing =>
                        targetKey.every(k => String(existing[k]) === String(record[k]))
                    );
                }
                return existingRecords.some(e => String(e[targetKey]) === String(record[targetKey]));
            };

            // Separate data into creates and updates, using pure create/update
            const createRecords = [];
            const updateRecords = [];

            for (const record of upsertData) {
                if (existsInDb(record)) {
                    // Record exists, prepare for update (pure - returns new object)
                    const updatePrimaryKey = Array.isArray(targetKey) ? targetKey[0] : this.primaryKey;
                    const transformedRecord = this.queryBuilder.update(record[updatePrimaryKey] || record[targetKey], record, this.user);
                    updateRecords.push({ original: record, transformed: transformedRecord });
                } else {
                    // Record doesn't exist, prepare for create
                    if (validateRelation) {
                        const transformedRecord = this.queryBuilder.create(record, this.user);
                        createRecords.push({ original: record, transformed: transformedRecord });
                    } else {
                        createRecords.push({ original: record, transformed: { ...record } });
                    }
                }
            }

            let createdCount = 0;
            let updatedCount = 0;
            const failed = [];

            // Batch create
            if (createRecords.length > 0) {
                if (validateRelation) {
                    for (const { transformed } of createRecords) {
                        try {
                            await tx[this.name].create({
                                'data': transformed,
                                ..._prismaOptions
                            });
                            createdCount++;
                        } catch (error) {
                            failed.push({ record: transformed, error });
                        }
                    }
                } else {
                    try {
                        const createResult = await tx[this.name].createMany({
                            'data': createRecords.map(r => r.transformed),
                            'skipDuplicates': true,
                            ..._prismaOptions
                        });
                        createdCount = createResult.count;
                    } catch (error) {
                        failed.push({ records: createRecords.map(r => r.transformed), error });
                    }
                }
            }
            // Batch update
            if (updateRecords.length > 0) {
                for (const { original, transformed } of updateRecords) {
                    try {
                        const whereClause = Array.isArray(targetKey)
                            ? this.buildWhereUniqueKey(targetKey, original)
                            : { [targetKey]: original[targetKey] };
                        await tx[this.name].update({
                            'where': whereClause,
                            'data': transformed,
                            ..._prismaOptions
                        });
                        updatedCount++;
                    } catch (error) {
                        failed.push({ record: transformed, error });
                    }
                }
            }

            return {
                created: createdCount,
                updated: updatedCount,
                failed,
                totalSuccess: createdCount + updatedCount,
                totalFailed: failed.length
            };
        };

        // Execute with or without transaction based on option
        const result = useTransaction 
            ? await prismaTransaction(executeUpsertMany, { timeout })
            : await executeUpsertMany(prisma);

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
        const whereId = this.buildWhereId(targetId);

        // Support soft delete via middleware
        if (beforeCtx.softDelete && beforeCtx.data) {
            const result = await this.prisma.update({
                'where': {
                    ...whereId,
                    ...deleteFilter
                },
                'data': beforeCtx.data,
                'select': this.select(),
                ...(beforeCtx.options || options)
            });

            const afterCtx = await this._executeMiddleware('after', 'delete', { id: targetId, result, softDelete: true });
            return afterCtx.result || result;
        }

        const result = await this.prisma.delete({
            'where': {
                ...whereId,
                ...deleteFilter
            },
            'select': this.select(),
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
    async getMany(q = {}, include = "", limit = 25, offset = 0, sortBy = this.defaultSortField, sortOrder = "asc") {
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
     * Performs atomic batch operations with optional transaction support
     * @param {Object[]} data - Array of record data
     * @param {string} [unique_key=this.primaryKey] - The unique field to match on
     * @param {Object} [prismaOptions={}] - Prisma database options
     * @param {Object} [options={}] - Operation options
     * @param {boolean} [options.validateRelation=false] - Whether to validate relations
     * @param {boolean} [options.transaction=true] - Whether to use a transaction (default true)
     * @param {number} [options.timeout=30000] - Transaction timeout in milliseconds
     * @returns {Promise<Object>} Result with created, updated, and total counts
     * @example
     * const result = await contact.upsertMany([
     *     { contact_id: '1', first_name: 'John' },
     *     { contact_id: '2', first_name: 'Jane' }
     * ], 'contact_id');
     * // { created: 1, updated: 1, total: 2 }
     *
     * @example
     * // Without transaction and with relation validation
     * const result = await contact.upsertMany(data, 'contact_id', {}, {
     *     validateRelation: true,
     *     transaction: false
     * });
     */
    async upsertMany(data, unique_key = this.primaryKey, prismaOptions = {}, options = {}) {
        return await this._upsertMany(data, unique_key, prismaOptions, options);
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
     * Set the model name and initialize the Prisma client delegate
     * @param {string} name - The Prisma model name
     */
    set modelName(name) {
        this.name = name;
        this.prisma = prisma[name];
    }

    /** @type {Object[]} Related objects configuration (deprecated, use DMMF) */
    static relatedObjects = [];

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