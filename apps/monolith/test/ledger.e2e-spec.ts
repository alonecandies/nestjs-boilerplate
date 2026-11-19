/*
 * The ledger end to end in the monolith topology (outbox plan Task 19, L-15): a signed Stripe
 * webhook → `billing.outbox` (in the unit of work of its receipt) → `OutboxRelay.tick()` → Kafka
 * (the fake producer, looped into the app's own `LedgerPostingConsumer`) → `LedgerService` →
 * `InMemoryLedger` + the receipts → the reconciliation run. In-memory stores, a fake Stripe that
 * only answers the ledger's GETs (the signature check is real) and `LEDGER_ENABLED=true`.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV, {
    STRIPE_WEBHOOK_SECRET: 'whsec_monolith_ledger_e2e',
    LEDGER_ENABLED: 'true',
    // The session pool behind the readiness check: nothing listens there (and nothing connects).
    IMMUDB_ADDRESS: '127.0.0.1:1',
  });
});

import { createHmac } from 'node:crypto';
import {
  type LedgerEntry,
  LedgerPort,
  LedgerPostingConsumer,
  type LedgerPostOutcome,
  ledgerEntryId,
  PaymentStatus,
  PLATFORM_TENANT_ID,
  payments,
  ReconcileLedgerCommand,
} from '@domain/billing';
import { LEDGER_POSTING_REQUESTED_EVENT } from '@domain/billing-contracts';
import { CommandBus } from '@nestjs/cqrs';
import { generateId, SystemContext } from '@platform/common';
import { RecordingImmudbClient } from '@platform/immudb/testing';
import type { PublishedKafkaRecord } from '@platform/transport/testing';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

const WEBHOOK_SECRET = 'whsec_monolith_ledger_e2e';
const SESSION_ID = 'cs_test_ledger_e2e';
const NOW = Date.now();
/** Ten minutes ago, whole seconds: inside every reconciliation window and past the grace. */
const CREATED = Math.floor(NOW / 1_000) - 600;
const CHARGE_TXN = 'txn_e2e_charge';
const PAYOUT_TXN = 'txn_e2e_payout';

const owner = { tenantId: generateId(), userId: generateId(), paymentId: generateId() };

/** The paid `payments` row the webhook finds (postgres.js shape: int8 as a string). */
function paidPaymentRow(): Record<string, unknown> {
  const at = new Date(CREATED * 1_000).toISOString();
  const values: Record<string, unknown> = {
    tenantId: owner.tenantId,
    id: owner.paymentId,
    userId: owner.userId,
    priceId: 'price_pro',
    quantity: 1,
    amountTotal: '4900',
    currency: 'eur',
    status: PaymentStatus.Succeeded,
    stripeCheckoutSessionId: SESSION_ID,
    paidAt: at,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
  return Object.fromEntries(
    Object.keys(getTableColumns(payments)).map((column) => [column, values[column] ?? null]),
  );
}

/** A Stripe event signed like Stripe signs it (`t=…,v1=HMAC(t.payload)`), by raw bytes. */
function signedEvent(eventId: string, type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    type,
    api_version: null,
    created: CREATED,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  });
  const timestamp = Math.floor(Date.now() / 1_000);
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest('hex');
  return { payload, signature: `t=${timestamp},v1=${v1}` };
}

const chargeSucceeded = signedEvent('evt_e2e_charge_succeeded', 'charge.succeeded', {
  id: 'ch_e2e_1',
  object: 'charge',
  amount: 4_900,
  currency: 'eur',
  status: 'succeeded',
  metadata: { paymentId: owner.paymentId, userId: owner.userId, tenantId: owner.tenantId },
});
const payoutPaid = signedEvent('evt_e2e_payout_paid', 'payout.paid', {
  id: 'po_e2e_1',
  object: 'payout',
  amount: 10_000,
  currency: 'eur',
  status: 'paid',
});

const isBalanced = (entry: LedgerEntry): boolean =>
  entry.postings.reduce((sum, posting) => sum + posting.debit - posting.credit, 0n) === 0n;

