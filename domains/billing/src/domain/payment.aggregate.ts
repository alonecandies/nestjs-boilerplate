import { AggregateRoot } from '@nestjs/cqrs';
import { generateId, isPlatformTenantId, isUuid, type ValidationIssue } from '@platform/common';
import { isInteger, isNil, toLower, trim } from 'lodash-es';
import { BILLING_LIMITS } from '../billing.constants.js';
import { CheckoutSessionMismatchException, InvalidPaymentException } from './billing.errors.js';
import { PaymentSucceededEvent } from './events/payment-succeeded.event.js';
import { PaymentStatus } from './payment-status.enum.js';

/** The persisted state of a payment (what repositories load and save). */
export interface PaymentSnapshot {
  /** Owning tenant (never PLATFORM_TENANT_ID for a new payment). */
  readonly tenantId: string;
  readonly id: string;
  /** Owner. No FK: users live in the identity service (service boundary). */
  readonly userId: string;
  readonly priceId: string;
  readonly quantity: number;
  /** Minor currency units; `null` until Stripe priced the Checkout Session. */
  readonly amountTotal: number | null;
  /** ISO 4217, lowercase; `null` until Stripe priced the Checkout Session. */
  readonly currency: string | null;
  /**
   * Minor units Stripe reported refunded on the charge (its `amount_refunded`, net of failed
   * refunds) when the last refund event was applied; 0 until a refund event (rows from before
   * migration 0007 too, until their next refund event).
   */
  readonly amountRefunded: number;
  readonly status: PaymentStatus;
  readonly stripeCheckoutSessionId: string | null;
  readonly stripePaymentIntentId: string | null;
  /** Client `Idempotency-Key`, unique per (tenant, user). */
  readonly idempotencyKey: string | null;
  /** sha256 hex of the normalized request (ledger S-2); null before B2. */
  readonly requestHash: string | null;
  readonly paidAt: Date | null;
  /** Optimistic-lock version; every successful save increments it. */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface InitiatePaymentProps {
  /** uuidv7 chosen by the caller: it is the Checkout `client_reference_id` and idempotency seed. */
  id: string;
  tenantId: string;
  userId: string;
  priceId: string;
  quantity: number;
  idempotencyKey?: string | null | undefined;
  requestHash?: string | null | undefined;
  now: Date;
}

/** What Stripe reports when a Checkout Session is created. */
export interface CheckoutSessionDetails {
  id: string;
  amountTotal: number | null;
  currency: string | null;
}

/** What Stripe reports when a Checkout Session is paid. */
export interface CheckoutCompletion {
  sessionId: string;
  paymentIntentId: string | null;
  amountTotal: number | null;
  currency: string | null;
  paidAt: Date;
}

const OPEN_STATUSES: readonly PaymentStatus[] = [PaymentStatus.Pending, PaymentStatus.Failed];
/** Paid: what Stripe's refunded total applies to (a disputed payment keeps its status). */
const REFUND_TRACKED_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.Succeeded,
  PaymentStatus.PartiallyRefunded,
  PaymentStatus.Refunded,
  PaymentStatus.Disputed,
];
/** Paid and not refunded in full: what a dispute's withdrawal applies to. */
const DISPUTABLE_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.Succeeded,
  PaymentStatus.PartiallyRefunded,
];

const ISO_4217_CODE = /^[a-z]{3}$/;

/**
 * Stripe currency → lowercase ISO 4217 code, or `null` when absent or not a 3-letter code (`""`
 * included), so callers fall back to the stored currency instead of persisting a value that the
 * `billing.payment-succeeded.v1` schema (`length(3)`) would reject.
 */
export const normalizeCurrency = (currency: string | null | undefined): string | null => {
  if (isNil(currency)) return null;
  const code = toLower(trim(currency));
  return ISO_4217_CODE.test(code) ? code : null;
};

/**
 * Payment aggregate: one Stripe Checkout of `quantity × priceId` for a user. It owns the status
 * machine (see `PaymentStatus`) and applies `PaymentSucceededEvent` exactly once. Transition
 * methods return `false` instead of throwing when the transition does not apply (a replayed or
 * out-of-order Stripe event), so webhook handling stays idempotent. Pure domain logic: persistence
 * happens in `PaymentsRepository`, events are published by the handler after its transaction.
 */
export class Payment extends AggregateRoot {
  private state: PaymentSnapshot;

  private constructor(state: PaymentSnapshot) {
    super();
    this.state = state;
  }

