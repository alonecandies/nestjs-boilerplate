import { describe, expect, it } from 'vitest';
import { RbacRegistry } from './rbac.registry.js';
import { defineRbacFeature, isPermissionName, PERMISSION_PATTERN } from './rbac-feature.js';

const ORDERS = defineRbacFeature({
  name: 'orders',
  permissions: ['orders:read', 'orders:approve'],
  grants: { member: ['orders:read'], admin: ['orders:approve'] },
});
const ALERTS = defineRbacFeature({
  name: 'alerts',
  permissions: ['alerts:read', 'alerts:manage'],
  grants: { member: ['alerts:read'], owner: ['alerts:manage'] },
});

describe('defineRbacFeature', () => {
  it('freezes a sorted, validated copy', () => {
    expect(ORDERS).toEqual({
      name: 'orders',
      permissions: ['orders:approve', 'orders:read'],
      grants: { member: ['orders:read'], admin: ['orders:approve'] },
    });
    expect(Object.isFrozen(ORDERS)).toBe(true);
    expect(Object.isFrozen(ORDERS.permissions)).toBe(true);
  });

  it.each([
    [
      'a malformed name',
      { permissions: ['Orders:Read'], grants: {} },
      /malformed permission "Orders:Read"/,
    ],
    ['a wildcard', { permissions: ['orders:*'], grants: {} }, /malformed permission "orders:\*"/],
    [
      'a duplicate',
      { permissions: ['orders:read', 'orders:read'], grants: {} },
      /duplicate permission/,
    ],
    [
      'an undeclared grant',
      { permissions: ['orders:read'], grants: { member: ['orders:raed'] } },
      /undeclared permission "orders:raed"/,
    ],
  ])('rejects %s', (_name, feature, message) => {
    expect(() => defineRbacFeature({ name: 'orders', ...feature })).toThrow(message);
  });

  it('accepts only <resource>:<action> names', () => {
    expect(PERMISSION_PATTERN.source).toBe('^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$');
    expect(isPermissionName('members:manage')).toBe(true);
    for (const bad of ['members', 'members:', ':manage', 'a:b:c', 'files:*', 7, undefined]) {
      expect(isPermissionName(bad)).toBe(false);
    }
  });
});

describe('RbacRegistry', () => {
  const registry = (): RbacRegistry => {
    const value = new RbacRegistry();
    value.register(ORDERS);
    value.register(ALERTS);
    return value;
  };

  it('resolves grants through owner ⊇ admin ⊇ member, sorted and deduplicated', () => {
    const rbac = registry();
    expect(rbac.resolve(['member'])).toEqual(['alerts:read', 'orders:read']);
    expect(rbac.resolve(['admin'])).toEqual(['alerts:read', 'orders:approve', 'orders:read']);
    expect(rbac.resolve(['owner', 'member'])).toEqual([
      'alerts:manage',
      'alerts:read',
      'orders:approve',
      'orders:read',
    ]);
    expect(rbac.resolve([])).toEqual([]);
    expect(rbac.resolve(['root' as never])).toEqual([]);
  });

  it('knows every declared permission', () => {
    const rbac = registry();
    expect(rbac.permissions()).toEqual([
      'alerts:manage',
      'alerts:read',
      'orders:approve',
      'orders:read',
    ]);
    expect(rbac.isDeclared('orders:read')).toBe(true);
    expect(rbac.isDeclared('orders:raed')).toBe(false);
  });

  it('treats the same feature registered twice (an Api module and a test module) as a no-op', () => {
    const rbac = registry();
    rbac.register(
      defineRbacFeature({
        name: 'orders',
        permissions: ['orders:read', 'orders:approve'],
        grants: { member: ['orders:read'], admin: ['orders:approve'] },
      }),
    );
    expect(rbac.resolve(['admin'])).toEqual(['alerts:read', 'orders:approve', 'orders:read']);
  });

  it('refuses a redefinition and a permission owned by another feature', () => {
    const rbac = registry();
    expect(() =>
      rbac.register(
        defineRbacFeature({ name: 'orders', permissions: ['orders:read'], grants: {} }),
      ),
    ).toThrow(/"orders" is already registered with a different vocabulary/);
    expect(() =>
      rbac.register(
        defineRbacFeature({ name: 'shipments', permissions: ['orders:read'], grants: {} }),
      ),
    ).toThrow(/owned by another feature: orders:read \(orders\)/);
  });

  it('validates hand-built features too', () => {
    expect(() =>
      new RbacRegistry().register({
        name: 'x',
        permissions: ['x:read'],
        grants: { member: ['y:read'] },
      }),
    ).toThrow(/undeclared permission "y:read"/);
  });
});
