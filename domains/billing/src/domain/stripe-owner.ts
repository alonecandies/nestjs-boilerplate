import { isPlatformTenantId, isUuid, PLATFORM_TENANT_ID } from '@platform/common';

/** Who a Stripe object belongs to, as signed into its metadata at checkout (B2-26, ledger D5). */
export interface StripeOwner {
  /** The payment's tenant, or `PLATFORM_TENANT_ID` when the object carries none. */
  readonly tenantId: string;
  /** The paying user; `null` for platform-level objects (payouts, fees). */
  readonly userId: string | null;
}

/** Objects without tenant metadata: payouts, unattributed fees, sessions created before B2. */
export const PLATFORM_OWNER: StripeOwner = Object.freeze({
  tenantId: PLATFORM_TENANT_ID,
  userId: null,
});

/**
 * Reads `metadata.tenantId` / `metadata.userId` of a Stripe object (Checkout Session, PaymentIntent,
 * Charge: checkout mirrors the metadata onto the PaymentIntent). Only signed data reaches this
 * function (the webhook verified the signature first). Anything that is not a tenant UUID falls back
 * to the platform owner, never to a guess. A nil-UUID `userId` counts as no user.
 */
export function stripeOwnerOf(object: unknown): StripeOwner {
  const metadata = (object as { metadata?: unknown } | null | undefined)?.metadata;
  if (typeof metadata !== 'object' || metadata === null) return PLATFORM_OWNER;
  const { tenantId, userId } = metadata as Record<string, unknown>;
  if (!isUuid(tenantId) || isPlatformTenantId(tenantId)) return PLATFORM_OWNER;
  // The nil UUID is the platform sentinel, not a user: createPrincipal rejects it, so a signed event
  // naming it would throw and Stripe would retry forever. Treat it as no user (the no-principal path).
  return { tenantId, userId: isUuid(userId) && !isPlatformTenantId(userId) ? userId : null };
}
