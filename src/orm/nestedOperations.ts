import { ErrorResponse } from '../core/errors';
import type { RelationConfig } from '../types';

/**
 * Prisma nested-write operation keys.
 * Payloads containing any of these are raw Prisma operations (as opposed to Rapidd's own
 * nested shapes) — shared with Model.assertWritable; import, don't copy.
 */
export const PRISMA_WRITE_OPS = [
    'connect', 'create', 'connectOrCreate', 'disconnect', 'set',
    'update', 'upsert', 'deleteMany', 'updateMany', 'createMany', 'delete',
] as const;

const OPS = new Set<string>(PRISMA_WRITE_OPS);

/**
 * Whether linking a related row rewrites it: the foreign key is on the related rows (a list's,
 * or the other side of a to-one) — not in an implicit many-to-many, whose links are rows of
 * their own, nor where it is on this side.
 */
export function linkRewritesRelated(relation: RelationConfig): boolean {
    if (relation.field || relation.fields?.length) return false;
    const sides = (relation.relation ?? []).filter((r) => relation.relationName != null && r.relationName === relation.relationName);
    const back = sides.length > 1 ? sides.find((r) => r.name !== relation.name) : sides[0];
    return !(relation.isList && back?.isList);
}

/** Does this relation payload use raw Prisma operations? */
export function isRawOperation(value: unknown): boolean {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).some((key) => OPS.has(key));
}

type AclFilter = Record<string, any> | false | null;

/** What the caller provides about the ACL of the relation's target model */
export interface NestedOperationContext {
    accessFilter: AclFilter;
    updateFilter: AclFilter;
    deleteFilter: AclFilter;
    canCreate(data: Record<string, any>): boolean;
    /** Strip fields the user may not write and secure raw operations nested inside `data` */
    cleanData(data: Record<string, any>): Record<string, any>;
}

const asList = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);
const mapItems = <T>(value: T | T[], fn: (item: T) => any): any => (Array.isArray(value) ? value.map(fn) : fn(value));
const isEmpty = (filter: AclFilter) => !filter || Object.keys(filter).length === 0;

function deny(filter: AclFilter, key: string, model: string): void {
    if (filter === false) throw new ErrorResponse(403, key, { model });
}

/**
 * Narrow a unique where (connect / set / disconnect / delete / upsert targets) by an ACL
 * filter. The unique key must stay at the top level for Prisma, and a client-supplied AND
 * is kept next to the ACL condition rather than overwritten.
 */
function scopeUnique(where: Record<string, any>, filter: AclFilter): Record<string, any> {
    if (!where || typeof where !== 'object' || isEmpty(filter)) return where;
    const existing = where.AND === undefined ? [] : asList(where.AND);
    return { ...where, AND: [...existing, filter] };
}

/** Narrow a non-unique where (updateMany / deleteMany / to-one targets) by an ACL filter */
function scopeWhere(where: Record<string, any> | undefined, filter: AclFilter): Record<string, any> {
    if (isEmpty(filter)) return where ?? {};
    return where && Object.keys(where).length > 0 ? { AND: [where, filter] } : { ...(filter as Record<string, any>) };
}

/** `{ where, data }` (Prisma's to-one update-with-where form) vs. the data object itself */
function isWhereDataForm(value: Record<string, any>): boolean {
    const keys = Object.keys(value);
    return keys.includes('data') && keys.every((k) => k === 'data' || k === 'where');
}

/**
 * Apply the related model's ACL to raw Prisma nested-write operations, so that
 * `{ tags: { deleteMany: {} } }` or `{ author: { connect: { id: 5 } } }` in a payload is held
 * to the same rules as Rapidd's own nested shapes:
 *
 * - connect / set / disconnect / connectOrCreate.where — the access filter; where the foreign
 *   key is on the related rows (list relations, the other side of a to-one), linking rewrites
 *   them — the update filter too
 * - create / createMany / connectOrCreate.create / upsert.create — canCreate + field stripping
 * - update / updateMany / upsert — the update filter (+ field stripping)
 * - delete / deleteMany — the delete filter
 *
 * A filter of `false` rejects the operation with 403. Callers skip this for system users.
 */
