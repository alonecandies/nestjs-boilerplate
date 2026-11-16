/**
 * The nil UUID: the `tenant_id` of platform-level rows (platform Stripe events, platform ledger
 * accounts). It is never issued as a tenant (`identity.tenants` has a CHECK against it) and never
 * accepted as a runtime principal's tenant (`createPrincipal` refuses it).
 */
export const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export function isPlatformTenantId(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase() === PLATFORM_TENANT_ID;
}
