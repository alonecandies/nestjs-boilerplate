import { createTestRbacRegistry } from '@platform/auth/testing';
import { describe, expect, it } from 'vitest';
import { BILLING_RBAC, BillingPermission } from './billing.permissions.js';

describe('BILLING_RBAC', () => {
  const rbac = createTestRbacRegistry(BILLING_RBAC);

  it('declares every BillingPermission value', () => {
    expect(rbac.permissions()).toEqual(Object.values(BillingPermission).sort());
  });

  it('grants checkout to members (and so to admins and owners)', () => {
    expect(rbac.resolve(['member'])).toEqual([BillingPermission.Checkout]);
  });

  it('withholds billing:read-all from every role until B2-26 scopes it to the tenant (I-5)', () => {
    for (const role of ['member', 'admin', 'owner'] as const) {
      expect(rbac.resolve([role])).toEqual([BillingPermission.Checkout]);
    }
  });
});
