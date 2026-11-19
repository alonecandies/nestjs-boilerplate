import type { LedgerPostingRequestedPayload } from '@domain/billing-contracts';
import { Inject, Injectable } from '@nestjs/common';
import { DomainValidationException } from '@platform/common';
import Stripe from 'stripe';
import type { PostingBalanceTransaction } from '../../application/ledger/posting-rules.js';
import { BillingErrorCode } from '../../billing.constants.js';
import { type StripeConfig, stripeConfig } from './stripe.config.js';
import { InjectStripe, STRIPE_WEBHOOK_TOLERANCE_SEC } from './stripe.constants.js';
import { toPaymentDomainException } from './stripe.errors.js';
import type { StripeCheckoutSessionInput } from './stripe.types.js';

/** The Stripe objects a ledger posting names (`LedgerPostingRequestedPayload['objectType']`). */
export type LedgerSourceObjectType = LedgerPostingRequestedPayload['objectType'];

/** What `StripeService.ledgerSource` found: the balance transactions to post, in Stripe's order. */
export interface LedgerSource {
  readonly transactions: readonly PostingBalanceTransaction[];
  /** Stripe has no balance transaction for the object yet (the fee is not known). */
  readonly pending: boolean;
  /** What the customer paid (or was refunded), in presentment currency; null for platform money. */
  readonly presentment: { readonly amount: bigint; readonly currency: string } | null;
}

/** The half-open window `[from, to)` of a balance-transaction listing. */
export interface StripeListWindow {
  readonly from: Date;
  readonly to: Date;
}

/** Stripe's page size for the auto-paginated listings (its maximum). */
const STRIPE_LIST_PAGE_SIZE = 100;
/** Live secret or restricted keys; test keys start with `sk_test_` / `rk_test_`. */
const LIVE_KEY = /^(sk|rk)_live_/;

/** The fields of a balance transaction the posting rules read (`PostingBalanceTransaction`). */
function toPostingTransaction(txn: Stripe.BalanceTransaction): PostingBalanceTransaction {
  return {
    id: txn.id,
    amount: txn.amount,
    fee: txn.fee,
    currency: txn.currency,
    created: txn.created,
    reporting_category: txn.reporting_category,
    source: txn.source,
  };
}

/** The amount and currency of a charge, refund or dispute (lowercase ISO 4217); else null. */
function presentmentOf(object: object): LedgerSource['presentment'] {
  const { amount, currency } = object as { amount?: unknown; currency?: unknown };
  if (typeof amount !== 'number' || typeof currency !== 'string') return null;
  return { amount: BigInt(amount), currency: currency.toLowerCase() };
}

/**
 * Thin, typed facade over the Stripe SDK used by the billing domain. It owns the two concerns
 * that must be done identically everywhere: idempotent writes and webhook signature
 * verification — and it translates SDK errors into `DomainException`s.
 */
@Injectable()
export class StripeService {
  /** Whether the configured key is a live one: the `livemode` of everything this client lists. */
  readonly livemode: boolean;

  constructor(
    @InjectStripe() readonly client: Stripe,
    @Inject(stripeConfig.KEY) private readonly cfg: StripeConfig,
  ) {
    this.livemode = LIVE_KEY.test(cfg.secretKey);
  }

  /**
   * Creates a hosted Checkout Session (`mode: 'payment'`). Pass an `idempotencyKey` derived from a
   * business id (e.g. `checkout-${paymentId}`): a client retry then returns the SAME session
   * instead of creating a second one (Stripe keeps keys for 24h).
   */
  async createCheckoutSession(
    input: StripeCheckoutSessionInput,
    idempotencyKey?: string,
  ): Promise<Stripe.Checkout.Session> {
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      customer_email: input.customerEmail,
      client_reference_id: input.clientReferenceId,
      line_items: [{ price: input.priceId, quantity: input.quantity }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: input.metadata,
      // Also on the PaymentIntent so `payment_intent.*` webhooks can be correlated without a lookup.
      payment_intent_data: { metadata: input.metadata },
    };
    try {
      return await this.client.checkout.sessions.create(
        params,
        idempotencyKey === undefined ? undefined : { idempotencyKey },
      );
    } catch (error) {
      throw toPaymentDomainException(error) ?? error;
    }
  }

  /** The current state of a Checkout Session (a GET: naturally idempotent). */
  async retrieveCheckoutSession(id: string): Promise<Stripe.Checkout.Session> {
    try {
      return await this.client.checkout.sessions.retrieve(id);
    } catch (error) {
      throw toPaymentDomainException(error) ?? error;
    }
  }

