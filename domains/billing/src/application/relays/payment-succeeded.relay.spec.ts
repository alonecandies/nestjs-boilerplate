import { PAYMENT_SUCCEEDED_EVENT } from '@domain/billing-contracts';
import { Logger } from '@nestjs/common';
import { TEST_TENANT_ID } from '@platform/auth/testing';
import { generateId } from '@platform/common';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentSucceededEvent } from '../../domain/events/payment-succeeded.event.js';
import { PaymentSucceededRelay, toPaymentSucceededPayload } from './payment-succeeded.relay.js';

describe('PaymentSucceededRelay', () => {
  let kafka: FakeKafkaProducer;
  let relay: PaymentSucceededRelay;
  const event = new PaymentSucceededEvent(
    generateId(),
    generateId(),
    generateId(),
    'cs_test_1',
    2_500,
    'usd',
    new Date('2026-09-04T08:30:00.000Z'),
    null,
    TEST_TENANT_ID,
  );

  beforeEach(() => {
    kafka = new FakeKafkaProducer({ source: 'billing-test' });
    relay = new PaymentSucceededRelay(kafka);
  });

  it('publishes billing.payment-succeeded.v1 keyed by user, envelope id = domain event id', async () => {
    await relay.handle(event);

    const [record] = kafka.published(PAYMENT_SUCCEEDED_EVENT);
    expect(record?.key).toBe(event.userId);
    expect(record?.value).toMatchObject({
      id: event.eventId,
      type: PAYMENT_SUCCEEDED_EVENT.topic,
      source: 'billing-test',
      occurredAt: '2026-09-04T08:30:00.000Z',
      tenantId: TEST_TENANT_ID,
      actorId: event.userId,
      payload: {
        paymentId: event.paymentId,
        userId: event.userId,
        stripeCheckoutSessionId: 'cs_test_1',
        amountTotal: 2_500,
        currency: 'usd',
        paidAt: '2026-09-04T08:30:00.000Z',
      },
    });
  });

  it('logs and swallows publish failures (never throws into the event bus)', async () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    kafka.failNextWith(new Error('broker unavailable'));

    await expect(relay.handle(event)).resolves.toBeUndefined();

    expect(kafka.published(PAYMENT_SUCCEEDED_EVENT)).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(`payment ${event.paymentId}`),
      expect.any(String),
    );
  });
});

describe('toPaymentSucceededPayload', () => {
  const build = (paymentIntentId: string | null) =>
    new PaymentSucceededEvent(
      generateId(),
      generateId(),
      generateId(),
      'cs_test_1',
      2_500,
      'usd',
      new Date('2026-09-04T08:30:00.000Z'),
      paymentIntentId,
    );

  it('includes stripePaymentIntentId when the event carries it', () => {
    expect(toPaymentSucceededPayload(build('pi_1'))).toMatchObject({
      stripePaymentIntentId: 'pi_1',
    });
  });

  it('omits the key when the event has none', () => {
    expect(toPaymentSucceededPayload(build(null))).not.toHaveProperty('stripePaymentIntentId');
  });
});
