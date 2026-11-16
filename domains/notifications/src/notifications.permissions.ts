import { defineRbacFeature } from '@platform/auth';

/** Notifications permissions, declared to the RBAC registry by NotificationsApiModule (spec §6). */
export const NotificationsPermission = {
  Read: 'notifications:read',
  Write: 'notifications:write',
} as const;
export type NotificationsPermission =
  (typeof NotificationsPermission)[keyof typeof NotificationsPermission];
export const NOTIFICATIONS_RBAC = defineRbacFeature({
  name: 'notifications',
  permissions: Object.values(NotificationsPermission),
  grants: { member: [NotificationsPermission.Read], admin: [NotificationsPermission.Write] },
});
