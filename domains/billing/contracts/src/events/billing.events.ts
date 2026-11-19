import { defineEventContract, type EventContract } from '@platform/contracts';
import { z } from 'zod';

/** Payload of `billing.payment-succeeded.v1`: a Stripe Checkout Session was paid. */
export const paymentSucceededPayload = z.object({
  paymentId: z.uuid(),
  userId: z.uuid(),
  stripeCheckoutSessionId: z.string().min(1),
  /** Minor currency units (cents). A JSON number: safe up to 2^53, far beyond any real amount. */
  amountTotal: z.number().int().nonnegative(),
  /** ISO 4217 code as reported by Stripe (lowercase). */
  currency: z.string().length(3),
  paidAt: z.iso.datetime(),
  /** Stripe PaymentIntent (`pi_…`): locates the charge and its balance transaction. Optional (v1). */
  stripePaymentIntentId: z.string().min(1).optional(),
});

export type PaymentSucceededPayload = z.infer<typeof paymentSucceededPayload>;

/**
 * A Checkout Session was paid. Produced by billing; notifications sends the receipt.
 * Tenant-scoped: the envelope carries the payment's tenantId and the payer as actorId.
 */
export const PAYMENT_SUCCEEDED_EVENT: EventContract<PaymentSucceededPayload> = defineEventContract(
  'billing.payment-succeeded.v1',
  paymentSucceededPayload,
  { tenantScoped: true },
);

/** What a ledger posting is about: the Stripe object whose balance transaction(s) it posts. */
export const LEDGER_POSTING_OBJECT_TYPES = [
  'charge',
  'refund',
  'dispute',
  'payout',
  'balance_transaction',
] as const;

/**
 * Payload of `billing.ledger-posting.v1` (ledger design "Interface contracts"): a Stripe money
 * event to post to the immudb ledger. Written to `billing.outbox` in the webhook's unit of work
 * (or, for platform events, by the system pool); billing's own consumer posts it (L-12).
 */
export const ledgerPostingRequestedPayload = z.object({
  source: z.literal('stripe'),
  /** Stripe `evt_…`, or `reconcile:<runId>` for a posting re-enqueued by reconciliation (R4). */
  stripeEventId: z.string().min(1),
  stripeEventType: z.string().min(1),
  objectType: z.enum(LEDGER_POSTING_OBJECT_TYPES),
  /** `ch_…`, `re_…`, `du_…`, `po_…` or `txn_…`. */
  objectId: z.string().min(1),
  /** The owner's tenant; the nil UUID (`PLATFORM_TENANT_ID`) for platform-level money. */
  tenantId: z.uuid(),
  /** The paying user; `null` for platform-level money. */
  userId: z.uuid().nullable(),
  /** Our payment, when the signed metadata names one of the owner's payments. */
  paymentId: z.uuid().nullable(),
  livemode: z.boolean(),
});

export type LedgerPostingRequestedPayload = z.infer<typeof ledgerPostingRequestedPayload>;

/**
 * A Stripe money movement to post to the ledger. Produced and consumed by billing. Tenant-scoped:
 * the envelope carries the payload's tenant (the nil UUID for platform money, key = the tenant id)
 * and the payload's user as actorId (`null` for platform money).
 */
export const LEDGER_POSTING_REQUESTED_EVENT: EventContract<LedgerPostingRequestedPayload> =
  defineEventContract('billing.ledger-posting.v1', ledgerPostingRequestedPayload, {
    tenantScoped: true,
  });