  /** A new `pending` payment awaiting its Checkout Session. */
  static initiate(props: InitiatePaymentProps): Payment {
    const priceId = trim(props.priceId);
    const issues: ValidationIssue[] = [];
    if (priceId.length === 0 || priceId.length > BILLING_LIMITS.PRICE_ID_MAX_LENGTH) {
      issues.push({
        path: 'priceId',
        message: `Must be 1-${BILLING_LIMITS.PRICE_ID_MAX_LENGTH} characters`,
      });
    }
    if (
      !isInteger(props.quantity) ||
      props.quantity < 1 ||
      props.quantity > BILLING_LIMITS.MAX_QUANTITY
    ) {
      issues.push({
        path: 'quantity',
        message: `Must be an integer between 1 and ${BILLING_LIMITS.MAX_QUANTITY}`,
      });
    }
    if (trim(props.userId).length === 0) {
      issues.push({ path: 'userId', message: 'Must not be empty' });
    }
    if (!isUuid(props.tenantId) || isPlatformTenantId(props.tenantId)) {
      issues.push({ path: 'tenantId', message: 'Must be the UUID of a tenant' });
    }
    if (issues.length > 0) throw new InvalidPaymentException(issues);

    return new Payment({
      tenantId: props.tenantId,
      id: props.id,
      userId: props.userId,
      priceId,
      quantity: props.quantity,
      amountTotal: null,
      currency: null,
      amountRefunded: 0,
      status: PaymentStatus.Pending,
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
      idempotencyKey: props.idempotencyKey ?? null,
      requestHash: props.requestHash ?? null,
      paidAt: null,
      version: 0,
      createdAt: props.now,
      updatedAt: props.now,
    });
  }

  /** Rehydrates a persisted payment (no events). */
  static restore(snapshot: PaymentSnapshot): Payment {
    return new Payment({ ...snapshot });
  }

  get id(): string {
    return this.state.id;
  }

  get userId(): string {
    return this.state.userId;
  }

  get tenantId(): string {
    return this.state.tenantId;
  }

  get requestHash(): string | null {
    return this.state.requestHash;
  }

  get priceId(): string {
    return this.state.priceId;
  }

  get quantity(): number {
    return this.state.quantity;
  }

  /** Minor units; the quote until the payment completes, then what Stripe charged. */
  get amountTotal(): number | null {
    return this.state.amountTotal;
  }

  get status(): PaymentStatus {
    return this.state.status;
  }

  /** Minor units refunded, net of failed refunds (Stripe's total at the last refund event). */
  get amountRefunded(): number {
    return this.state.amountRefunded;
  }

  get stripeCheckoutSessionId(): string | null {
    return this.state.stripeCheckoutSessionId;
  }

  /** ISO 4217, lowercase; `null` until Stripe priced the Checkout Session. */
  get currency(): string | null {
    return this.state.currency;
  }

  get version(): number {
    return this.state.version;
  }

  /** Whether a replay of an idempotent checkout request asks for the same thing. */
  matchesRequest(request: { priceId: string; quantity: number }): boolean {
    return this.state.priceId === trim(request.priceId) && this.state.quantity === request.quantity;
  }

  /** S-2: a stored hash must equal the replay's; payments created before B2 have none. */
  matchesRequestHash(hash: string): boolean {
    return this.state.requestHash === null || this.state.requestHash === hash;
  }

  /**
   * Binds the Checkout Session Stripe created (or replayed) for this payment. A payment whose
   * session creation failed (`failed`, no session) is reopened as `pending` by a retried
   * idempotent request. Replays of an already bound session never change the status — a paid,
   * expired or async-failed payment stays so. Returns `false` when nothing changed.
   * @throws CheckoutSessionMismatchException the payment already belongs to another session
   */
  attachCheckoutSession(session: CheckoutSessionDetails, now: Date): boolean {
    const current = this.state.stripeCheckoutSessionId;
    if (current !== null && current !== session.id) {
      throw new CheckoutSessionMismatchException(this.state.id);
    }
    const amountTotal = this.state.amountTotal ?? session.amountTotal;
    const currency = this.state.currency ?? normalizeCurrency(session.currency);
    if (current !== null) {
      // Replay of the creation response: only fill pricing that is still missing.
      if (amountTotal === this.state.amountTotal && currency === this.state.currency) return false;
      this.state = { ...this.state, amountTotal, currency, updatedAt: now };
      return true;
    }
    if (!OPEN_STATUSES.includes(this.state.status)) {
      // Paid/expired without a bound session cannot happen through Stripe: refuse to guess.
      throw new CheckoutSessionMismatchException(this.state.id);
    }
    this.state = {
      ...this.state,
      status: PaymentStatus.Pending,
      stripeCheckoutSessionId: session.id,
      amountTotal: session.amountTotal ?? this.state.amountTotal,
      currency: normalizeCurrency(session.currency) ?? this.state.currency,
      updatedAt: now,
    };
    return true;
  }

