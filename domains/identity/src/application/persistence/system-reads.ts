/**
 * `SystemContext.run` reasons (`<domain>.<job>`, for logs and metrics) of the reads the row-local
 * policies moved to the system pool (ruling `b3-identity-policies`): the caller asserts the scope
 * (the tenant it acts in, or itself) and the system method filters on it in SQL.
 */
export const SYSTEM_READS = Object.freeze({
  /** A user of the caller's tenant (`GetUser` with a tenant, `ListUsers`). */
  USER_DIRECTORY: 'identity.user-directory',
  /** The caller's tenant's members with profiles (`ListMembers`, the member after a role change). */
  MEMBER_DIRECTORY: 'identity.member-directory',
  /** Every tenant of the caller (`ListMyTenants`). */
  MY_TENANTS: 'identity.my-tenants',
});
