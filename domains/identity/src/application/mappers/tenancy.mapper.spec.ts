import { describe, expect, it } from 'vitest';
import type { TenantMembership } from '../persistence/memberships.repository.js';
import { normalizeTenantName, toMyTenantContract, toTenantContract } from './tenancy.mapper.js';

const tenant = {
  id: '0190c0de-0000-7000-8000-000000000001',
  slug: 'acme-00000001',
  name: 'Acme',
  personal: false,
  createdAt: new Date(500),
};
const membership = (lastActiveAt: Date | null): TenantMembership => ({
  tenantId: tenant.id,
  userId: '0190c0de-0000-7000-8000-000000000002',
  roles: ['admin', 'member'],
  lastActiveAt,
  createdAt: new Date(600),
  tenant,
});

describe('tenancy mapper', () => {
  it('toTenantContract copies the public fields', () => {
    expect(toTenantContract(tenant)).toEqual({
      id: tenant.id,
      slug: 'acme-00000001',
      name: 'Acme',
      personal: false,
      createdAt: tenant.createdAt,
    });
  });

  it('toMyTenantContract carries roles and omits lastActiveAt when null', () => {
    const never = toMyTenantContract(membership(null));
    expect(never).toMatchObject({ tenant: { name: 'Acme' }, roles: ['admin', 'member'] });
    expect(never).not.toHaveProperty('lastActiveAt');

    const at = new Date(1_000);
    expect(toMyTenantContract(membership(at)).lastActiveAt).toBe(at);
  });

  describe('normalizeTenantName', () => {
    it('trims', () => {
      expect(normalizeTenantName('  A  ')).toBe('A');
    });

    it('counts code points, not UTF-16 units', () => {
      expect(normalizeTenantName('é'.repeat(100))).toHaveLength(100);
      expect(() => normalizeTenantName('é'.repeat(101))).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    });

    it.each(['', '   '])('rejects blank %j', (name) => {
      expect(() => normalizeTenantName(name)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    });
  });
});
