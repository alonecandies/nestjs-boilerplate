import { generateId } from '@app/common';
import { createEventEnvelope, KAFKA_TOPICS } from '@app/contracts';
import { CommandBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_ID } from '../../../test/support/fixtures.js';
import { InMemoryKafkaServer } from '../../../test/support/in-memory-kafka.server.js';
import { SendPaymentReceiptCommand } from '../../application/commands/send-payment-receipt/send-payment-receipt.command.js';
import { WelcomeUserCommand } from '../../application/commands/welcome-user/welcome-user.command.js';
import { BillingEventsConsumer } from './billing-events.consumer.js';
import { IdentityEventsConsumer } from './identity-events.consumer.js';

const registeredAt = '2026-09-29T07:00:00.000Z';
const userRegistered = () =>
  createEventEnvelope(
    KAFKA_TOPICS.USER_REGISTERED,
    { userId: USER_ID, email: 'ada@example.com', displayName: 'Ada', registeredAt },
    { id: generateId(), source: 'identity-service' },
  );

const PAYMENT_ID = '01920000-0000-7000-8000-0000000000aa';
const paidAt = '2026-09-29T07:30:00.000Z';
const paymentSucceeded = () =>
  createEventEnvelope(
    KAFKA_TOPICS.PAYMENT_SUCCEEDED,
    {
      paymentId: PAYMENT_ID,
      userId: USER_ID,
      stripeCheckoutSessionId: 'cs_test_1',
      amountTotal: 1999,
      currency: 'usd',
      paidAt,
    },
    { id: generateId(), source: 'billing-service' },
  );

describe('Kafka consumers (Nest RPC pipeline, in-memory broker)', () => {
  const commandBus = { execute: vi.fn() };
  const server = new InMemoryKafkaServer();
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IdentityEventsConsumer, BillingEventsConsumer],
      providers: [{ provide: CommandBus, useValue: commandBus }],
    }).compile();
    const microservice = moduleRef.createNestMicroservice({ strategy: server, logger: false });
    await microservice.init();
    close = () => microservice.close();
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(() => {
    commandBus.execute.mockReset();
    server.producer.send.mockClear();
  });

  describe('IdentityEventsConsumer', () => {
    it('USER_REGISTERED → WelcomeUserCommand (dates revived), nothing dead-lettered', async () => {
      commandBus.execute.mockResolvedValue(undefined);

      await server.dispatch(KAFKA_TOPICS.USER_REGISTERED, userRegistered(), USER_ID);

      const [command] = commandBus.execute.mock.calls[0] ?? [];
      expect(command).toBeInstanceOf(WelcomeUserCommand);
      expect((command as WelcomeUserCommand).input).toEqual({
        userId: USER_ID,
        email: 'ada@example.com',
        displayName: 'Ada',
        registeredAt: new Date(registeredAt),
      });
      expect(server.deadLetters()).toHaveLength(0);
    });

    it('dead-letters an invalid envelope (pipe) without running the command, and does not throw', async () => {
      const envelope = { ...userRegistered(), payload: { userId: 'nope' } };

      await expect(
        server.dispatch(KAFKA_TOPICS.USER_REGISTERED, envelope, USER_ID),
      ).resolves.toBeUndefined();

      expect(commandBus.execute).not.toHaveBeenCalled();
      const [record] = server.deadLetters();
      expect(record?.topic).toBe(`${KAFKA_TOPICS.USER_REGISTERED}.dlq`);
      expect(record?.messages[0]?.headers).toMatchObject({
        'x-original-topic': KAFKA_TOPICS.USER_REGISTERED,
        'x-error-type': 'INVALID_EVENT',
      });
      // The original bytes are kept for replay.
      expect(JSON.parse(String(record?.messages[0]?.value))).toEqual(envelope);
    });

    it('dead-letters an envelope of another topic (type mismatch)', async () => {
      await server.dispatch(KAFKA_TOPICS.USER_REGISTERED, paymentSucceeded());
      expect(commandBus.execute).not.toHaveBeenCalled();
      expect(server.deadLetters()).toHaveLength(1);
    });

    it('dead-letters a failing command instead of blocking the partition', async () => {
      commandBus.execute.mockRejectedValue(new Error('mail queue unavailable'));

      await expect(
        server.dispatch(KAFKA_TOPICS.USER_REGISTERED, userRegistered()),
      ).resolves.toBeUndefined();

      const [record] = server.deadLetters();
      expect(record?.messages[0]?.headers).toMatchObject({
        'x-error-message': 'mail queue unavailable',
      });
    });
  });

  describe('BillingEventsConsumer', () => {
    it('PAYMENT_SUCCEEDED → SendPaymentReceiptCommand', async () => {
      commandBus.execute.mockResolvedValue(undefined);

      await server.dispatch(KAFKA_TOPICS.PAYMENT_SUCCEEDED, paymentSucceeded(), USER_ID);

      const [command] = commandBus.execute.mock.calls[0] ?? [];
      expect(command).toBeInstanceOf(SendPaymentReceiptCommand);
      expect((command as SendPaymentReceiptCommand).input).toEqual({
        paymentId: PAYMENT_ID,
        userId: USER_ID,
        amountTotal: 1999,
        currency: 'usd',
        paidAt: new Date(paidAt),
      });
    });

    it('dead-letters a negative amount (schema violation) to billing.payment-succeeded.v1.dlq', async () => {
      const bad = paymentSucceeded();
      await server.dispatch(KAFKA_TOPICS.PAYMENT_SUCCEEDED, {
        ...bad,
        payload: { ...bad.payload, amountTotal: -1 },
      });
      expect(commandBus.execute).not.toHaveBeenCalled();
      expect(server.deadLetters()[0]?.topic).toBe(`${KAFKA_TOPICS.PAYMENT_SUCCEEDED}.dlq`);
    });
  });
});
