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
  // billing:read-all is declared but granted to nobody until B2-26 scopes payment listing to the tenant (I-5).
  grants: { member: [BillingPermission.Checkout] },
});
