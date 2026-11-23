/*
 * The transactional outbox end to end in the monolith (G-3): request → `<schema>.outbox` (in the
 * unit of work) → `OutboxRelay.tick()` → Kafka (the fake producer) → the notifications consumers
 * (an in-process Kafka server, the same handlers `connectKafkaConsumer` registers). Nothing
 * reaches Kafka from a request path: an event goes out only when a relay ticks.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV, {
    STRIPE_WEBHOOK_SECRET: 'whsec_monolith_outbox_e2e',
  });
});

import { createHmac } from 'node:crypto';
import { PaymentStatus, payments } from '@domain/billing';
import { PAYMENT_SUCCEEDED_EVENT } from '@domain/billing-contracts';
import { MEMBERSHIP_CREATED_EVENT, USER_REGISTERED_EVENT } from '@domain/identity-contracts';
import { generateId } from '@platform/common';
import type { PublishedKafkaRecord } from '@platform/transport/testing';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

const WEBHOOK_SECRET = 'whsec_monolith_outbox_e2e';
const PASSWORD = 'correct horse battery staple';
const SESSION_ID = 'cs_test_outbox_e2e';
const CREATED_AT = new Date('2026-11-01T10:00:00.000Z');

interface Tokens {
  accessToken: string;
  tenantId: string;
  user: { id: string; email: string };
}

/** The pending payment the webhook completes, owned by the registered user in their workspace. */
interface PaymentOwner {
  readonly tenantId: string;
  readonly userId: string;
  readonly paymentId: string;
}

/** A `payments` row as postgres.js returns it (columns in declaration order, int8 as a string). */
function pendingPaymentRow({ tenantId, userId, paymentId }: PaymentOwner): Record<string, unknown> {
  const values: Record<string, unknown> = {
    tenantId,
    id: paymentId,
    userId,
    priceId: 'price_pro',
    quantity: 1,
    amountTotal: '4900',
    currency: 'eur',
    status: PaymentStatus.Pending,
    stripeCheckoutSessionId: SESSION_ID,
    version: 0,
    createdAt: CREATED_AT.toISOString(),
    updatedAt: CREATED_AT.toISOString(),
  };
  return Object.fromEntries(
    Object.keys(getTableColumns(payments)).map((column) => [column, values[column] ?? null]),
  );
}

/** A paid `checkout.session.completed`, signed like Stripe signs it (`t=…,v1=HMAC(t.payload)`). */
function signedPaidWebhook(owner: PaymentOwner, eventId: string) {
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    api_version: null,
    created: Math.floor(Date.now() / 1_000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: SESSION_ID,
        object: 'checkout.session',
        amount_total: 4_900,
        currency: 'eur',
        client_reference_id: owner.paymentId,
        metadata: { paymentId: owner.paymentId, userId: owner.userId, tenantId: owner.tenantId },
        payment_status: 'paid',
        payment_intent: 'pi_test_outbox_e2e',
        status: 'complete',
      },
    },
  });
  const timestamp = Math.floor(Date.now() / 1_000);
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest('hex');
  return { payload, signature: `t=${timestamp},v1=${v1}` };
}

