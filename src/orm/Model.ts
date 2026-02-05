import { QueryBuilder } from './QueryBuilder';
import { prisma, prismaTransaction, getAcl } from '../core/prisma';
import { modelMiddleware } from '../core/middleware';
import { ErrorResponse } from '../core/errors';
import type { RapiddUser, ModelOptions, GetManyResult, UpsertManyResult, UpsertManyOptions, ModelAcl, MiddlewareContext } from '../types';

/**
 * Base Model class for Rapidd ORM operations
 * Provides CRUD operations with built-in ACL (Access Control List) and middleware support
 *
 * @example
 * class Users extends Model {
 *     constructor(options: ModelOptions) {
 *         super('users', options);
 *     }
 * }
 *
 * const users = new Users({ user: { id: '123', role: 'admin' } });
 * const result = await users.getMany({}, 'profile', 10, 0);
 *
 * @example
 * // Register middleware to auto-add timestamps
 * Model.middleware.use('before', 'create', async (ctx: MiddlewareContext) => {
 *     ctx.data.createdAt = new Date();
 *     ctx.data.createdBy = ctx.user?.id;
 *     return ctx;
 * });
 */
class Model {
    name!: string;
    queryBuilder: QueryBuilder;
    acl: ModelAcl;
    options: ModelOptions;
    user: RapiddUser;
    user_id: string | number | null;
    prisma: any; // Prisma model delegate

    static QueryBuilder?: QueryBuilder;
    static relatedObjects: any[] = [];
    static Error = ErrorResponse;
    static middleware = modelMiddleware;
    static prismaTransaction = prismaTransaction;

    /**
     * Create a new Model instance
     * @param name - The Prisma model name (e.g., 'users', 'company_profiles')
     * @param options - Configuration options
     */
    constructor(name: string, options?: ModelOptions) {
        this.modelName = name;
        this.queryBuilder = (this.constructor as typeof Model).QueryBuilder ?? new QueryBuilder(name);
        const aclConfig = getAcl();
        this.acl = aclConfig.model[name] || {};
        this.options = options || {};
        this.user = this.options.user || { id: 'system', role: 'application' };
        this.user_id = this.user ? this.user.id : null;
    }

    /**
     * Get the primary key field name for this model
     * For composite keys, returns fields joined with underscore (Prisma composite key format)
     */
    get primaryKey(): string {
        const pkey = this.queryBuilder.getPrimaryKey();
        return Array.isArray(pkey) ? pkey.join('_') : pkey;
    }

    /**
     * Get raw primary key field(s) from DMMF
     * Returns string for simple PKs, string[] for composite PKs
     */
    get primaryKeyFields(): string | string[] {
        return this.queryBuilder.getPrimaryKey();
    }

    /**
     * Get the default sort field for this model
     * For composite keys, returns the first field
     */
    get defaultSortField(): string {
        const pk = this.primaryKeyFields;
        return Array.isArray(pk) ? pk[0] : pk;
    }

    /**
     * Whether this model has a composite primary key
     */
    get isCompositePK(): boolean {
        return Array.isArray(this.primaryKeyFields);
    }

