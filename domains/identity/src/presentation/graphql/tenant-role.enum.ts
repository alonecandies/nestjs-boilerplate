import { registerEnumType } from '@nestjs/graphql';
import type { TenantRole } from '@platform/common';

/** GraphQL `TenantRole`: SCREAMING_CASE names, values = @platform/common `TenantRole`. */
export const TenantRoleEnum = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member',
} as const satisfies Record<string, TenantRole>;

registerEnumType(TenantRoleEnum, {
  name: 'TenantRole',
  description: 'Role in one tenant (owner ⊇ admin ⊇ member)',
  valuesMap: {
    OWNER: { description: 'Everything in the tenant, including its settings' },
    ADMIN: { description: 'Manages members and the tenant data' },
    MEMBER: { description: 'Uses the tenant' },
  },
});
