import { describe, expect, it } from 'vitest';
import {
  impliedTenantRoles,
  isTenantRole,
  normalizeTenantRoles,
  satisfiesTenantRole,
  TENANT_ROLES,
} from './tenant-role.js';

describe('tenant roles', () => {
  it('lists owner, admin and member in canonical order', () => {
    expect(TENANT_ROLES).toEqual(['owner', 'admin', 'member']);
  });

  it('narrows untrusted values (legacy global roles are not tenant roles)', () => {
    expect(TENANT_ROLES.every(isTenantRole)).toBe(true);
    for (const value of ['user', 'moderator', 'Owner', '', null, undefined, 1, {}]) {
      expect(isTenantRole(value)).toBe(false);
    }
  });

  it('implies owner ⊇ admin ⊇ member, the role itself first', () => {
    expect(impliedTenantRoles('owner')).toEqual(['owner', 'admin', 'member']);
    expect(impliedTenantRoles('admin')).toEqual(['admin', 'member']);
    expect(impliedTenantRoles('member')).toEqual(['member']);
  });

  it('checks a requirement through the hierarchy', () => {
    expect(satisfiesTenantRole(['owner'], 'admin')).toBe(true);
    expect(satisfiesTenantRole(['admin'], 'member')).toBe(true);
    expect(satisfiesTenantRole(['member', 'admin'], 'admin')).toBe(true);
    expect(satisfiesTenantRole(['member'], 'admin')).toBe(false);
    expect(satisfiesTenantRole(['admin'], 'owner')).toBe(false);
    expect(satisfiesTenantRole([], 'member')).toBe(false);
  });

  it('normalizes: unknown values dropped, duplicates removed, canonical order', () => {
    expect(normalizeTenantRoles(['member', 'root', 'owner', 'member', 7])).toEqual([
      'owner',
      'member',
    ]);
    expect(normalizeTenantRoles([])).toEqual([]);
  });
});
