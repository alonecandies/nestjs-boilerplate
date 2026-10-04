/*
 * Billing tables. drizzle-kit loads this file with its own loader (no `@app/source` condition), so
 * it imports ONLY drizzle-orm and dependency-free relative files. Column names come from
 * `casing: 'snake_case'` (runtime + drizzle.config.ts).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { PAYMENT_STATUSES, PaymentStatus } from '../../domain/payment-status.enum.js';

const timestamptz = () => timestamp({ withTimezone: true, precision: 3, mode: 'date' });

export const paymentStatusEnum = pgEnum('payment_status', PAYMENT_STATUSES);

export const payments = pgTable(
  'payments',
  {
    // The application always supplies a uuidv7 (Payment.initiate); the PG 18 `uuidv7()` default
    // covers raw SQL inserts and seeds.
    id: uuid().primaryKey().default(sql`uuidv7()`),
    // No FK: users belong to the identity service (service boundary).
    userId: uuid().notNull(),
    priceId: text().notNull(),
    quantity: integer().notNull(),
    // Minor units. int8 read as a JS number (exact up to 2^53, far beyond any Stripe amount);
    // NULL until Stripe priced the Checkout Session.
    amountTotal: bigint({ mode: 'number' }),
    currency: text(),
    status: paymentStatusEnum().notNull().default(PaymentStatus.Pending),
    // Explicit name: drizzle-kit would derive it from the camelCase key (payments_stripeCheckout…).
    stripeCheckoutSessionId: text().unique('payments_stripe_checkout_session_id_unique'),
    stripePaymentIntentId: text(),
    // Client Idempotency-Key. NULLs never collide in a UNIQUE index, so only keyed requests dedupe.
    idempotencyKey: text(),
    paidAt: timestamptz(),
    // Optimistic lock (UPDATE ... WHERE version = $expected).
    version: integer().notNull().default(0),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // "My payments, newest first": WHERE user_id = $1 ORDER BY id DESC (uuidv7 = time order).
    // A plain ASC btree is scanned backwards for DESC (drizzle's .desc() would add NULLS LAST).
    index('payments_user_id_id_idx').on(t.userId, t.id),
    uniqueIndex('payments_user_id_idempotency_key_uq').on(t.userId, t.idempotencyKey),
  ],
);

/**
 * Processed Stripe webhook events: the primary key makes delivery idempotent
 * (`INSERT … ON CONFLICT DO NOTHING` in the same transaction as the payment update).
 */
export const stripeEvents = pgTable('stripe_events', {
  /** Stripe event id (`evt_…`). */
  id: text().primaryKey(),
  type: text().notNull(),
  processedAt: timestamptz().notNull().defaultNow(),
});

export type PaymentRow = typeof payments.$inferSelect;
export type NewPaymentRow = typeof payments.$inferInsert;
export type StripeEventRow = typeof stripeEvents.$inferSelect;

/** Everything `DatabaseModule.forRootAsync({ schema })` needs from billing (monolith: spread it). */
export const billingSchema = { paymentStatusEnum, payments, stripeEvents };
export type BillingSchema = typeof billingSchema;