export function secureNestedOperations(
    ops: Record<string, any>,
    relation: RelationConfig,
    ctx: NestedOperationContext
): Record<string, any> {
    const model = relation.object;
    const create = (data: Record<string, any>) => {
        if (!ctx.canCreate(data)) throw new ErrorResponse(403, 'no_permission_to_create', { model });
        return ctx.cleanData(data);
    };
    // Linking or unlinking rows that hold the foreign key rewrites them — their update rule too
    const rewritesRelated = linkRewritesRelated(relation);
    const linkable = (): void => {
        deny(ctx.accessFilter, 'no_permission', model);
        if (rewritesRelated) deny(ctx.updateFilter, 'no_permission_to_update', model);
    };
    const linkUnique = (where: Record<string, any>) =>
        scopeUnique(scopeUnique(where, ctx.accessFilter), rewritesRelated ? ctx.updateFilter : null);
    const out: Record<string, any> = {};

    for (const [op, value] of Object.entries(ops)) {
        switch (op) {
            case 'connect':
            case 'set':
                linkable();
                out[op] = mapItems(value, linkUnique);
                break;

            case 'disconnect':
                if (typeof value === 'boolean') {
                    if (value && rewritesRelated) {
                        // The other side of a to-one: unlinking rewrites its row
                        deny(ctx.updateFilter, 'no_permission_to_update', model);
                        out[op] = isEmpty(ctx.updateFilter) ? true : scopeWhere(undefined, ctx.updateFilter);
                    } else {
                        out[op] = value;
                    }
                } else {
                    linkable();
                    out[op] = relation.isList
                        ? mapItems(value, linkUnique)
                        : scopeWhere(scopeWhere(value, ctx.accessFilter), rewritesRelated ? ctx.updateFilter : null);
                }
                break;

            case 'create':
                out[op] = mapItems(value, create);
                break;

            case 'createMany':
                out[op] = { ...value, data: mapItems(value?.data ?? [], create) };
                break;

            case 'connectOrCreate':
                linkable();
                out[op] = mapItems(value, (item) => ({
                    ...item,
                    where: linkUnique(item.where),
                    create: create(item.create ?? {}),
                }));
                break;

            case 'update':
                deny(ctx.updateFilter, 'no_permission_to_update', model);
                if (relation.isList) {
                    out[op] = mapItems(value, (item) => ({
                        ...item,
                        where: scopeUnique(item.where, ctx.updateFilter),
                        data: ctx.cleanData(item.data ?? {}),
                    }));
                } else if (isWhereDataForm(value)) {
                    out[op] = { where: scopeWhere(value.where, ctx.updateFilter), data: ctx.cleanData(value.data) };
                } else {
                    out[op] = isEmpty(ctx.updateFilter)
                        ? ctx.cleanData(value)
                        : { where: scopeWhere(undefined, ctx.updateFilter), data: ctx.cleanData(value) };
                }
                break;

            case 'updateMany':
                deny(ctx.updateFilter, 'no_permission_to_update', model);
                out[op] = mapItems(value, (item) => ({
                    ...item,
                    where: scopeWhere(item.where, ctx.updateFilter),
                    data: ctx.cleanData(item.data ?? {}),
                }));
                break;

            case 'upsert':
                deny(ctx.updateFilter, 'no_permission_to_update', model);
                out[op] = mapItems(value, (item) => ({
                    ...item,
                    ...(relation.isList
                        ? { where: scopeUnique(item.where, ctx.updateFilter) }
                        : (item.where || !isEmpty(ctx.updateFilter)) ? { where: scopeWhere(item.where, ctx.updateFilter) } : {}),
                    create: create(item.create ?? {}),
                    update: ctx.cleanData(item.update ?? {}),
                }));
                break;

            case 'delete':
                deny(ctx.deleteFilter, 'no_permission_to_delete', model);
                if (relation.isList) {
                    out[op] = mapItems(value, (where) => scopeUnique(where, ctx.deleteFilter));
                } else if (value === true) {
                    out[op] = isEmpty(ctx.deleteFilter) ? true : scopeWhere(undefined, ctx.deleteFilter);
                } else if (value && typeof value === 'object') {
                    out[op] = scopeWhere(value, ctx.deleteFilter);
                } else {
                    out[op] = value;
                }
                break;

            case 'deleteMany':
                deny(ctx.deleteFilter, 'no_permission_to_delete', model);
                out[op] = mapItems(value, (where) => scopeWhere(where, ctx.deleteFilter));
                break;

            default:
                out[op] = value;
        }
    }
    return out;
}

/**
 * The data payloads inside raw operations (what create / update / upsert would WRITE) —
 * for field-level write validation of raw operations (Model.assertWritable).
 */
export function rawOperationPayloads(ops: Record<string, any>, isList: boolean): Record<string, any>[] {
    const payloads: Record<string, any>[] = [];
    const push = (data: unknown) => {
        if (data && typeof data === 'object' && !Array.isArray(data)) payloads.push(data as Record<string, any>);
    };
    for (const [op, value] of Object.entries(ops)) {
        if (!value || typeof value !== 'object') continue;
        switch (op) {
            case 'create': asList(value).forEach(push); break;
            case 'createMany': asList(value.data ?? []).forEach(push); break;
            case 'connectOrCreate': asList(value).forEach((item: any) => push(item?.create)); break;
            case 'update':
                if (isList) asList(value).forEach((item: any) => push(item?.data));
                else push(isWhereDataForm(value) ? value.data : value);
                break;
            case 'updateMany': asList(value).forEach((item: any) => push(item?.data)); break;
            case 'upsert': asList(value).forEach((item: any) => { push(item?.create); push(item?.update); }); break;
        }
    }
    return payloads;
}