  /**
   * `pending` → `succeeded`, applying `PaymentSucceededEvent` (also from `failed`: an async
   * payment that was retried). Returns `false` for replays (already succeeded), expired payments,
   * sessions that do not belong to this payment, and when no currency or no amount is known (neither
   * Stripe's completion nor the stored pricing has one): `PaymentSucceededEvent` must carry a valid
   * ISO 4217 code and a real amount, so the payment is left untouched rather than announced with a
   * blank currency or a zero amount.
   */
  complete(completion: CheckoutCompletion, now: Date): boolean {
    const current = this.state.stripeCheckoutSessionId;
    if (!OPEN_STATUSES.includes(this.state.status)) return false;
    if (current !== null && current !== completion.sessionId) return false;

    const currency =
      normalizeCurrency(completion.currency) ?? normalizeCurrency(this.state.currency);
    // What Stripe charged wins over the quote; with neither, refuse rather than record 0.
    const amountTotal = completion.amountTotal ?? this.state.amountTotal;
    if (currency === null || amountTotal === null) return false;
    this.state = {
      ...this.state,
      status: PaymentStatus.Succeeded,
      stripeCheckoutSessionId: completion.sessionId,
      stripePaymentIntentId: completion.paymentIntentId ?? this.state.stripePaymentIntentId,
      amountTotal,
      currency,
      paidAt: completion.paidAt,
      updatedAt: now,
    };
    this.apply(
      new PaymentSucceededEvent(
        generateId(),
        this.state.id,
        this.state.userId,
        completion.sessionId,
        amountTotal,
        currency,
        completion.paidAt,
        this.state.stripePaymentIntentId,
        this.state.tenantId,
      ),
    );
    return true;
  }

  /** `pending` → `failed` (session creation failed, or an async payment was declined). */
  markFailed(now: Date): boolean {
    if (this.state.status !== PaymentStatus.Pending) return false;
    this.state = { ...this.state, status: PaymentStatus.Failed, updatedAt: now };
    return true;
  }

  /** `pending`/`failed` → `expired` (the Checkout Session expired unpaid). */
  expire(now: Date): boolean {
    if (!OPEN_STATUSES.includes(this.state.status)) return false;
    this.state = { ...this.state, status: PaymentStatus.Expired, updatedAt: now };
    return true;
  }

  /**
   * Stripe's CURRENT refunded total of the charge (`amount_refunded`, read from Stripe on every
   * refund event: `charge.refunded`, `refund.updated`, `refund.failed`; ledger S-6), stored as is.
   * The status follows from it: `0` → `succeeded`, below `amountTotal` → `partially_refunded`, at
   * least `amountTotal` → `refunded`; a `disputed` payment records the total and stays disputed
   * (its reinstatement reads it). Absolute, not a delta: replayed or out-of-order events converge
   * on Stripe's state (a refund that failed is simply no longer in the total). Returns `false` when
   * nothing changes: a payment never paid (`pending`, `failed`, `expired`), the same total again,
   * or a total that is not a non-negative integer.
   */
  refund(amountRefunded: number, now: Date): boolean {
    if (!REFUND_TRACKED_STATUSES.includes(this.state.status)) return false;
    if (!isInteger(amountRefunded) || amountRefunded < 0) return false;
    const status =
      this.state.status === PaymentStatus.Disputed
        ? PaymentStatus.Disputed
        : this.paidStatusOf(amountRefunded);
    if (status === this.state.status && amountRefunded === this.state.amountRefunded) return false;
    this.state = { ...this.state, status, amountRefunded, updatedAt: now };
    return true;
  }

  /**
   * Funds withdrawn for a dispute (`charge.dispute.funds_withdrawn`): `succeeded` or
   * `partially_refunded` → `disputed`. Returns `false` otherwise (never paid, refunded, a repeat).
   */
  dispute(now: Date): boolean {
    if (!DISPUTABLE_STATUSES.includes(this.state.status)) return false;
    this.state = { ...this.state, status: PaymentStatus.Disputed, updatedAt: now };
    return true;
  }

  /**
   * Funds reinstated after a won dispute (`charge.dispute.funds_reinstated`): `disputed` → the
   * status the stored refunded total gives (as `refund`): `partially_refunded` while refunds
   * remain, else `succeeded`. Returns `false` from any other status.
   */
  reinstate(now: Date): boolean {
    if (this.state.status !== PaymentStatus.Disputed) return false;
    const status = this.paidStatusOf(this.state.amountRefunded);
    this.state = { ...this.state, status, updatedAt: now };
    return true;
  }

  /**
   * The status of a paid, undisputed payment with `amountRefunded` refunded: `succeeded` at 0,
   * `refunded` from `amountTotal` on, else `partially_refunded`.
   */
  private paidStatusOf(amountRefunded: number): PaymentStatus {
    if (amountRefunded <= 0) return PaymentStatus.Succeeded;
    const total = this.state.amountTotal;
    return total !== null && amountRefunded >= total
      ? PaymentStatus.Refunded
      : PaymentStatus.PartiallyRefunded;
  }

  /** Called by the repository after a successful optimistic-locked save. */
  markPersisted(): void {
    this.state = { ...this.state, version: this.state.version + 1 };
  }

  toSnapshot(): PaymentSnapshot {
    return { ...this.state };
  }
}
