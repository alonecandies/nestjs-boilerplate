import { generateId } from '@app/common';
import { KAFKA_TOPICS } from '@app/contracts';
import { FakeKafkaProducer } from '@app/transport';
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentSucceededEvent } from '../../domain/events/payment-succeeded.event.js';
import { PaymentSucceededRelay } from './payment-succeeded.relay.js';

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
  );

  beforeEach(() => {
    kafka = new FakeKafkaProducer({ source: 'billing-test' });
    relay = new PaymentSucceededRelay(kafka);
  });

  it('publishes billing.payment-succeeded.v1 keyed by user, envelope id = domain event id', async () => {
    await relay.handle(event);

    const [record] = kafka.published(KAFKA_TOPICS.PAYMENT_SUCCEEDED);
    expect(record?.key).toBe(event.userId);
    expect(record?.value).toMatchObject({
      id: event.eventId,
      type: KAFKA_TOPICS.PAYMENT_SUCCEEDED,
      source: 'billing-test',
      occurredAt: '2026-09-04T08:30:00.000Z',
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

    expect(kafka.published(KAFKA_TOPICS.PAYMENT_SUCCEEDED)).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(`payment ${event.paymentId}`),
      expect.any(String),
    );
  });
});
