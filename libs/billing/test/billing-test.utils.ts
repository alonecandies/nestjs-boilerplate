/*
 * Test doubles for the billing context: an in-memory store behind both repositories (with
 * transaction snapshots, so rollback behaviour is observable), a TransactionHost wired to it,
 * a real StripeService with a test webhook secret and signed webhook builders.
 */
import { generateId } from '@app/common';
import { stripeConfig } from '@app/config';
import { type DrizzleDB, type DrizzleTransactionalAdapter, TransactionHost } from '@app/database';
import { createStripeClient, StripeService } from '@app/payments';
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { cloneDeep } from 'lodash-es';
import Stripe from 'stripe';
import type {
  CreatePaymentResult,
  ListPaymentsCriteria,
  PaymentsRepository,
} from '../src/application/repositories/payments.repository.js';
import type {
  StripeEventReceipt,
  StripeEventsRepository,
} from '../src/application/repositories/stripe-events.repository.js';
import { PaymentConcurrentlyModifiedException } from '../src/domain/billing.errors.js';
import { Payment, type PaymentSnapshot } from '../src/domain/payment.aggregate.js';
import { payments } from '../src/infrastructure/persistence/billing.schema.js';
import { toPaymentRow } from '../src/infrastructure/persistence/payment-row.mapper.js';

export const TEST_WEBHOOK_SECRET = 'whsec_billing_unit_test_secret';
export const testStripeConfig = stripeConfig.parse({
  STRIPE_SECRET_KEY: 'sk_test_billing_unit',
  STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  STRIPE_SUCCESS_URL: 'https://shop.test/billing/success',
  STRIPE_CANCEL_URL: 'https://shop.test/billing/cancel',
});

/** Real StripeService (real signature verification, no network) with the test secret. */
export function createTestStripeService(): StripeService {
  return new StripeService(createStripeClient(testStripeConfig), testStripeConfig);
}

// ---------------------------------------------------------------------------------------------
// In-memory persistence
// ---------------------------------------------------------------------------------------------

interface StoreState {
  payments: Map<string, PaymentSnapshot>;
  events: Map<string, StripeEventReceipt>;
}

export class InMemoryBillingStore {
  state: StoreState = { payments: new Map(), events: new Map() };

  snapshot(): StoreState {
    return cloneDeep(this.state);
  }

  restore(snapshot: StoreState): void {
    this.state = snapshot;
  }

  seed(...payments: Payment[]): void {
    for (const payment of payments) this.state.payments.set(payment.id, payment.toSnapshot());
  }

  payment(id: string): PaymentSnapshot | undefined {
    return this.state.payments.get(id);
  }
}

export class InMemoryPaymentsRepository implements PaymentsRepository {
  constructor(readonly store: InMemoryBillingStore) {}

  async create(payment: Payment): Promise<CreatePaymentResult> {
    const s = payment.toSnapshot();
    if (s.idempotencyKey !== null) {
      const existing = [...this.store.state.payments.values()].find(
        (p) => p.userId === s.userId && p.idempotencyKey === s.idempotencyKey,
      );
      if (existing) return { payment: Payment.restore(existing), created: false };
    }
    this.store.state.payments.set(s.id, s);
    return { payment: Payment.restore(s), created: true };
  }

  async findById(id: string): Promise<Payment | null> {
    const s = this.store.state.payments.get(id);
    return s ? Payment.restore(s) : null;
  }

  async findForCheckoutSession(ref: {
    paymentId: string | null;
    sessionId: string;
  }): Promise<Payment | null> {
    const all = [...this.store.state.payments.values()];
    const s =
      all.find((p) => p.stripeCheckoutSessionId === ref.sessionId) ??
      all.find((p) => p.id === ref.paymentId);
    return s ? Payment.restore(s) : null;
  }

  async save(payment: Payment): Promise<void> {
    const s = payment.toSnapshot();
    const stored = this.store.state.payments.get(s.id);
    if (!stored || stored.version !== s.version) {
      throw new PaymentConcurrentlyModifiedException(s.id);
    }
    this.store.state.payments.set(s.id, { ...s, version: s.version + 1 });
    payment.markPersisted();
  }

  async list(criteria: ListPaymentsCriteria): Promise<Payment[]> {
    return [...this.store.state.payments.values()]
      .filter((p) => criteria.userId === undefined || p.userId === criteria.userId)
      .sort((a, b) => b.id.localeCompare(a.id))
      .slice(0, criteria.limit)
      .map((p) => Payment.restore(p));
  }
}

export class InMemoryStripeEventsRepository implements StripeEventsRepository {
  constructor(readonly store: InMemoryBillingStore) {}

