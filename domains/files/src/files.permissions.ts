import { defineRbacFeature } from '@platform/auth';

/** Files permissions, declared to the RBAC registry by FilesModule (spec §6). */
export const FilesPermission = {
  Read: 'files:read',
  Write: 'files:write',
  Manage: 'files:manage',
} as const;
export type FilesPermission = (typeof FilesPermission)[keyof typeof FilesPermission];
export const FILES_RBAC = defineRbacFeature({
  name: 'files',
  permissions: Object.values(FilesPermission),
  // files:manage = any file of the caller's active tenant: keys live under tenants/<tid>/ (B4-3).
  grants: {
    member: [FilesPermission.Read, FilesPermission.Write],
    admin: [FilesPermission.Manage],
  },
});
