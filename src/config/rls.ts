import type { RlsContextFn } from '../types';
import { rlsFromConfig } from '../core/rlsRules';

/**
 * RLS (Row-Level Security) variable mapping.
 *
 * The SQL session variables set before each database query — keys become variable names
 * (e.g. `app.current_user_id`). By default they come from config/rls.json, which the setup
 * wizard edits: `{ "variables": { "current_user_id": "user.id" } }` (values: `user.<attribute>`
 * or `header.<name>`).
 *
 * For anything else, replace it with your own function. The `request` parameter is the full
 * Fastify request object — read request.user, request.headers, request.body, or any custom
 * property. Return null for a key to skip it; an empty object sets no variables.
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
const rlsContext: RlsContextFn = rlsFromConfig();

export default rlsContext;
