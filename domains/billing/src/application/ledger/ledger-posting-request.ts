import {
  LEDGER_POSTING_REQUESTED_EVENT,
  type LedgerPostingRequestedPayload,
} from '@domain/billing-contracts';
import type { OutboxRecord, OutboxWriter } from '@platform/outbox';
import type { KafkaPublishOptions } from '@platform/transport';
import { v5 as uuidv5 } from 'uuid';
import { LEDGER_NAMESPACE } from '../../domain/ledger/ledger.types.js';
import type { StripeOwner } from '../../domain/stripe-owner.js';

/** The Stripe event a posting comes from (a verified webhook event). */
export interface LedgerPostingSource {
  readonly id: string;
  readonly type: string;
  readonly livemode: boolean;
  /** Unix seconds: the envelope's `occurredAt`. */
  readonly created: number;
}

/** The owner of the posting and the payment it names (already checked to be the owner's). */
export type LedgerPostingOwner = StripeOwner & { readonly paymentId: string | null };

/** A payment as the ownership check reads it: its key and its user. */
export interface PostingPaymentCandidate {
  readonly tenantId: string;
  readonly id: string;
  readonly userId: string;
}

/**
 * The posting owner of a Stripe owner and the payment found for the id its metadata signed (looked
 * up under the owner's tenant, or `null`): that id is named only when the payment is the owner's,
 * the same tenant and user; else `paymentId: null`. The webhook and reconciliation R4 both build
 * their posting owner here, so the same Stripe object gives the same draft and payload hash.
 */
export function postingOwnerOf(
  owner: StripeOwner & { readonly paymentId?: string | null },
  payment: PostingPaymentCandidate | null,
): LedgerPostingOwner {
  const signed = owner.paymentId ?? null;
  const owned =
    signed !== null &&
    payment !== null &&
    payment.id === signed &&
    payment.tenantId === owner.tenantId &&
    payment.userId === owner.userId;
  return { tenantId: owner.tenantId, userId: owner.userId, paymentId: owned ? signed : null };
}

export type LedgerPostingObjectType = LedgerPostingRequestedPayload['objectType'];

/** The envelope options of a posting: every one set, none read from CLS but the correlation id. */
export interface LedgerPostingOptions extends KafkaPublishOptions {
  readonly eventId: string;
  readonly key: string;
  readonly tenantId: string;
  readonly actorId: string | null;
  readonly occurredAt: Date;
}

/** Envelope (= outbox row) id of a webhook posting: `uuidv5(LEDGER_NAMESPACE, <Stripe event id>)`. */
export function ledgerPostingEnvelopeId(stripeEventId: string): string {
  return uuidv5(stripeEventId, LEDGER_NAMESPACE);
}

/**
 * The payload and envelope options of a `billing.ledger-posting.v1` record ("Envelope ids"): the
 * deterministic envelope id, key = tenant id, tenant = the owner's (the nil UUID for platform
 * money), actor = the owner's user (`null` for platform money), `occurredAt` = the event's time.
 */
export function ledgerPostingRequest(
  event: LedgerPostingSource,
  owner: LedgerPostingOwner,
  objectType: LedgerPostingObjectType,
  objectId: string,
): {
  readonly payload: LedgerPostingRequestedPayload;
  readonly options: LedgerPostingOptions;
} {
  return {
    payload: {
      source: 'stripe',
      stripeEventId: event.id,
      stripeEventType: event.type,
      objectType,
      objectId,
      tenantId: owner.tenantId,
      userId: owner.userId,
      paymentId: owner.paymentId,
      livemode: event.livemode,
    },
    options: {
      eventId: ledgerPostingEnvelopeId(event.id),
      key: owner.tenantId,
      tenantId: owner.tenantId,
      actorId: owner.userId,
      occurredAt: new Date(event.created * 1_000),
    },
  };
}

/**
 * The validated outbox record of a posting (no SQL): what `outbox.insertAsPlatform` stores for
 * platform money; a tenant's row is the same record, written by `BillingOutbox.enqueue` as the owner.
 */
export function ledgerPostingRecord(
  outbox: OutboxWriter,
  event: LedgerPostingSource,
  owner: LedgerPostingOwner,
  objectType: LedgerPostingObjectType,
  objectId: string,
): OutboxRecord {
  const { payload, options } = ledgerPostingRequest(event, owner, objectType, objectId);
  return outbox.record(LEDGER_POSTING_REQUESTED_EVENT, payload, options);
}
