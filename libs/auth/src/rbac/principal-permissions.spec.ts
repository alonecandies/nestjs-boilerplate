import { createPrincipal, generateId } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { createTestRbacRegistry } from '../testing/index.js';
import { principalPermissions } from './principal-permissions.js';
import { defineRbacFeature } from './rbac-feature.js';

const ORDERS = defineRbacFeature({
  name: 'orders',
  permissions: ['orders:read', 'orders:approve'],
  grants: { member: ['orders:read'], admin: ['orders:approve'] },
});

describe('principalPermissions', () => {
  const registry = createTestRbacRegistry(ORDERS);
  const userId = generateId();

  it('recomputes permissions from the tenant roles (owner ⊇ admin ⊇ member)', () => {
    const owner = createPrincipal({ userId, tenantId: generateId(), roles: ['owner'] });
    expect(principalPermissions(registry, owner)).toEqual(['orders:approve', 'orders:read']);
  });

  it('is empty without a principal or without a tenant', () => {
    expect(principalPermissions(registry, undefined)).toEqual([]);
    expect(principalPermissions(registry, createPrincipal({ userId, tenantId: null }))).toEqual([]);
  });
});