  /**
   * A PaymentIntent by id (a GET: naturally idempotent), for its signed owner metadata (L-11), or
   * `null` when Stripe has no such PaymentIntent (404). Never call it inside a unit of work.
   * @throws DomainException any other Stripe failure (translated; the caller's delivery is retried)
   */
  async retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent | null> {
    try {
      return await this.client.paymentIntents.retrieve(id);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.statusCode === 404) return null;
      throw toPaymentDomainException(error) ?? error;
    }
  }

  /**
   * The balance transactions a posting request's Stripe object moved money with (L-12), by GETs
   * only (naturally idempotent; never call it inside a unit of work):
   * - `charge`: its `balance_transaction`; presentment = the charge's amount and currency;
   * - `refund`: its `balance_transaction` and, once it failed, its `failure_balance_transaction`;
   *   presentment = the refund's;
   * - `dispute`: every entry of `balance_transactions`; presentment = the dispute's;
   * - `payout`: its `balance_transaction` and, once it failed, its `failure_balance_transaction`;
   *   no presentment (platform money);
   * - `balance_transaction` (reconciliation R4): the transaction itself, its expanded source
   *   giving the presentment as above.
   * `pending` when Stripe has no balance transaction for the object yet (async methods).
   * @throws DomainException translated Stripe failures: a missing object (404) is
   *   `PAYMENT_REQUEST_INVALID` (422); 5xx and network errors `PAYMENT_PROVIDER_ERROR`; 429
   *   `PAYMENT_PROVIDER_RATE_LIMITED`
   */
  async ledgerSource(objectType: LedgerSourceObjectType, objectId: string): Promise<LedgerSource> {
    try {
      return await this.fetchLedgerSource(objectType, objectId);
    } catch (error) {
      throw toPaymentDomainException(error) ?? error;
    }
  }

  /**
   * Every balance transaction with `created` in `[from, to)` (reconciliation R4), auto-paginated
   * (100 per page; the next page is fetched only when the previous one is consumed), each with
   * its `source` expanded so its owner resolves without another GET. Stripe's `created` is whole
   * seconds: `created[gte] = ceil(from)`, `created[lt] = ceil(to)`. GETs only (naturally
   * idempotent); never iterate it inside a unit of work.
   * @throws DomainException the translated Stripe failure of the page that failed (as
   *   `ledgerSource`); the rows yielded before it stay yielded
   */
  async *listBalanceTransactions(
    window: StripeListWindow,
  ): AsyncIterable<Stripe.BalanceTransaction> {
    const list = this.client.balanceTransactions.list({
      created: {
        gte: Math.ceil(window.from.getTime() / 1000),
        lt: Math.ceil(window.to.getTime() / 1000),
      },
      limit: STRIPE_LIST_PAGE_SIZE,
      expand: ['data.source'],
    });
    try {
      for await (const txn of list) yield txn;
    } catch (error) {
      throw toPaymentDomainException(error) ?? error;
    }
  }

  private async fetchLedgerSource(
    objectType: LedgerSourceObjectType,
    objectId: string,
  ): Promise<LedgerSource> {
    const failureExpand = { expand: ['balance_transaction', 'failure_balance_transaction'] };
    switch (objectType) {
      case 'charge': {
        const charge = await this.client.charges.retrieve(objectId, {
          expand: ['balance_transaction'],
        });
        return this.sourceOf([charge.balance_transaction], presentmentOf(charge));
      }
      case 'refund': {
        const refund = await this.client.refunds.retrieve(objectId, failureExpand);
        return this.sourceOf(
          [refund.balance_transaction],
          presentmentOf(refund),
          refund.failure_balance_transaction,
        );
      }
      case 'dispute': {
        const dispute = await this.client.disputes.retrieve(objectId);
        return this.sourceOf(dispute.balance_transactions, presentmentOf(dispute));
      }
      case 'payout': {
        const payout = await this.client.payouts.retrieve(objectId, failureExpand);
        return this.sourceOf(
          [payout.balance_transaction],
          null,
          payout.failure_balance_transaction,
        );
      }
      case 'balance_transaction': {
        const txn = await this.client.balanceTransactions.retrieve(objectId, {
          expand: ['source'],
        });
        const source = txn.source;
        return this.sourceOf(
          [txn],
          typeof source === 'object' && source !== null ? presentmentOf(source) : null,
        );
      }
    }
  }

  /** `pending` when the object's own transactions are missing; a failure one is never required. */
  private async sourceOf(
    own: readonly (string | Stripe.BalanceTransaction | null | undefined)[],
    presentment: LedgerSource['presentment'],
    failure?: string | Stripe.BalanceTransaction | null,
  ): Promise<LedgerSource> {
    const present = own.filter(
      (txn): txn is string | Stripe.BalanceTransaction => txn !== null && txn !== undefined,
    );
    if (present.length === 0) return { transactions: [], pending: true, presentment };
    const all = failure === null || failure === undefined ? present : [...present, failure];
    const transactions: PostingBalanceTransaction[] = [];
    for (const txn of all) {
      const expanded =
        typeof txn === 'string' ? await this.client.balanceTransactions.retrieve(txn) : txn;
      transactions.push(toPostingTransaction(expanded));
    }
    return { transactions, pending: false, presentment };
  }

  /**
   * Verifies the `Stripe-Signature` header (HMAC-SHA256 with the endpoint secret, timestamp within
   * 5 min) and parses the event. `payload` MUST be the raw request bytes — re-serialized JSON never
   * verifies. Synchronous `constructEvent` on purpose: node:crypto HMAC is the cheapest path.
   *
   * @throws DomainValidationException `INVALID_WEBHOOK_SIGNATURE` (missing/forged/stale signature)
   *   or `INVALID_WEBHOOK_PAYLOAD` (signed but not a JSON event).
   */
  constructWebhookEvent(payload: Buffer, signature: string | undefined): Stripe.Event {
    if (!signature) {
      throw new DomainValidationException('Missing webhook signature', {
        code: BillingErrorCode.INVALID_WEBHOOK_SIGNATURE,
      });
    }
    try {
      return this.client.webhooks.constructEvent(
        payload,
        signature,
        this.cfg.webhookSecret,
        STRIPE_WEBHOOK_TOLERANCE_SEC,
      );
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
        throw new DomainValidationException('Invalid webhook signature', {
          code: BillingErrorCode.INVALID_WEBHOOK_SIGNATURE,
          cause: error,
        });
      }
      if (error instanceof SyntaxError) {
        throw new DomainValidationException('Invalid webhook payload', {
          code: BillingErrorCode.INVALID_WEBHOOK_PAYLOAD,
          cause: error,
        });
      }
      throw error;
    }
  }
}