    /**
     * Build a Prisma where clause for the given ID value(s)
     * For simple PKs: { id: value }
     * For composite PKs with object: { email_companyId: { email: '...', companyId: '...' } }
     * For composite PKs with tilde-delimited string: parses "val1~val2" into fields
     */
    buildWhereId(id: string | number | Record<string, any>): Record<string, any> {
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
            const values: Record<string, any> = {};
            pkFields.forEach((field: string, i: number) => {
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
     */
    buildWhereUniqueKey(uniqueKey: string | string[], data: Record<string, any>): Record<string, any> {
        if (Array.isArray(uniqueKey)) {
            const compositeKeyName = uniqueKey.join('_');
            const compositeKeyValues: Record<string, any> = {};
            uniqueKey.forEach((key: string) => {
                compositeKeyValues[key] = data[key];
            });
            return { [compositeKeyName]: compositeKeyValues };
        }
        return { [uniqueKey]: data[uniqueKey] };
    }

    /**
     * Build a Prisma select clause for primary key fields
     */
    #buildPrimaryKeySelect(): Record<string, true> {
        const pkFields = this.primaryKeyFields;
        if (!Array.isArray(pkFields)) {
            return { [pkFields]: true };
        }
        return pkFields.reduce((acc: Record<string, true>, f: string) => { acc[f] = true; return acc; }, {});
    }

    /**
     * Compare two records by their primary key fields
     */
    #primaryKeysMatch(a: Record<string, any>, b: Record<string, any>): boolean {
        if (!a || !b) return false;
        const pkFields = this.primaryKeyFields;
        const fields = Array.isArray(pkFields) ? pkFields : [pkFields];
        return fields.every((f: string) => a[f] != null && String(a[f]) === String(b[f]));
    }

    /**
     * Coerce a string PK value to the correct type based on DMMF field type
     */
    #coercePrimaryKeyValue(fieldName: string, value: string): any {
        const field = this.fields[fieldName];
        if (!field) return value;
        if (field.type === 'Int') return parseInt(value, 10);
        if (field.type === 'Float' || field.type === 'Decimal') return parseFloat(value);
        if (field.type === 'Boolean') return value === 'true';
        return value;
    }

    /**
     * Get all fields for this model from DMMF
     */
    get fields(): Record<string, any> {
        return this.queryBuilder.fields;
    }

    /** Build select clause */
    _select = (fields?: string[] | Record<string, any> | null): Record<string, any> => this.queryBuilder.select(fields as any);
    /** Build filter/where clause */
    _filter = (q: any): Record<string, any> => this.queryBuilder.filter(q);
    /** Build include clause for relations */
    _include = (include: string | Record<string, any>): Record<string, any> => this.queryBuilder.include(include, this.user);
    /** Transform data for create operation */
    _queryCreate = (data: Record<string, any>): Record<string, any> => this.queryBuilder.create(data, this.user);
    /** Transform data for update operation */
    _queryUpdate = (id: string | number, data: Record<string, any>): Record<string, any> => this.queryBuilder.update(id, data, this.user);

    // ACL METHODS
    /** Check if user can create records */
    _canCreate = (): boolean => this.acl.canCreate ? this.acl.canCreate(this.user) : true;
    /** Get access filter from ACL */
    _getAccessFilter = (): any => this.acl.getAccessFilter?.(this.user);
    /** Get update filter from ACL */
    _getUpdateFilter = (): any => this.acl.getUpdateFilter?.(this.user);
    /** Get delete filter from ACL */
    _getDeleteFilter = (): any => this.acl.getDeleteFilter?.(this.user);
    /** Get fields to omit from response */
    _omit = (): Record<string, boolean> | undefined => this.queryBuilder.omit(this.user) as Record<string, boolean> | undefined;

    /**
     * Execute middleware chain for an operation
     */
    async _executeMiddleware(hook: 'before' | 'after', operation: string, params: Record<string, any>): Promise<MiddlewareContext> {
        const context = modelMiddleware.createContext({ name: this.name }, operation, params, this.user);
        return await modelMiddleware.execute(hook, operation as any, context);
    }

