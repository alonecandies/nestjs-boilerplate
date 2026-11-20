import { Injectable } from '@nestjs/common';
import { isPlatformTenantId, isUuid } from '@platform/common';
import { PLATFORM_OWNER, type StripeOwner, stripeOwnerOf } from '../../domain/stripe-owner.js';
import { StripeService } from '../../infrastructure/stripe/stripe.service.js';

/** The owner of a Stripe money object, the payment its metadata names, and whether one was found. */
export type ResolvedStripeOwner = StripeOwner & {
  /** `metadata.paymentId` when it is a UUID; the caller still checks it names a payment. */
  readonly paymentId: string | null;
  /** No tenant could be read: `PLATFORM_OWNER`, recorded for the platform (R4 heals it). */
  readonly unresolved: boolean;
};

const UNRESOLVED: ResolvedStripeOwner = Object.freeze({
  ...PLATFORM_OWNER,
  paymentId: null,
  unresolved: true,
});

type MetadataHolder = { readonly metadata?: unknown; readonly payment_intent?: unknown };

const metadataHolder = (object: unknown): MetadataHolder | null =>
  typeof object === 'object' && object !== null ? object : null;

/** The owner `stripeOwnerOf` reads from `holder`'s metadata, or null when it names no tenant. */
function ownerFromMetadata(holder: MetadataHolder | null): ResolvedStripeOwner | null {
  if (holder === null) return null;
  const owner = stripeOwnerOf(holder);
  if (isPlatformTenantId(owner.tenantId)) return null;
  const { paymentId } = (holder.metadata ?? {}) as Record<string, unknown>;
  return { ...owner, paymentId: isUuid(paymentId) ? paymentId : null, unresolved: false };
}

/**
 * The one owner resolver of the ledger ("Stripe owner" rule, L-11): who a Stripe money object
 * (an event's `data.object`, or a balance transaction's expanded source) belongs to.
 * 1. Its own signed metadata (`stripeOwnerOf`, B2e Task 1): no Stripe call.
 * 2. Else the metadata of its PaymentIntent (checkout signs `{ paymentId, userId, tenantId }` onto
 *    it): read from an expanded PaymentIntent, or with exactly one GET. Call it before any unit of
 *    work opens: it may reach Stripe.
 * 3. Else `PLATFORM_OWNER` with `unresolved: true`: no metadata, a missing PaymentIntent (404), a
 *    tenant that is not a UUID, or the nil tenant. Never a guess.
 * Any other Stripe failure propagates (the webhook delivery fails and Stripe retries it).
 */
@Injectable()
export class StripeOwnerResolver {
  constructor(private readonly stripe: StripeService) {}

  async resolve(object: unknown): Promise<ResolvedStripeOwner> {
    const holder = metadataHolder(object);
    const own = ownerFromMetadata(holder);
    if (own !== null) return own;

    const intent = holder?.payment_intent;
    if (typeof intent === 'string' && intent.length > 0) {
      const retrieved = await this.stripe.retrievePaymentIntent(intent);
      return ownerFromMetadata(metadataHolder(retrieved)) ?? UNRESOLVED;
    }
    // An expanded PaymentIntent carries its metadata: no GET.
    return ownerFromMetadata(metadataHolder(intent)) ?? UNRESOLVED;
  }
}