describe('transactional outbox (monolith): request → outbox → relay → Kafka → consumer', () => {
  let e2e: MonolithE2e;
  /** Billing runs on the real Drizzle repositories over the fake Postgres: what it answers. */
  const billingDb: { owner: PaymentOwner | null; receipts: Set<string> } = {
    owner: null,
    receipts: new Set(),
  };

  const register = async (email: string, displayName: string): Promise<Tokens> => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, displayName },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Tokens>();
  };
  const tick = () => e2e.tickRelays();
  /** The records the relays published (envelopes as a broker hands them over: JSON). */
  const forward = async (records: readonly PublishedKafkaRecord[]): Promise<void> => {
    for (const record of records) {
      await e2e.consumers.deliver(
        record.topic,
        JSON.parse(JSON.stringify(record.value)) as unknown,
        record.key ?? null,
      );
    }
    // Every message was handled: none went to a dead-letter topic.
    expect(e2e.consumers.deadLetters()).toEqual([]);
  };
  const ofUser = (userId: string) => (record: PublishedKafkaRecord) =>
    (record.value.payload as { userId?: unknown }).userId === userId;
  const notificationTitles = async (token: string): Promise<string[]> => {
    const res = await e2e.app.inject({
      method: 'GET',
      url: '/v1/notifications?limit=50',
      headers: bearer(token),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ items: { title: string }[] }>().items.map((item) => item.title);
  };
  const mailTemplates = (to: string): string[] =>
    e2e.mailQueue.jobs
      .filter((job) => (job.data as { to?: unknown }).to === to)
      .map((job) => String((job.data as { template?: unknown }).template));

  beforeAll(async () => {
    e2e = await createMonolithE2eApp({
      kafkaConsumers: true,
      postgresRows: (sql, params) => {
        const owner = billingDb.owner;
        if (sql.startsWith('insert into "billing"."stripe_events"')) {
          const key = `${String(params[0])}:${String(params[1])}`;
          if (billingDb.receipts.has(key)) return []; // ON CONFLICT DO NOTHING
          billingDb.receipts.add(key);
          return [{ id: params[1] }];
        }
        if (
          owner !== null &&
          sql.includes('from "billing"."payments"') &&
          sql.endsWith('for update') &&
          params[0] === owner.tenantId
        ) {
          return [pendingPaymentRow(owner)];
        }
        if (owner !== null && sql.startsWith('update "billing"."payments"')) {
          return [{ id: owner.paymentId }];
        }
        return [];
      },
    });
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('a REST registration reaches Kafka only after a relay tick, once, with the tenant in the envelope', async () => {
    const ada = await register('ada.outbox@example.com', 'Ada');

    // The request path wrote the rows and published nothing: the producer has no record, and the
    // rows below are still unpublished (and the tick after them publishes exactly those two), so
    // no wait is needed to prove it.
    expect(e2e.kafka.records.filter(ofUser(ada.user.id))).toEqual([]);
    expect(
      e2e.outbox.identity.unpublished().map((row) => [row.topic, row.tenantId, row.key]),
    ).toEqual(
      expect.arrayContaining([
        [USER_REGISTERED_EVENT.topic, ada.tenantId, ada.user.id],
        [MEMBERSHIP_CREATED_EVENT.topic, ada.tenantId, ada.user.id],
      ]),
    );

    const [identityTick] = await tick();
    expect(identityTick).toMatchObject({ failed: false, published: 2 });
    expect(e2e.outbox.identity.unpublished()).toEqual([]);

    const registered = e2e.kafka.envelopes(USER_REGISTERED_EVENT);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      type: USER_REGISTERED_EVENT.topic,
      source: 'monolith-e2e',
      tenantId: ada.tenantId,
      actorId: ada.user.id,
      payload: { userId: ada.user.id, email: 'ada.outbox@example.com', displayName: 'Ada' },
    });

    // A second tick finds nothing: the rows were marked, no duplicate goes out.
    await tick();
    expect(e2e.kafka.envelopes(USER_REGISTERED_EVENT)).toHaveLength(1);

    // Kafka → IdentityEventsConsumer: the welcome lands in the new workspace and is mailed.
    await forward(e2e.kafka.records.filter(ofUser(ada.user.id)));
    expect(await notificationTitles(ada.accessToken)).toContain('Welcome aboard!');
    expect(mailTemplates('ada.outbox@example.com')).toEqual(['welcome']);
  });

  it('with the producer failing, registration still answers 201 and a later tick delivers the event', async () => {
    // The broker refuses every send until it is back.
    const outage = vi
      .spyOn(e2e.kafka, 'publishStored')
      .mockRejectedValue(new Error('broker unreachable'));

    const bob = await register('bob.outbox@example.com', 'Bob');

    const [failed] = await tick();
    expect(failed).toMatchObject({ failed: true, published: 0 });
    expect(outage).toHaveBeenCalled();
    expect(e2e.kafka.records.filter(ofUser(bob.user.id))).toEqual([]);
    expect(
      e2e.outbox.identity.unpublished().filter((row) => row.tenantId === bob.tenantId),
    ).toHaveLength(2);

    outage.mockRestore();
    const [retried] = await tick();
    expect(retried).toMatchObject({ failed: false, published: 2 });
    const published = e2e.kafka.records.filter(ofUser(bob.user.id));
    expect(published.map((record) => record.topic).sort()).toEqual(
      [MEMBERSHIP_CREATED_EVENT.topic, USER_REGISTERED_EVENT.topic].sort(),
    );
    expect(
      e2e.kafka.envelopes(USER_REGISTERED_EVENT).filter((env) => env.tenantId === bob.tenantId),
    ).toHaveLength(1);

    await forward(published);
    expect(await notificationTitles(bob.accessToken)).toContain('Welcome aboard!');
  });

  it('a signed paid webhook yields one billing.payment-succeeded.v1, a replay none, and the receipt arrives', async () => {
    const carol = await register('carol.outbox@example.com', 'Carol');
    await tick();
    // The membership-created event feeds the recipients projection the receipt mail reads.
    await forward(e2e.kafka.records.filter(ofUser(carol.user.id)));
    const owner = { tenantId: carol.tenantId, userId: carol.user.id, paymentId: generateId() };
    billingDb.owner = owner;
    const webhook = signedPaidWebhook(owner, `evt_${generateId().replaceAll('-', '')}`);
    const post = () =>
      e2e.app.inject({
        method: 'POST',
        url: '/v1/billing/webhooks/stripe',
        headers: { 'content-type': 'application/json', 'stripe-signature': webhook.signature },
        payload: webhook.payload,
      });

    const first = await post();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ duplicate: false });
    expect(e2e.kafka.envelopes(PAYMENT_SUCCEEDED_EVENT)).toEqual([]);
    expect(e2e.outbox.billing.unpublished().map((row) => [row.topic, row.tenantId])).toEqual([
      [PAYMENT_SUCCEEDED_EVENT.topic, carol.tenantId],
    ]);

    await tick();
    expect(e2e.kafka.envelopes(PAYMENT_SUCCEEDED_EVENT)).toHaveLength(1);
    expect(e2e.kafka.envelopes(PAYMENT_SUCCEEDED_EVENT)[0]).toMatchObject({
      tenantId: carol.tenantId,
      actorId: carol.user.id,
      payload: { paymentId: owner.paymentId, userId: carol.user.id, currency: 'eur' },
    });

    // Stripe redelivers: acknowledged as a duplicate, no second row, nothing more on Kafka.
    const replay = await post();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ duplicate: true });
    expect(e2e.outbox.billing.unpublished()).toEqual([]);
    await tick();
    expect(e2e.kafka.envelopes(PAYMENT_SUCCEEDED_EVENT)).toHaveLength(1);

    // Kafka → BillingEventsConsumer: the receipt lands in the inbox and is mailed.
    await forward(e2e.kafka.published(PAYMENT_SUCCEEDED_EVENT));
    expect(await notificationTitles(carol.accessToken)).toContain('Payment received');
    expect(mailTemplates('carol.outbox@example.com')).toEqual(['welcome', 'payment-receipt']);
  });
});
