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
  grants: {
    member: [FilesPermission.Read, FilesPermission.Write],
    admin: [FilesPermission.Manage],
  },
});