  async markProcessed(event: StripeEventReceipt): Promise<boolean> {
    if (this.store.state.events.has(event.id)) return false;
    this.store.state.events.set(event.id, { ...event });
    return true;
  }
}

export interface TestTransactions {
  begun: number;
  rolledBack: number;
  /** `true` while a `@Transactional()` method runs. */
  active: boolean;
  /** The registered host (provide it as `TransactionHost` in testing modules). */
  host: TransactionHost<DrizzleTransactionalAdapter>;
}

/**
 * Registers the default `TransactionHost` (what `@Transactional()` resolves) whose `tx` is
 * `instance` (a recording Drizzle handle, or an opaque marker). With a `store`, BEGIN snapshots
 * it and ROLLBACK restores it, so rollback semantics are observable with in-memory repositories.
 */
export function installTestTransactionHost(
  store?: InMemoryBillingStore,
  instance: unknown = { transaction: true },
): TestTransactions {
  const tx = { begun: 0, rolledBack: 0, active: false } as TestTransactions;
  tx.host = new TransactionHost<DrizzleTransactionalAdapter>({
    connectionName: undefined,
    enableTransactionProxy: false,
    defaultTxOptions: {},
    extraProviderTokens: [],
    getFallbackInstance: () => instance as never,
    wrapWithTransaction: async (_options, fn, setTx) => {
      const before = store?.snapshot();
      tx.begun += 1;
      tx.active = true;
      setTx(instance as never);
      try {
        return await fn();
      } catch (error) {
        tx.rolledBack += 1;
        if (store && before) store.restore(before);
        throw error;
      } finally {
        tx.active = false;
      }
    },
  });
  return tx;
}

// ---------------------------------------------------------------------------------------------
// Recording Drizzle (real query builder + dialect, fake postgres.js client)
// ---------------------------------------------------------------------------------------------

export interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/**
 * A real Drizzle handle (`casing: 'snake_case'`, like `DatabaseModule`) over a fake postgres.js
 * client: every statement is recorded and answered by `respond` (rows as positional arrays, the
 * shape drizzle's postgres-js session reads with `.values()`).
 */
export function createRecordingDrizzle(respond: (query: RecordedQuery) => unknown[][] = () => []): {
  db: DrizzleDB;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe: (sqlText: string, params: unknown[]) => {
      const query = { sql: sqlText, params };
      queries.push(query);
      const rows = respond(query);
      return Object.assign(Promise.resolve(rows), { values: () => Promise.resolve(rows) });
    },
  };
  const db = drizzle({ client: client as never, casing: 'snake_case' }) as unknown as DrizzleDB;
  return { db, queries };
}

/** A `payments` row as the positional array postgres.js returns (column declaration order). */
export function paymentRowValues(payment: Payment): unknown[] {
  const row = toPaymentRow(payment) as Record<string, unknown>;
  return Object.keys(getTableColumns(payments)).map((column) => row[column] ?? null);
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

export function makePayment(overrides: Partial<PaymentSnapshot> = {}): Payment {
  const base = Payment.initiate({
    id: overrides.id ?? generateId(),
    userId: overrides.userId ?? generateId(),
    priceId: overrides.priceId ?? 'price_basic',
    quantity: overrides.quantity ?? 1,
    idempotencyKey: overrides.idempotencyKey ?? null,
    now: overrides.createdAt ?? new Date('2026-09-01T10:00:00.000Z'),
  }).toSnapshot();
  return Payment.restore({ ...base, ...overrides });
}

export function makeCheckoutSession(
  overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
  return {
    id: `cs_test_${generateId()}`,
    object: 'checkout.session',
    url: 'https://checkout.stripe.com/c/pay/cs_test',
    amount_total: 2_500,
    currency: 'usd',
    client_reference_id: null,
    metadata: {},
    payment_status: 'unpaid',
    payment_intent: null,
    status: 'open',
    ...overrides,
  } as Stripe.Checkout.Session;
}

export interface SignedWebhook {
  event: Stripe.Event;
  payload: Buffer;
  signature: string;
}

/** A Stripe event signed with the test secret, exactly like Stripe sends it. */
export function signedEvent(
  type: string,
  object: object,
  options: { id?: string; created?: number; secret?: string } = {},
): SignedWebhook {
  const event = {
    id: options.id ?? `evt_${generateId().replaceAll('-', '')}`,
    object: 'event',
    type,
    api_version: Stripe.API_VERSION,
    created: options.created ?? Math.floor(Date.now() / 1_000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  };
  const json = JSON.stringify(event);
  return {
    event: event as unknown as Stripe.Event,
    payload: Buffer.from(json),
    signature: Stripe.webhooks.generateTestHeaderString({
      payload: json,
      secret: options.secret ?? TEST_WEBHOOK_SECRET,
    }),
  };
}
