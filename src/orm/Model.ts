import { QueryBuilder } from './QueryBuilder';
import { isRawOperation, rawOperationPayloads } from './nestedOperations';
import { parseScalar } from './values';
import { prisma, prismaTransaction, getAcl, dbProvider, rlsActive } from '../core/prisma';
import { modelMiddleware } from '../core/middleware';
import { ErrorResponse } from '../core/errors';
import { isSystemUser, createSystemUser, getDefaultUser } from '../core/user';
import * as dmmf from '../core/dmmf';
import type { RapiddUser, ModelOptions, GetManyOptions, GetManyResult, UpsertManyResult, UpsertManyOptions, ModelAcl, MiddlewareContext } from '../types';

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
 * const result = await users.getMany({ include: 'profile', limit: 10 });
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
        this.name = name;
        this.prisma = (prisma as any)[name];
        this.queryBuilder = (this.constructor as typeof Model).QueryBuilder ?? new QueryBuilder(name);
        const aclConfig = getAcl();
        this.acl = aclConfig.model[name] || {};
        this.options = options || {};
        // Resolve the acting user: explicit > app-configured default (src/config/user.ts) >
        // framework system user (bypasses ACL). No hardcoded id/role — the old
        // { id: 'system', role: 'application' } assumed a string PK and a magic role value.
        this.user = this.options.user ?? getDefaultUser() ?? createSystemUser();
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
     *
     * Values are coerced to the key's column type — ids from URLs arrive as strings — and
     * invalid ones (`abc` for an Int key, `1.5`, a BigInt past 2^53 as a number) are a 400
     * `invalid_id` instead of a database error or a silently different record.
     */
    buildWhereId(id: string | number | bigint | Record<string, any>): Record<string, any> {
        const pkFields = this.primaryKeyFields;

        if (!Array.isArray(pkFields)) {
            return { [pkFields]: this.#coercePrimaryKeyValue(pkFields, id) };
        }

        // Composite PK
        const compositeKeyName = dmmf.compoundKeyName(this.name, pkFields);

        if (typeof id === 'object' && id !== null) {
            // Already an object with field values
            const values: Record<string, any> = {};
            for (const field of pkFields) {
                values[field] = this.#coercePrimaryKeyValue(field, (id as Record<string, any>)[field]);
            }
            return { [compositeKeyName]: values };
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
            const compositeKeyValues: Record<string, any> = {};
            uniqueKey.forEach((key: string) => {
                compositeKeyValues[key] = data[key];
            });
            return { [dmmf.compoundKeyName(this.name, uniqueKey)]: compositeKeyValues };
        }
        return { [uniqueKey]: data[uniqueKey] };
    }

    /**
     * A composite PK's selector name ('a_b' — the default that models generated by older
     * rapidd-build versions pass) stands for its fields
     */
    #resolveUniqueKey(key: string | string[]): string | string[] {
        return key === this.primaryKey && this.isCompositePK ? this.primaryKeyFields : key;
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
     * Merge an ACL filter into a unique where clause (update / upsert / delete / permission checks).
     * Prisma's WhereUniqueInput requires a unique field at the TOP level, so the ACL filter is
     * nested under AND — `{ AND: [whereId, filter] }` is rejected by Prisma, and spreading the
     * filter at top level would let colliding keys overwrite the target id.
     */
    #mergeAclIntoUniqueWhere(whereId: Record<string, any>, aclFilter: any): Record<string, any> {
        if (!aclFilter || typeof aclFilter !== 'object' || Object.keys(aclFilter).length === 0) {
            return whereId;
        }
        return { ...whereId, AND: [aclFilter] };
    }

    /**
     * Coerce a key value to its column type, rejecting values that don't fit with 400 `invalid_id`
     */
    #coercePrimaryKeyValue(fieldName: string, value: unknown): unknown {
        const parsed = parseScalar(this.fields[fieldName], value);
        if (parsed === undefined) {
            throw new ErrorResponse(400, "invalid_id", { field: fieldName, value: String(value).slice(0, 100) });
        }
        return parsed;
    }

    /**
     * Parse an id-like value — a URL segment — for one of this model's fields by the field's
     * type: `parseKey('courseId', '5')` → 5. Throws 400 `invalid_id` when it doesn't fit.
     * Generated sub-routes use it for the parent id.
     */
    parseKey(field: string, value: unknown): unknown {
        return this.#coercePrimaryKeyValue(field, value);
    }

    /**
     * Get all fields for this model from DMMF
     */
    get fields(): Record<string, any> {
        return this.queryBuilder.fields;
    }

    /** Build select clause */
    _select = (fields?: string[] | Record<string, any> | null): Record<string, any> => this.queryBuilder.select(fields as any);
    /** Build filter/where clause (user enables ACL omit enforcement on filter fields) */
    _filter = (q: any): Record<string, any> => this.queryBuilder.filter(q, this.user);
    /** Build include clause for relations */
    _include = (include: string | Record<string, any>): Record<string, any> => this.queryBuilder.include(include, this.user);
    /** Transform data for create operation */
    _queryCreate = (data: Record<string, any>): Record<string, any> => this.queryBuilder.create(data, this.user);
    /** Transform data for update operation */
    _queryUpdate = (id: string | number, data: Record<string, any>): Record<string, any> => this.queryBuilder.update(id, data, this.user);

    // ACL METHODS
    /** Check if user can create records */
    _canCreate = (data?: Record<string, any>): boolean => this.acl.canCreate ? this.acl.canCreate(this.user, data) : true;
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
    _getMany = async (opts: GetManyOptions = {}): Promise<GetManyResult> => {
        const {
            q = {},
            include = '',
            limit = 25,
            offset = 0,
            fields = null,
            totalResults = true,
            where: scope = {},
        } = opts;

        // No default sort — without an explicit sort the DB decides the order
        // (a forced id:asc breaks models without an 'id' column)
        const sortBy = typeof opts.sortBy === 'string' && opts.sortBy.trim() !== '' ? opts.sortBy.trim() : null;
        const sortOrder = (opts.sortOrder ?? 'asc').trim();

        const take = this.take(Number(limit));
        const skip = this.skip(Number(offset));

        // Validate an explicitly provided sort field
        if (sortBy && !sortBy.includes('.') && this.fields[sortBy] == undefined) {
            throw new ErrorResponse(400, "invalid_sort_field", { sortBy, modelName: this.constructor.name });
        }

        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'getMany', { query: q, where: scope, include, take, skip, sortBy, sortOrder, fields });

        if (beforeCtx.abort) {
            return (beforeCtx.result as GetManyResult) || { data: [], meta: { take, skip, total: 0 } };
        }

        // Build field selection (handles select vs include+omit based on fields param)
        // Use beforeCtx.fields directly since it's always initialized from the context params
        const fieldSelection = this.queryBuilder.buildFieldSelection(
            beforeCtx.fields as string | null,
            beforeCtx.include || include,
            this.user
        );

        const effectiveTake = beforeCtx.take || take;
        const effectiveSkip = beforeCtx.skip || skip;
        const clientFilter = this.filter(beforeCtx.query || q);
        const serverScope = beforeCtx.where ?? scope;
        const whereClause = Object.keys(serverScope).length === 0 ? clientFilter
            : Object.keys(clientFilter).length === 0 ? serverScope
                : { AND: [clientFilter, serverScope] };
        const effectiveSortBy = beforeCtx.sortBy || sortBy;
        const orderByClause = effectiveSortBy ? this.sort(effectiveSortBy, beforeCtx.sortOrder || sortOrder) : undefined;
        const extraOptions = beforeCtx.options || {};

        let result: GetManyResult;

        if (totalResults) {
            const findPage = (client: any) => client[this.name].findMany({
                'where': whereClause,
                ...fieldSelection,
                'take': effectiveTake,
                'skip': effectiveSkip,
                ...(orderByClause ? { 'orderBy': orderByClause } : {}),
                ...extraOptions
            });
            const countAll = (client: any) => client[this.name].count({ 'where': whereClause });
            // Data + count run in parallel. With RLS variables every query needs a transaction
            // to set them — then one transaction for both is cheaper than one each.
            const [data, total] = rlsActive()
                ? await prismaTransaction([findPage, countAll])
                : await Promise.all([findPage(prisma), countAll(prisma)]);
            result = { data, meta: { take: Number(effectiveTake), skip: Number(effectiveSkip), total } };
        } else {
            // Fetch take+1 rows to determine hasMore without a count query
            const rows = await prisma[this.name].findMany({
                'where': whereClause,
                ...fieldSelection,
                'take': effectiveTake + 1,
                'skip': effectiveSkip,
                ...(orderByClause ? { 'orderBy': orderByClause } : {}),
                ...extraOptions
            });
            const hasMore = rows.length > effectiveTake;
            const data = hasMore ? rows.slice(0, effectiveTake) : rows;
            result = { data, meta: { take: Number(effectiveTake), skip: Number(effectiveSkip), hasMore } };
        }

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'getMany', { result, state: beforeCtx.state });
        return (afterCtx.result as GetManyResult) || result;
    }

    /**
     * Internal method to fetch a single record by primary key
     * 404 when it doesn't exist, 403 when it exists outside the user's access filter
     */
    _get = async (id: string | number | Record<string, any>, include: string | Record<string, any> = '', options: Record<string, any> = {}, fields: string | null = null): Promise<any> => {
        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'get', { id, include, options, fields });

        if (beforeCtx.abort) {
            return beforeCtx.result;
        }

        const { omit, where: extraWhere, ..._options } = beforeCtx.options || options;
        const targetId = beforeCtx.id || id;
        const whereId = this.buildWhereId(targetId);

        // The ACL filter is part of the lookup: found-and-permitted (the common case) is ONE
        // query. Only a miss under a restricting filter looks again, to tell 403 from 404.
        const accessFilter = this.getAccessFilter();
        const scoped = (...conditions: any[]): Record<string, any> => {
            const and = conditions.filter((c) => c && typeof c === 'object' && Object.keys(c).length > 0);
            return and.length > 0 ? { ...whereId, AND: and } : whereId;
        };

        // Build field selection (handles select vs include+omit based on fields param)
        // Use beforeCtx.fields directly since it's always initialized from the context params
        const effectiveFields = beforeCtx.fields as string | null;
        const effectiveInclude = beforeCtx.include || include;

        const selection = effectiveFields
            ? this.queryBuilder.buildFieldSelection(effectiveFields, effectiveInclude, this.user)
            : { 'include': this.include(effectiveInclude), 'omit': { ...this._omit(), ...omit } };

        const response = await this.prisma.findUnique({ ...selection, ..._options, 'where': scoped(accessFilter, extraWhere) });
        if (!response) {
            const restricted = Object.keys(accessFilter).length > 0;
            if (restricted && await this.prisma.findUnique({ 'where': scoped(extraWhere), 'select': this.#buildPrimaryKeySelect() })) {
                throw new ErrorResponse(403, "no_permission");
            }
            throw new ErrorResponse(404, "record_not_found");
        }

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'get', { id: targetId, result: response, state: beforeCtx.state });
        return afterCtx.result || response;
    }

    /**
     * Internal method to create a new record
     */
    _create = async (data: Record<string, any>, options: Record<string, any> = {}): Promise<any> => {
        // STRICT MODE (REST edge): reject payloads containing non-writable fields
        if (this.options.strictWrites) {
            this.assertWritable(data);
        }

        // CHECK CREATE PERMISSION
        if (!this.canCreate(data)) {
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

        // CREATE — apply the ACL omit clause so write responses don't leak hidden fields (e.g. password)
        const createOmit = this._omit();
        const result = await this.prisma.create({
            'data': transformedData,
            'include': this.include('ALL'),
            ...(createOmit && Object.keys(createOmit).length > 0 ? { omit: createOmit } : {}),
            ...(beforeCtx.options || options)
        });

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'create', { data: transformedData, result, state: beforeCtx.state });
        return afterCtx.result || result;
    }

    /**
     * Internal method to update an existing record
     */
    _update = async (id: string | number | Record<string, any>, data: Record<string, any>, options: Record<string, any> = {}): Promise<any> => {
        // Create a copy to avoid mutating the caller's data
        const inputData: Record<string, any> = { ...data };

        // STRICT MODE (REST edge): reject payloads containing non-writable fields
        if (this.options.strictWrites) {
            this.assertWritable(inputData);
        }

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
        const whereId = this.buildWhereId(targetId);

        // VALIDATE PASSED FIELDS AND RELATIONSHIPS (returns new transformed object).
        // Nested n:m writes use the parent id: pass the coerced value, not the URL string.
        const parentId = this.isCompositePK ? targetId : whereId[this.primaryKeyFields as string];
        const transformedData = this._queryUpdate(parentId as string | number, updateData);

        const updateOmit = this._omit();
        const result = await this.prisma.update({
            'where': this.#mergeAclIntoUniqueWhere(whereId, updateFilter),
            'data': transformedData,
            'include': this.include('ALL'),
            ...(updateOmit && Object.keys(updateOmit).length > 0 ? { omit: updateOmit } : {}),
            ...(beforeCtx.options || options)
        });

        if (!result) {
            throw new ErrorResponse(403, "no_permission");
        }

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'update', { id: targetId, data: transformedData, result, state: beforeCtx.state });
        return afterCtx.result || result;
    }

    /**
     * Internal method to create or update a record based on unique key
     * Supports both single and composite primary keys
     */
    async _upsert(data: Record<string, any>, unique_key: string | string[] = this.primaryKeyFields, options: Record<string, any> = {}): Promise<any> {
        // STRICT MODE (REST edge): reject payloads containing non-writable fields
        if (this.options.strictWrites) {
            this.assertWritable(data);
        }

        // CHECK CREATE PERMISSION (upsert may create)
        if (!this.canCreate(data)) {
            throw new ErrorResponse(403, "no_permission_to_create", { model: this.name });
        }

        // CHECK UPDATE PERMISSION (upsert may update)
        const updateFilter = this.getUpdateFilter();
        if (updateFilter === false) {
            throw new ErrorResponse(403, "no_permission_to_update");
        }

        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'upsert', { data: { ...data }, unique_key, options });

        if (beforeCtx.abort) {
            return beforeCtx.result;
        }

        const upsertData = beforeCtx.data || data;
        const targetKey = this.#resolveUniqueKey(beforeCtx.unique_key || unique_key);

        // create() and update() are now pure - they return new objects without mutating input
        const createData = this.queryBuilder.create(upsertData, this.user);

        // Nested n:m writes use the parent id (unknown when upserting by another unique key)
        const updateData = this.queryBuilder.update(this.isCompositePK ? null : upsertData[this.primaryKey] ?? null, upsertData, this.user);

        // Build where clause with ACL update filter
        const whereId = this.buildWhereUniqueKey(targetKey, upsertData);
        const whereClause = this.#mergeAclIntoUniqueWhere(whereId, updateFilter);

        const upsertOmit = this._omit();
        const result = await this.prisma.upsert({
            'where': whereClause,
            'create': createData,
            'update': updateData,
            'include': this.include('ALL'),
            ...(upsertOmit && Object.keys(upsertOmit).length > 0 ? { omit: upsertOmit } : {}),
            ...(beforeCtx.options || options)
        });

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'upsert', { data: upsertData, result, state: beforeCtx.state });
        return afterCtx.result || result;
    }

    /**
     * Internal method to create or update multiple records based on unique key
     * Supports both transactional and non-transactional operations with optional relation validation
     */
    async _upsertMany(
        data: Record<string, any>[],
        unique_key: string | string[] = this.primaryKeyFields,
        prismaOptions: Record<string, any> = {},
        options: UpsertManyOptions = {}
    ): Promise<UpsertManyResult> {
        if (!Array.isArray(data) || data.length === 0) {
            return { created: 0, updated: 0, skipped: 0, failed: [], totalSuccess: 0, totalFailed: 0 } as UpsertManyResult;
        }

        // STRICT MODE (REST edge): reject payloads containing non-writable fields
        if (this.options.strictWrites) {
            for (const record of data) {
                this.assertWritable(record);
            }
        }

        // CREATE PERMISSION is checked per record below — only records that don't exist yet create,
        // and canCreate implementations may depend on the record data

        // CHECK UPDATE PERMISSION (upsertMany may update)
        const updateFilter = this.getUpdateFilter();
        if (updateFilter === false) {
            throw new ErrorResponse(403, "no_permission_to_update");
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
        const targetKey: string | string[] = this.#resolveUniqueKey(beforeCtx.unique_key || unique_key);
        const _prismaOptions: Record<string, any> = beforeCtx.prismaOptions || prismaOptions;

        // Define the upsert operation logic
        const executeUpsertMany = async (tx: any): Promise<UpsertManyResult> => {
            const keyFields: string[] = Array.isArray(targetKey) ? targetKey : [targetKey];
            const keyOf = (record: Record<string, any>): string => keyFields.map((k: string) => String(record[k])).join('\u0000');

            // Which records exist: one query per 1000 keys, matched through a Set (plain field
            // equality — compound selectors are only valid in WhereUniqueInput, not in findMany)
            const lookupable = upsertData.filter((record: Record<string, any>) => keyFields.every((k: string) => record[k] != null));
            const existingKeys = new Set<string>();
            for (let i = 0; i < lookupable.length; i += 1000) {
                const chunk = lookupable.slice(i, i + 1000);
                const where = keyFields.length > 1
                    ? { OR: chunk.map((record: Record<string, any>) => Object.fromEntries(keyFields.map((k: string) => [k, record[k]]))) }
                    : { [keyFields[0]]: { in: chunk.map((record: Record<string, any>) => record[keyFields[0]]) } };
                const rows: Record<string, any>[] = await tx[this.name].findMany({
                    where,
                    select: Object.fromEntries(keyFields.map((k: string) => [k, true])),
                });
                for (const row of rows) existingKeys.add(keyOf(row));
            }

            // On PostgreSQL a failed statement aborts the whole transaction: later statements fail
            // and the commit silently rolls back — while the result would still report successes.
            // Writes therefore run under savepoints. Records share one savepoint per chunk; a chunk
            // that fails is rolled back and replayed record by record, so a bad record costs only
            // itself. (MySQL/MariaDB roll back just the failed statement.)
            const useSavepoints = useTransaction && dbProvider === 'postgresql';
            let savepointSeq = 0;
            let transactionLost = false;
            const savepoint = async <T>(fn: () => Promise<T>): Promise<T> => {
                const name = `rapidd_upsert_${++savepointSeq}`;
                await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
                try {
                    const result = await fn();
                    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
                    return result;
                } catch (error) {
                    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => { transactionLost = true; });
                    throw error;
                }
            };
            // Deadlocks, serialization conflicts and a dead transaction end the batch: rethrown
            // instead of being reported as one record's failure
            const isFatal = (error: any): boolean => transactionLost || (useTransaction && (
                error?.code === 'P2034' || error?.code === 'P2028'
                || /deadlock|lock wait timeout|could not serialize/i.test(error?.message ?? '')));

            /** Run `write` per item; returns the number that succeeded, reporting failures to `onError` */
            const writeEach = async <T>(items: T[], write: (item: T) => Promise<unknown>, onError: (item: T, error: any) => void): Promise<number> => {
                let succeeded = 0;
                const writeOne = async (item: T): Promise<void> => {
                    try {
                        await (useSavepoints ? savepoint(() => write(item)) : write(item));
                        succeeded++;
                    } catch (error) {
                        if (isFatal(error)) throw error;
                        onError(item, error);
                    }
                };
                if (!useSavepoints) {
                    for (const item of items) await writeOne(item);
                    return succeeded;
                }
                // At most ~50 chunk savepoints per batch (PostgreSQL slows down past 64 subtransactions)
                const chunkSize = Math.max(100, Math.ceil(items.length / 50));
                for (let i = 0; i < items.length; i += chunkSize) {
                    const chunk = items.slice(i, i + chunkSize);
                    try {
                        await savepoint(async () => {
                            for (const item of chunk) await write(item);
                        });
                        succeeded += chunk.length;
                    } catch (error) {
                        if (isFatal(error)) throw error;
                        if (chunk.length === 1) onError(chunk[0], error);
                        else for (const item of chunk) await writeOne(item);
                    }
                }
                return succeeded;
            };

            // Separate data into creates and updates, using pure create/update
            const createRecords: { original: Record<string, any>; transformed: Record<string, any> }[] = [];
            const updateRecords: { original: Record<string, any>; transformed: Record<string, any> }[] = [];

            const pendingCreates = new Set<string>();
            for (const record of upsertData) {
                const key = keyFields.every((k: string) => record[k] != null) ? keyOf(record) : null;
                // Exists — or is created earlier in this batch, so a repeated key updates that row
                if (key !== null && (existingKeys.has(key) || pendingCreates.has(key))) {
                    // Record exists, prepare for update (pure - returns new object)
                    const parentId = this.isCompositePK ? null : record[this.primaryKey] ?? null;
                    updateRecords.push({ original: record, transformed: this.queryBuilder.update(parentId, record, this.user) });
                } else {
                    // Record doesn't exist, prepare for create — check per-record create permission
                    if (!this.canCreate(record)) {
                        throw new ErrorResponse(403, "no_permission_to_create", { model: this.name });
                    }
                    if (key !== null) pendingCreates.add(key);
                    createRecords.push({
                        original: record,
                        // createMany takes plain rows: strip what the ACL hides / doesn't allow writing
                        transformed: validateRelation
                            ? this.queryBuilder.create(record, this.user)
                            : this.queryBuilder.sanitizeRow(record, this.user),
                    });
                }
            }

            const failed: { record?: Record<string, any>; records?: Record<string, any>[]; error: any }[] = [];
            let createdCount = 0;
            let skippedCount = 0;

            // Creates: one createMany statement, or record by record when relations are processed
            if (createRecords.length > 0) {
                if (validateRelation) {
                    createdCount = await writeEach(
                        createRecords,
                        ({ transformed }) => tx[this.name].create({ 'data': transformed, ..._prismaOptions }),
                        ({ transformed }, error) => failed.push({ record: transformed, error })
                    );
                } else {
                    const rows = createRecords.map((r) => r.transformed);
                    try {
                        const run = () => tx[this.name].createMany({ 'data': rows, 'skipDuplicates': true, ..._prismaOptions });
                        const createResult = await (useSavepoints ? savepoint(run) : run());
                        createdCount = (createResult as { count: number }).count;
                        // skipDuplicates drops rows that hit a unique conflict (another unique field,
                        // or a concurrent insert) without saying which — at least count them
                        skippedCount = rows.length - createdCount;
                    } catch (error: any) {
                        if (isFatal(error)) throw error;
                        failed.push({ records: rows, error });
                    }
                }
            }

            // Updates, each scoped by the ACL update filter
            const updatedCount = await writeEach(
                updateRecords,
                ({ original, transformed }) => {
                    const whereId = Array.isArray(targetKey)
                        ? this.buildWhereUniqueKey(targetKey, original)
                        : { [targetKey as string]: original[targetKey as string] };
                    return tx[this.name].update({
                        'where': this.#mergeAclIntoUniqueWhere(whereId, updateFilter),
                        'data': transformed,
                        ..._prismaOptions
                    });
                },
                ({ transformed }, error) => failed.push({ record: transformed, error })
            );

            return {
                created: createdCount,
                updated: updatedCount,
                skipped: skippedCount,
                failed,
                totalSuccess: createdCount + updatedCount,
                // A failed createMany fails all of its records
                totalFailed: failed.reduce((n, f) => n + (f.records ? f.records.length : 1), 0)
            } as UpsertManyResult;
        };

        // Execute with or without transaction based on option
        const result: UpsertManyResult = useTransaction
            ? await prismaTransaction(executeUpsertMany, { timeout })
            : await executeUpsertMany(prisma);

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'upsertMany', { data: upsertData, result, state: beforeCtx.state });
        return (afterCtx.result as UpsertManyResult) || result;
    }

    /**
     * Internal method to count records matching a filter
     */
    _count = async (q: string | Record<string, any> = {}): Promise<number> => {
        // Execute before middleware
        const beforeCtx = await this._executeMiddleware('before', 'count', { query: q });

        if (beforeCtx.abort) {
            return (beforeCtx.result as number) || 0;
        }

        const result = await this.prisma.count({
            'where': this.filter(beforeCtx.query || q)
        });

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'count', { query: beforeCtx.query || q, result, state: beforeCtx.state });
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
                'where': this.#mergeAclIntoUniqueWhere(whereId, deleteFilter),
                'data': beforeCtx.data,
                'select': this.select(),
                ...(beforeCtx.options || options)
            });

            const afterCtx = await this._executeMiddleware('after', 'delete', { id: targetId, result, softDelete: true, state: beforeCtx.state });
            return afterCtx.result || result;
        }

        const result = await this.prisma.delete({
            'where': this.#mergeAclIntoUniqueWhere(whereId, deleteFilter),
            'select': this.select(),
            ...(beforeCtx.options || options)
        });

        if (!result) {
            throw new ErrorResponse(403, "no_permission");
        }

        // Execute after middleware
        const afterCtx = await this._executeMiddleware('after', 'delete', { id: targetId, result, state: beforeCtx.state });
        return afterCtx.result || result;
    }

    /**
     * Fetch multiple records with filtering, pagination, and sorting.
     * Supports both offset mode (limit/offset) and page mode (page/pageSize).
     */
    async getMany(opts: GetManyOptions = {}): Promise<GetManyResult> {
        if (opts.pagination) {
            const pageSize = this.take(Number(opts.pagination.pageSize));
            const page = Math.max(1, Math.floor(Number(opts.pagination.page) || 1));
            const skip = (page - 1) * pageSize;
            const result = await this._getMany({ ...opts, limit: pageSize, offset: skip });
            result.meta.page = page;
            result.meta.pageSize = pageSize;
            return result;
        }
        return await this._getMany(opts);
    }

    /**
     * Fetch a single record by primary key
     */
    async get(id: string | number | Record<string, any>, include?: string | Record<string, any>, options: Record<string, any> = {}, fields: string | null = null): Promise<any> {
        return await this._get(id, include, options, fields);
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
    async upsert(data: Record<string, any>, unique_key: string | string[] = this.primaryKeyFields, options: Record<string, any> = {}): Promise<any> {
        return await this._upsert(data, unique_key, options);
    }

    /**
     * Create or update multiple records based on unique key
     * Performs atomic batch operations with optional transaction support
     */
    async upsertMany(
        data: Record<string, any>[],
        unique_key: string | string[] = this.primaryKeyFields,
        prismaOptions: Record<string, any> = {},
        options: UpsertManyOptions = {}
    ): Promise<UpsertManyResult> {
        return await this._upsertMany(data, unique_key, prismaOptions, options);
    }

    /**
     * Count records matching a filter.
     * @param q a filter STRING using the same query syntax as getMany's `q` (e.g. "status=active").
     *   Note: unlike getMany you pass the string DIRECTLY, not wrapped as `{ q }`. A non-string
     *   is treated as "no filter" (counts all rows the ACL permits). The model's ACL access
     *   filter is always AND-combined in.
     */
    async count(q: string | Record<string, any> = {}): Promise<number> {
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
     * Build a filter/where clause with ACL applied.
     * Uses AND to combine API filters with ACL filters so they never overwrite each other.
     */
    filter(include: string | Record<string, any>): Record<string, any> {
        const apiFilter = this._filter(include);
        const aclFilter = this.getAccessFilter();

        const hasApi = Object.keys(apiFilter).length > 0;
        const hasAcl = Object.keys(aclFilter).length > 0;

        if (!hasApi) return aclFilter;
        if (!hasAcl) return apiFilter;

        return { AND: [apiFilter, aclFilter] };
    }

    /**
     * Build an include clause for relations
     */
    include(include: string | Record<string, any>): Record<string, any> {
        return this._include(include);
    }

    /**
     * Build an orderBy clause (user enables ACL omit enforcement on sort fields)
     */
    sort(sortBy: string, sortOrder: string): Record<string, any> {
        return this.queryBuilder.sort(sortBy, sortOrder, this.user);
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
     * Returns empty filter for a system user or when ACL returns true
     */
    getAccessFilter(): Record<string, any> {
        // Bypass before evaluating the ACL callback — a system user has a null id, and
        // running the app's filter builder with it is both wasteful and a crash risk.
        if (isSystemUser(this.user)) return {};
        const filter = this._getAccessFilter();
        if (filter === true) {
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
    canCreate(data?: Record<string, any>): boolean {
        if (isSystemUser(this.user)) return true;
        return this._canCreate(data);
    }

    /**
     * Get the writable-fields whitelist for this user, or null when unrestricted
     */
    getWritableFields(): string[] | null {
        if (isSystemUser(this.user)) return null;
        const list = this.acl.getWritableFields?.(this.user);
        return Array.isArray(list) ? list : null;
    }

    /**
     * Assert that a write payload only contains fields the user may write.
     * Validates against getWritableFields (whitelist) and getOmitFields (blacklist),
     * recursing into nested relation payloads against the related models' ACLs.
     * Throws 403 `fields_not_writable` listing the offending field paths.
     *
     * Runs automatically on create/update/upsert when the model was constructed with
     * `strictWrites: true` (the REST edge). Models without the flag silently strip
     * these fields instead, so internal backend logic can still write them.
     */
    assertWritable(data: Record<string, any>): void {
        if (isSystemUser(this.user)) return;
        if (!data || typeof data !== 'object') return;
        const violations: string[] = [];
        this.#collectWriteViolations(this.name, data, violations, '', 0, false);
        if (violations.length > 0) {
            throw new ErrorResponse(403, "fields_not_writable", { model: this.name, fields: violations });
        }
    }

    /**
     * Recursively collect payload fields the user may not write.
     * Identifier fields (the model's PK) are allowed in nested payloads — they address
     * records rather than write data. Prisma-operation passthrough objects
     * ({ connect: ... }, { set: ... }, ...) are skipped, mirroring QueryBuilder.
     */
    #collectWriteViolations(
        modelName: string,
        data: Record<string, any>,
        violations: string[],
        path: string,
        depth: number,
        isNested: boolean,
        extraIdentifiers: string[] = [],
        isListRelation: boolean = true
    ): void {
        if (depth > 10 || !data || typeof data !== 'object' || Array.isArray(data)) return;

        // Raw Prisma operations: validate what they would WRITE (create/update payloads)
        if (isRawOperation(data)) {
            for (const payload of rawOperationPayloads(data, isListRelation)) {
                this.#collectWriteViolations(modelName, payload, violations, path, depth + 1, true, extraIdentifiers);
            }
            return;
        }

        const modelAcl = getAcl().model[modelName] || {};
        const modelFields = dmmf.getFields(modelName);
        // Omit hides fields on read; when validating a WRITE payload, keep write-only fields
        // (required, no default — e.g. password) so clients can still create such records.
        const omit = new Set<string>(
            (modelAcl.getOmitFields?.(this.user) ?? []).filter((f: string) => {
                const fd = modelFields[f];
                return !(fd && fd.kind === 'scalar' && fd.isRequired === true && fd.hasDefaultValue !== true && !fd.isId);
            })
        );
        const writableList = modelAcl.getWritableFields?.(this.user);
        const writable = Array.isArray(writableList) ? new Set<string>(writableList) : null;

        const pk = dmmf.getPrimaryKey(modelName);
        const identifierFields = new Set<string>([...(Array.isArray(pk) ? pk : [pk]), ...extraIdentifiers]);
        const relations = dmmf.buildRelationships(modelName);

        for (const key of Object.keys(data)) {
            const rel = relations.find((r) => r.name === key);

            if (rel && data[key] && typeof data[key] === 'object') {
                // Writing a relation — the relation name itself must be writable
                if (omit.has(key) || (writable && !writable.has(key))) {
                    violations.push(path + key);
                    continue;
                }
                const items = Array.isArray(data[key]) ? data[key] : [data[key]];
                // Composite n:m FK fields address the join record — identifiers, not data
                const relIdentifiers = Array.isArray(rel.fields) ? rel.fields : [];
                for (const item of items) {
                    this.#collectWriteViolations(rel.object, item, violations, `${path}${key}.`, depth + 1, true, relIdentifiers, rel.isList);
                }
                continue;
            }

            // PK fields in nested payloads address the record (connect/upsert targets)
            if (isNested && identifierFields.has(key)) continue;

            if (omit.has(key) || (writable && !writable.has(key))) {
                violations.push(path + key);
            }
        }
    }

    /**
     * Get filter for update operations
     * Returns empty filter for a system user or when ACL returns true
     */
    getUpdateFilter(): Record<string, any> | false {
        if (isSystemUser(this.user)) return {};
        const filter = this._getUpdateFilter();
        if (filter === true) {
            return {};
        }
        return filter;
    }

    /**
     * Get filter for delete operations
     * Returns empty filter for a system user or when ACL returns true
     */
    getDeleteFilter(): Record<string, any> | false {
        if (isSystemUser(this.user)) return {};
        const filter = this._getDeleteFilter();
        if (filter === true) {
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
