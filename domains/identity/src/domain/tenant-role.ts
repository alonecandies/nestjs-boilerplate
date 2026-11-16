import type { TenantRole } from '@platform/common';

/*
 * Values of the `identity.tenant_role` Postgres enum. drizzle-kit loads this file through
 * identity.schema.ts without the workspace source condition, so it stays free of runtime imports:
 * `import type` checks it against @platform/common's `TenantRole` at compile time only, and
 * tenant-role.spec.ts asserts both lists are identical.
 */
export const TENANT_ROLE_VALUES = [
  'owner',
  'admin',
  'member',
] as const satisfies readonly TenantRole[];
