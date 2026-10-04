/** Fine-grained capabilities, `<resource>:<action>`. Granted through roles (`ROLE_PERMISSIONS`). */
export enum Permission {
  UsersRead = 'users:read',
  UsersWrite = 'users:write',
  UsersManageRoles = 'users:manage-roles',
  NotificationsRead = 'notifications:read',
  NotificationsWrite = 'notifications:write',
  BillingCheckout = 'billing:checkout',
  BillingReadAll = 'billing:read-all',
  FilesRead = 'files:read',
  FilesWrite = 'files:write',
  FilesManage = 'files:manage',
}

/** Canonical order (declaration order) — used to return permissions deterministically. */
export const PERMISSION_VALUES: readonly Permission[] = Object.freeze(Object.values(Permission));

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSION_VALUES);

export const isPermission = (value: unknown): value is Permission =>
  typeof value === 'string' && PERMISSION_SET.has(value);
