import { createTestRbacRegistry } from '@platform/auth/testing';
import { describe, expect, it } from 'vitest';
import { NOTIFICATIONS_RBAC, NotificationsPermission } from './notifications.permissions.js';

describe('NOTIFICATIONS_RBAC', () => {
  const rbac = createTestRbacRegistry(NOTIFICATIONS_RBAC);

  it('declares every NotificationsPermission value', () => {
    expect(rbac.permissions()).toEqual(Object.values(NotificationsPermission).sort());
  });

  it('grants read to members and write to admins (owners hold both)', () => {
    expect(rbac.resolve(['member'])).toEqual([NotificationsPermission.Read]);
    expect(rbac.resolve(['admin'])).toEqual(Object.values(NotificationsPermission).sort());
    expect(rbac.resolve(['owner'])).toEqual(Object.values(NotificationsPermission).sort());
  });
});
