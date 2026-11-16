import { defineRbacFeature } from '@platform/auth';

/** Billing permissions, declared to the RBAC registry by BillingApiModule (spec §6). */
export const BillingPermission = {
  Checkout: 'billing:checkout',
  ReadAll: 'billing:read-all',
} as const;
export type BillingPermission = (typeof BillingPermission)[keyof typeof BillingPermission];
export const BILLING_RBAC = defineRbacFeature({
  name: 'billing',
  permissions: Object.values(BillingPermission),
  // billing:read-all lists every payment of the ACTIVE tenant (B2-26); never another tenant's.
  grants: { member: [BillingPermission.Checkout], admin: [BillingPermission.ReadAll] },
});
