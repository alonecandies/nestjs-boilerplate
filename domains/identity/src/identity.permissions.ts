import { defineRbacFeature } from '@platform/auth';

/** Identity's permissions, declared to the RBAC registry by `IdentityApiModule` (spec §6). */
export const IdentityPermission = {
  UsersRead: 'users:read',
  MembersManage: 'members:manage',
  TenantManage: 'tenant:manage',
} as const;
export type IdentityPermission = (typeof IdentityPermission)[keyof typeof IdentityPermission];

export const IDENTITY_RBAC = defineRbacFeature({
  name: 'identity',
  permissions: Object.values(IdentityPermission),
  grants: {
    admin: [IdentityPermission.UsersRead, IdentityPermission.MembersManage],
    owner: [IdentityPermission.TenantManage],
  },
});
