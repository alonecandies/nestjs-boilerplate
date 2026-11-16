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

  it('grants billing:read-all to admins until Task 10 withholds it (I-5)', () => {
    expect(rbac.resolve(['admin'])).toEqual(
      [BillingPermission.Checkout, BillingPermission.ReadAll].sort(),
    );
  });
});
