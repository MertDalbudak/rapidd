import type { AclConfig } from '../types';

/**
 * Access control — one entry per model. Every hook receives the signed-in user: whatever your
 * user table or identity provider gives (ids, flags, relations, groups). Rapidd assumes
 * nothing about it but `id`.
 *
 *   canCreate(user, data)     may the user create this record?          missing: yes
 *   getAccessFilter(user)     rows the user may read                     missing: all
 *   getUpdateFilter(user)     rows the user may update                   missing: all
 *   getDeleteFilter(user)     rows the user may delete                   missing: all
 *                             → true (all rows), false (none) or a Prisma where
 *   getOmitFields(user)       fields never returned to the user
 *   getWritableFields(user)   the only fields the user may write (null: all)
 *
 * @example
 * post: {
 *     getAccessFilter: (user) => (user.is_admin ? true : { author_id: user.id }),
 *     getUpdateFilter: (user) => ({ author_id: user.id }),
 *     getOmitFields: () => ['internal_notes'],
 * },
 *
 * Models without an entry follow ACL_DEFAULT: allow (unrestricted) or deny (closed).
 * Without sign-in (AUTH_PROVIDERS=none) the user is { id: null } — an ownership filter on
 * user.id would then match rows whose owner IS NULL.
 */
const acl: AclConfig = {
    model: {},
};

export default acl;
