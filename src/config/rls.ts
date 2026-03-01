import type { RlsContextFn } from '../types';

/**
 * RLS (Row-Level Security) variable mapping.
 *
 * Return the SQL session variables to set before each database query.
 * Keys become variable names (e.g. `app.current_user_id`), values are set per-request.
 * Return null for a key to skip it. Return an empty object to disable RLS.
 *
 * The `request` parameter is the full Fastify request object — you can read
 * from request.user, request.headers, request.body, or any custom property.
 *
 * @example
 * // User-based isolation
 * const rlsContext: RlsContextFn = (request) => ({
 *     current_user_id: request.user?.id ?? null,
 *     current_user_role: request.user?.role ?? null,
 * });
 *
 * @example
 * // Multi-tenant from header
 * const rlsContext: RlsContextFn = (request) => ({
 *     current_tenant_id: request.headers['x-tenant-id'] ?? null,
 * });
 *
 * @example
 * // Composite: tenant + user + department
 * const rlsContext: RlsContextFn = (request) => ({
 *     current_user_id: request.user?.id ?? null,
 *     current_tenant_id: request.user?.tenantId ?? null,
 *     current_department_id: request.user?.departmentId ?? null,
 * });
 */
const rlsContext: RlsContextFn = (request) => {
    return {};
};

export default rlsContext;