describe('ledger end to end (monolith): webhook → outbox → relay → consumer → ledger → reconciliation', () => {
  let e2e: MonolithE2e;
  const immudb = new RecordingImmudbClient();
  /** The `stripe_events` receipts the fake Postgres holds: `tenant:event`. */
  const receipts = new Set<string>();
  const ledger = () => e2e.ledger ?? expect.fail('the ledger fakes are not bound');

  const webhook = (event: { payload: string; signature: string }) =>
    e2e.app.inject({
      method: 'POST',
      url: '/v1/billing/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
      payload: event.payload,
    });
  /** The posting records the relay published, as the broker hands them over (JSON). */
  const published = (): PublishedKafkaRecord[] =>
    e2e.kafka.published(LEDGER_POSTING_REQUESTED_EVENT);
  const deliver = async (record: PublishedKafkaRecord): Promise<void> => {
    await e2e.consumers.deliver(
      record.topic,
      JSON.parse(JSON.stringify(record.value)) as unknown,
      record.key ?? null,
    );
    expect(e2e.consumers.deadLetters()).toEqual([]);
  };
  const reconcile = () => {
    const window = { from: new Date(NOW - 3_600_000), to: new Date(NOW) };
    return SystemContext.run('billing.reconcile-ledger', () =>
      e2e.app.get(CommandBus).execute(new ReconcileLedgerCommand(window)),
    );
  };
  const lastRun = () => [...ledger().store.runs.values()].at(-1);
  const chargeEntryId = ledgerEntryId(`stripe:txn:${CHARGE_TXN}`);

  beforeAll(async () => {
    e2e = await createMonolithE2eApp({
      immudb,
      kafkaConsumers: true,
      ledger: true,
      postgresRows: (sql, params) => {
        if (sql.startsWith('insert into "billing"."stripe_events"')) {
          const key = `${String(params[0])}:${String(params[1])}`;
          if (receipts.has(key)) return []; // ON CONFLICT DO NOTHING
          receipts.add(key);
          return [{ id: params[1] }];
        }
        if (sql.includes('from "billing"."payments"') && params.includes(owner.paymentId)) {
          return [paidPaymentRow()];
        }
        return [];
      },
    });
    const { stripe, store } = ledger();
    stripe.add({
      id: CHARGE_TXN,
      amount: 4_900,
      fee: 142,
      currency: 'eur',
      created: CREATED,
      reportingCategory: 'charge',
      source: { id: 'ch_e2e_1', amount: 4_900, currency: 'eur' },
    });
    stripe.add({
      id: PAYOUT_TXN,
      amount: -10_000,
      fee: 0,
      currency: 'eur',
      created: CREATED,
      reportingCategory: 'payout',
      source: { id: 'po_e2e_1' },
    });
    // What R3 compares the ledger with: the payment the webhook found, paid at the charge's time.
    store.addPayments({
      tenantId: owner.tenantId,
      id: owner.paymentId,
      userId: owner.userId,
      status: PaymentStatus.Succeeded,
      amountTotal: 4_900n,
      currency: 'eur',
      paidAt: new Date(CREATED * 1_000),
    });
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('boots the ledger wiring: the consumer handles the posting topic, LedgerPort is the in-memory ledger', () => {
    expect(e2e.consumers.getHandlerByPattern(LEDGER_POSTING_REQUESTED_EVENT.topic)).toEqual(
      expect.any(Function),
    );
    expect(e2e.app.get(LedgerPostingConsumer, { strict: false })).toBeInstanceOf(
      LedgerPostingConsumer,
    );
    expect(e2e.app.get(LedgerPort, { strict: false })).toBe(ledger().port);
  });

  it('a signed charge.succeeded → one outbox row, nothing on Kafka; a relay tick → one balanced entry and one ref', async () => {
    const post = vi.spyOn(ledger().port, 'post');

    const response = await webhook(chargeSucceeded);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ duplicate: false, eventType: 'charge.succeeded' });

    // The request path wrote the row in its unit of work and published nothing.
    expect(
      e2e.outbox.billing.unpublished().map((row) => [row.topic, row.tenantId, row.key]),
    ).toEqual([[LEDGER_POSTING_REQUESTED_EVENT.topic, owner.tenantId, owner.tenantId]]);
    expect(published()).toEqual([]);

    const [, billingTick] = await e2e.tickRelays();
    expect(billingTick).toMatchObject({ failed: false, published: 1 });
    expect(e2e.outbox.billing.unpublished()).toEqual([]);
    expect(published()).toHaveLength(1);
    expect(e2e.kafka.envelopes(LEDGER_POSTING_REQUESTED_EVENT)[0]).toMatchObject({
      tenantId: owner.tenantId,
      actorId: owner.userId,
      payload: {
        stripeEventId: 'evt_e2e_charge_succeeded',
        objectType: 'charge',
        objectId: 'ch_e2e_1',
        tenantId: owner.tenantId,
        userId: owner.userId,
        paymentId: owner.paymentId,
      },
    });

    // Kafka → LedgerPostingConsumer → Stripe GET → LedgerService → the ledger and the receipt.
    const [record = expect.fail('no posting record')] = published();
    await deliver(record);
    const entry = await ledger().port.getEntry(owner.tenantId, chargeEntryId);
    expect(entry).toMatchObject({
      kind: 'charge',
      paymentId: owner.paymentId,
      stripeObjectId: 'ch_e2e_1',
      presentment: { amount: 4_900n, currency: 'eur' },
    });
    expect(entry && isBalanced(entry)).toBe(true);
    expect(ledger().store.entryRefs).toEqual([
      expect.objectContaining({
        tenantId: owner.tenantId,
        entryId: chargeEntryId,
        kind: 'charge',
        paymentId: owner.paymentId,
        sourceKey: `stripe:txn:${CHARGE_TXN}`,
      }),
    ]);
    const outcomes = await Promise.all(
      post.mock.results.map((r) => r.value as Promise<LedgerPostOutcome>),
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['posted']);
  });

  it('the same webhook again and the same Kafka message again still leave one entry and one ref', async () => {
    const post = vi.spyOn(ledger().port, 'post');

    // Stripe redelivers: acknowledged as a duplicate, no second row, nothing more on Kafka.
    const replay = await webhook(chargeSucceeded);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ duplicate: true });
    expect(e2e.outbox.billing.unpublished()).toEqual([]);
    await e2e.tickRelays();
    expect(published()).toHaveLength(1);

    // Kafka redelivers the message (at least once): replayed, no second entry or ref.
    const [record = expect.fail('no posting record')] = published();
    await deliver(record);
    await deliver(record);
    const outcomes = await Promise.all(
      post.mock.results.map((r) => r.value as Promise<LedgerPostOutcome>),
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['replayed', 'replayed']);
    expect(ledger().store.entryRefs).toHaveLength(1);
    // The money was posted once: the revenue account holds the charge once, not three times.
    const balances = await ledger().port.balances(owner.tenantId, 'eur');
    expect(balances.find((balance) => balance.account === 'revenue:checkout')).toMatchObject({
      credit: 4_900n,
      debit: 0n,
    });
  });

  it('payout.paid → a platform entry (the nil tenant, no user), posted inside SystemContext', async () => {
    const response = await webhook(payoutPaid);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ duplicate: false, eventType: 'payout.paid' });
    expect(e2e.outbox.billing.unpublished().map((row) => row.tenantId)).toEqual([
      PLATFORM_TENANT_ID,
    ]);

    await e2e.tickRelays();
    const record = published().at(-1) ?? expect.fail('no payout record');
    expect(record.value).toMatchObject({ tenantId: PLATFORM_TENANT_ID, actorId: null });
    await deliver(record);

    const entryId = ledgerEntryId(`stripe:txn:${PAYOUT_TXN}`);
    const entry = await ledger().port.getEntry(PLATFORM_TENANT_ID, entryId);
    expect(entry).toMatchObject({ kind: 'payout', paymentId: null, presentment: null });
    expect(entry && isBalanced(entry)).toBe(true);
    expect(ledger().store.entryRefs.map((ref) => [ref.tenantId, ref.kind])).toEqual([
      [owner.tenantId, 'charge'],
      [PLATFORM_TENANT_ID, 'payout'],
    ]);
  });

  it('a reconcile run succeeds with zero findings', async () => {
    const counts = await reconcile();
    expect(counts).toEqual({ found: {}, appended: {} });
    expect(lastRun()).toMatchObject({ status: 'succeeded', counts });
    expect(ledger().store.discrepancies).toEqual([]);
    // R4 listed Stripe's side of the window.
    expect(ledger().stripe.requests).toContain('balanceTransactions:list');
  });

  it('after tampering with the ledger the next run reports ledger_row_mutated', async () => {
    ledger().port.tamper(chargeEntryId, (entry) => ({ ...entry, stripeObjectId: 'ch_tampered' }));

    const counts = await reconcile();
    expect(counts.appended).toEqual({ ledger_row_mutated: 1 });
    expect(lastRun()).toMatchObject({ status: 'succeeded' });
    expect(ledger().store.discrepancies).toEqual([
      expect.objectContaining({
        tenantId: PLATFORM_TENANT_ID,
        kind: 'ledger_row_mutated',
        sourceKey: `ledger_entries:${chargeEntryId}`,
        detectedBy: 'R2',
      }),
    ]);

    // Reconciliation appends and never corrects: the same finding is found again, stored once.
    expect(await reconcile()).toEqual({
      found: { ledger_row_mutated: 1 },
      appended: { ledger_row_mutated: 0 },
    });
    expect(ledger().store.discrepancies).toHaveLength(1);
  });
});