    /**
     * Internal method to fetch multiple records with filtering and pagination
     */
    _getMany = async (
        q: Record<string, any> = {},
        include: string | Record<string, any> = "",
        limit: number = 25,
        offset: number = 0,
        sortBy: string = this.defaultSortField,
        sortOrder: string = "asc",
        options: Record<string, any> = {}
    ): Promise<GetManyResult> => {
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
        const beforeCtx = await this._executeMiddleware('before', 'getMany', { query: q, include, take, skip, sortBy, sortOrder, options });

        if (beforeCtx.abort) {
            return (beforeCtx.result as GetManyResult) || { data: [], meta: { take, skip, total: 0 } };
        }

        // Query the database using Prisma with filters, pagination, and limits
        const [data, total] = await prismaTransaction([
            (tx: any) => tx[this.name].findMany({
                'where': this.filter(beforeCtx.query || q),
                'include': this.include(beforeCtx.include || include),
                'take': beforeCtx.take || take,
                'skip': beforeCtx.skip || skip,
                'orderBy': this.sort(beforeCtx.sortBy || sortBy, beforeCtx.sortOrder || sortOrder),
                'omit': this._omit(),
                ...(beforeCtx.options || options)
            }),
            (tx: any) => tx[this.name].count({
                'where': this.filter(beforeCtx.query || q)
            })
        ]);

        const result: GetManyResult = { data, meta: { take: Number(beforeCtx.take) || take, skip: Number(beforeCtx.skip) || skip, total } };

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'getMany', { result });
        return (afterCtx.result as GetManyResult) || result;
    }

    /**
     * Internal method to fetch a single record by primary key
     * Performs parallel permission check to distinguish 404 vs 403 errors
     */
    _get = async (id: string | number | Record<string, any>, include: string | Record<string, any> = '', options: Record<string, any> = {}): Promise<any> => {
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
     */
    _create = async (data: Record<string, any>, options: Record<string, any> = {}): Promise<any> => {
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
     */
    _update = async (id: string | number | Record<string, any>, data: Record<string, any>, options: Record<string, any> = {}): Promise<any> => {
        // Create a copy to avoid mutating the caller's data
        const inputData: Record<string, any> = { ...data };
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
        const transformedData = this._queryUpdate(targetId as string | number, updateData);

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
     */
    async _upsert(data: Record<string, any>, unique_key: string | string[] = this.primaryKey, options: Record<string, any> = {}): Promise<any> {
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
     */
    async _upsertMany(
        data: Record<string, any>[],
        unique_key: string | string[] = this.primaryKey,
        prismaOptions: Record<string, any> = {},
        options: UpsertManyOptions = {}
    ): Promise<UpsertManyResult> {
        if (!Array.isArray(data) || data.length === 0) {
            return { created: 0, updated: 0, failed: [], totalSuccess: 0, totalFailed: 0 } as UpsertManyResult;
        }

        // Extract operation-specific options
        const validateRelation = options.validateRelation ?? false;
        const useTransaction = options.transaction ?? true;
        const timeout = options.timeout ?? 30000;

        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'upsertMany', { data, unique_key, prismaOptions });

        if (beforeCtx.abort) {
            return beforeCtx.result as UpsertManyResult;
        }

        const upsertData: Record<string, any>[] = (Array.isArray(beforeCtx.data) ? beforeCtx.data : data) as Record<string, any>[];
        const targetKey: string | string[] = beforeCtx.unique_key || unique_key;
        const _prismaOptions: Record<string, any> = beforeCtx.prismaOptions || prismaOptions;

        // Define the upsert operation logic
        const executeUpsertMany = async (tx: any): Promise<UpsertManyResult> => {
            // Find existing records - handle both simple and composite keys
            let existingRecords: Record<string, any>[];
            if (Array.isArray(targetKey)) {
                // Composite key: use OR clause for lookup
                const whereConditions = upsertData
                    .map((record: Record<string, any>) => {
                        const compositeKeyName = targetKey.join('_');
                        const values: Record<string, any> = {};
                        targetKey.forEach((k: string) => { values[k] = record[k]; });
                        if (Object.values(values).some((v: any) => v == null)) return null;
                        return { [compositeKeyName]: values };
                    })
                    .filter(Boolean) as Record<string, any>[];

                existingRecords = whereConditions.length > 0
                    ? await tx[this.name].findMany({
                        'where': { OR: whereConditions },
                        'select': targetKey.reduce((acc: Record<string, true>, k: string) => { acc[k] = true; return acc; }, {})
                    })
                    : [];
            } else {
                const uniqueValues = upsertData.map((record: Record<string, any>) => record[targetKey as string]).filter((v: any) => v != null);
                existingRecords = uniqueValues.length > 0
                    ? await tx[this.name].findMany({
                        'where': { [targetKey as string]: { 'in': uniqueValues } },
                        'select': { [targetKey as string]: true }
                    })
                    : [];
            }

            // Build existence check helper
            const existsInDb = (record: Record<string, any>): boolean => {
                if (Array.isArray(targetKey)) {
                    return existingRecords.some((existing: Record<string, any>) =>
                        targetKey.every((k: string) => String(existing[k]) === String(record[k]))
                    );
                }
                return existingRecords.some((e: Record<string, any>) => String(e[targetKey as string]) === String(record[targetKey as string]));
            };

            // Separate data into creates and updates, using pure create/update
            const createRecords: { original: Record<string, any>; transformed: Record<string, any> }[] = [];
            const updateRecords: { original: Record<string, any>; transformed: Record<string, any> }[] = [];

            for (const record of upsertData) {
                if (existsInDb(record)) {
                    // Record exists, prepare for update (pure - returns new object)
                    const updatePrimaryKey = Array.isArray(targetKey) ? targetKey[0] : this.primaryKey;
                    const transformedRecord = this.queryBuilder.update(record[updatePrimaryKey] || record[targetKey as string], record, this.user);
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
            const failed: { record?: Record<string, any>; records?: Record<string, any>[]; error: any }[] = [];

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
                        } catch (error: any) {
                            failed.push({ record: transformed, error });
                        }
                    }
                } else {
                    try {
                        const createResult = await tx[this.name].createMany({
                            'data': createRecords.map((r: { original: Record<string, any>; transformed: Record<string, any> }) => r.transformed),
                            'skipDuplicates': true,
                            ..._prismaOptions
                        });
                        createdCount = createResult.count;
                    } catch (error: any) {
                        failed.push({ records: createRecords.map((r: { original: Record<string, any>; transformed: Record<string, any> }) => r.transformed), error });
                    }
                }
            }
            // Batch update
            if (updateRecords.length > 0) {
                for (const { original, transformed } of updateRecords) {
                    try {
                        const whereClause = Array.isArray(targetKey)
                            ? this.buildWhereUniqueKey(targetKey, original)
                            : { [targetKey as string]: original[targetKey as string] };
                        await tx[this.name].update({
                            'where': whereClause,
                            'data': transformed,
                            ..._prismaOptions
                        });
                        updatedCount++;
                    } catch (error: any) {
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
            } as UpsertManyResult;
        };

        // Execute with or without transaction based on option
        const result: UpsertManyResult = useTransaction
            ? await prismaTransaction(executeUpsertMany, { timeout })
            : await executeUpsertMany(prisma);

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'upsertMany', { data: upsertData, result });
        return (afterCtx.result as UpsertManyResult) || result;
    }

    /**
     * Internal method to count records matching a filter
     */
    _count = async (q: Record<string, any> = {}): Promise<number> => {
        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'count', { query: q });

        if (beforeCtx.abort) {
            return (beforeCtx.result as number) || 0;
        }

        const result = await this.prisma.count({
            'where': this.filter(beforeCtx.query || q)
        });

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'count', { query: beforeCtx.query || q, result });
        return (afterCtx.result as number) ?? result;
    }

    /**
     * Internal method to delete a record by primary key
     */
    _delete = async (id: string | number | Record<string, any>, options: Record<string, any> = {}): Promise<any> => {
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
     */
    async getMany(
        q: Record<string, any> = {},
        include: string | Record<string, any> = "",
        limit: number = 25,
        offset: number = 0,
        sortBy: string = this.defaultSortField,
        sortOrder: string = "asc"
    ): Promise<GetManyResult> {
        return await this._getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder);
    }

    /**
     * Fetch a single record by primary key
     */
    async get(id: string | number | Record<string, any>, include?: string | Record<string, any>, options: Record<string, any> = {}): Promise<any> {
        return await this._get(id, include, options);
    }

    /**
     * Create a new record
     */
    async create(data: Record<string, any>, options: Record<string, any> = {}): Promise<any> {
        return await this._create(data, options);
    }

    /**
     * Update an existing record by primary key
     */
    async update(id: string | number | Record<string, any>, data: Record<string, any>, options: Record<string, any> = {}): Promise<any> {
        return await this._update(id, data, options);
    }

    /**
     * Create or update a record based on unique key
     */
    async upsert(data: Record<string, any>, unique_key: string | string[] = this.primaryKey, options: Record<string, any> = {}): Promise<any> {
        return await this._upsert(data, unique_key, options);
    }

    /**
     * Create or update multiple records based on unique key
     * Performs atomic batch operations with optional transaction support
     */
    async upsertMany(
        data: Record<string, any>[],
        unique_key: string | string[] = this.primaryKey,
        prismaOptions: Record<string, any> = {},
        options: UpsertManyOptions = {}
    ): Promise<UpsertManyResult> {
        return await this._upsertMany(data, unique_key, prismaOptions, options);
    }

    /**
     * Count records matching a filter
     */
    async count(q: Record<string, any> = {}): Promise<number> {
        return await this._count(q);
    }

    /**
     * Delete a record by primary key
     */
    async delete(id: string | number | Record<string, any>, options: Record<string, any> = {}): Promise<any> {
        return await this._delete(id, options);
    }

    /**
     * Build a select clause for queries
     */
    select(fields?: string[] | Record<string, any>): Record<string, any> {
        return this._select(fields);
    }

    /**
     * Build a filter/where clause with ACL applied
     */
    filter(include: string | Record<string, any>): Record<string, any> {
        return { ...this._filter(include), ...this.getAccessFilter() };
    }

    /**
     * Build an include clause for relations
     */
    include(include: string | Record<string, any>): Record<string, any> {
        return this._include(include);
    }

    /**
     * Build an orderBy clause
     */
    sort(sortBy: string, sortOrder: string): Record<string, any> {
        return this.queryBuilder.sort(sortBy, sortOrder);
    }

    /**
     * Normalize and validate the limit (take) value
     */
    take(limit: number): number {
        return this.queryBuilder.take(Number(limit));
    }

    /**
     * Normalize and validate the offset (skip) value
     */
    skip(offset: number | string): number {
        const parsed = parseInt(offset as string);
        if (isNaN(parsed) || parsed < 0) {
            return 0;
        }
        return parsed;
    }

    /**
     * Get access filter for read operations
     * Returns empty filter for 'application' role or when ACL returns true
     */
    getAccessFilter(): Record<string, any> {
        const filter = this._getAccessFilter();
        if (this.user.role == "application" || filter === true) {
            return {};
        }
        if (filter === false) {
            throw new ErrorResponse(403, "no_permission");
        }
        if (!filter || typeof filter !== 'object') {
            return {};
        }
        return filter;
    }

    /**
     * Check if user has permission to create records
     */
    canCreate(): boolean {
        if (this.user.role == "application") return true;
        return this._canCreate();
    }

    /**
     * Get filter for update operations
     * Returns empty filter for 'application' role or when ACL returns true
     */
    getUpdateFilter(): Record<string, any> | false {
        const filter = this._getUpdateFilter();
        if (this.user.role == "application" || filter === true) {
            return {};
        }
        return filter;
    }

    /**
     * Get filter for delete operations
     * Returns empty filter for 'application' role or when ACL returns true
     */
    getDeleteFilter(): Record<string, any> | false {
        const filter = this._getDeleteFilter();
        if (this.user.role == "application" || filter === true) {
            return {};
        }
        return filter;
    }

    /**
     * Set the model name and initialize the Prisma client delegate
     */
    set modelName(name: string) {
        this.name = name;
        this.prisma = (prisma as any)[name];
    }
}

export { Model, QueryBuilder, prisma };
