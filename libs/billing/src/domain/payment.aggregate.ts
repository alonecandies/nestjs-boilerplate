import { generateId, type ValidationIssue } from '@app/common';
import { AggregateRoot } from '@nestjs/cqrs';
import { isInteger, isNil, toLower, trim } from 'lodash-es';
import { BILLING_LIMITS } from '../billing.constants.js';
import { CheckoutSessionMismatchException, InvalidPaymentException } from './billing.errors.js';
import { PaymentSucceededEvent } from './events/payment-succeeded.event.js';
import { PaymentStatus } from './payment-status.enum.js';

/** The persisted state of a payment (what repositories load and save). */
export interface PaymentSnapshot {
  readonly id: string;
  /** Owner. No FK: users live in the identity service (service boundary). */
  readonly userId: string;
  readonly priceId: string;
  readonly quantity: number;
  /** Minor currency units; `null` until Stripe priced the Checkout Session. */
  readonly amountTotal: number | null;
  /** ISO 4217, lowercase; `null` until Stripe priced the Checkout Session. */
  readonly currency: string | null;
  readonly status: PaymentStatus;
  readonly stripeCheckoutSessionId: string | null;
  readonly stripePaymentIntentId: string | null;
  /** Client `Idempotency-Key`, unique per user. */
  readonly idempotencyKey: string | null;
  readonly paidAt: Date | null;
  /** Optimistic-lock version; every successful save increments it. */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface InitiatePaymentProps {
  /** uuidv7 chosen by the caller: it is the Checkout `client_reference_id` and idempotency seed. */
  id: string;
  userId: string;
  priceId: string;
  quantity: number;
  idempotencyKey?: string | null | undefined;
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

const normalizeCurrency = (currency: string | null): string | null =>
  isNil(currency) ? null : toLower(trim(currency));

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
    if (issues.length > 0) throw new InvalidPaymentException(issues);

    return new Payment({
      id: props.id,
      userId: props.userId,
      priceId,
      quantity: props.quantity,
      amountTotal: null,
      currency: null,
      status: PaymentStatus.Pending,
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
      idempotencyKey: props.idempotencyKey ?? null,
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

  get priceId(): string {
    return this.state.priceId;
  }

  get quantity(): number {
    return this.state.quantity;
  }

  get status(): PaymentStatus {
    return this.state.status;
  }

  get stripeCheckoutSessionId(): string | null {
    return this.state.stripeCheckoutSessionId;
  }

  get version(): number {
    return this.state.version;
  }

  /** Whether a replay of an idempotent checkout request asks for the same thing. */
  matchesRequest(request: { priceId: string; quantity: number }): boolean {
    return this.state.priceId === trim(request.priceId) && this.state.quantity === request.quantity;
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
   * payment that was retried). Returns `false` for replays (already succeeded), expired payments
   * and sessions that do not belong to this payment.
   */
  complete(completion: CheckoutCompletion, now: Date): boolean {
    const current = this.state.stripeCheckoutSessionId;
    if (!OPEN_STATUSES.includes(this.state.status)) return false;
    if (current !== null && current !== completion.sessionId) return false;

    const amountTotal = completion.amountTotal ?? this.state.amountTotal ?? 0;
    const currency = normalizeCurrency(completion.currency) ?? this.state.currency ?? '';
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

  /** Called by the repository after a successful optimistic-locked save. */
  markPersisted(): void {
    this.state = { ...this.state, version: this.state.version + 1 };
  }

  toSnapshot(): PaymentSnapshot {
    return { ...this.state };
  }
}
