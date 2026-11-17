import { PAYMENT_SUCCEEDED_EVENT } from '@domain/billing-contracts';
import {
  MEMBERSHIP_CREATED_EVENT,
  MEMBERSHIP_REMOVED_EVENT,
  USER_REGISTERED_EVENT,
} from '@domain/identity-contracts';
import { CommandBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { generateId } from '@platform/common';
import { createEventEnvelope } from '@platform/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_ID } from '../../../test/support/fixtures.js';
import { InMemoryKafkaServer } from '../../../test/support/in-memory-kafka.server.js';
import { RemoveRecipientCommand } from '../../application/commands/remove-recipient/remove-recipient.command.js';
import { SendPaymentReceiptCommand } from '../../application/commands/send-payment-receipt/send-payment-receipt.command.js';
import { UpsertRecipientCommand } from '../../application/commands/upsert-recipient/upsert-recipient.command.js';
import { WelcomeUserCommand } from '../../application/commands/welcome-user/welcome-user.command.js';
import { BillingEventsConsumer } from './billing-events.consumer.js';
import { IdentityEventsConsumer } from './identity-events.consumer.js';

const registeredAt = '2026-09-29T07:00:00.000Z';
const userRegistered = () =>
  createEventEnvelope(
    USER_REGISTERED_EVENT,
    { userId: USER_ID, email: 'ada@example.com', displayName: 'Ada', registeredAt },
    { id: generateId(), source: 'identity-service', tenantId: TENANT_ID },
  );

const PAYMENT_ID = '01920000-0000-7000-8000-0000000000aa';
const TENANT_ID = '01920000-0000-7000-8000-0000000000ee';
const paidAt = '2026-09-29T07:30:00.000Z';
const paymentSucceeded = () =>
  createEventEnvelope(
    PAYMENT_SUCCEEDED_EVENT,
    {
      paymentId: PAYMENT_ID,
      userId: USER_ID,
      stripeCheckoutSessionId: 'cs_test_1',
      amountTotal: 1999,
      currency: 'usd',
      paidAt,
    },
    // billing.payment-succeeded.v1 is tenant-scoped (B2-26): the envelope carries the tenant and payer.
    { id: generateId(), source: 'billing-service', tenantId: TENANT_ID, actorId: USER_ID },
  );

const membershipCreatedAt = '2026-09-29T07:10:00.000Z';
const membershipCreated = () =>
  createEventEnvelope(
    MEMBERSHIP_CREATED_EVENT,
    {
      userId: USER_ID,
      email: 'ada@example.com',
      displayName: 'Ada',
      createdAt: membershipCreatedAt,
    },
    { id: generateId(), source: 'identity-service', tenantId: TENANT_ID, actorId: USER_ID },
  );

const membershipRemovedAt = '2026-09-29T07:20:00.000Z';
const membershipRemoved = () =>
  createEventEnvelope(
    MEMBERSHIP_REMOVED_EVENT,
    { userId: USER_ID, removedAt: membershipRemovedAt },
    { id: generateId(), source: 'identity-service', tenantId: TENANT_ID, actorId: USER_ID },
  );

/** A tenant-scoped envelope as a pre-B2-24 producer sent it: no `tenantId` (createEventEnvelope refuses one). */
const withoutTenant = <T extends { tenantId?: string | undefined }>(envelope: T) => {
  const { tenantId: _tenantId, ...rest } = envelope;
  return rest;
};

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

      await server.dispatch(USER_REGISTERED_EVENT.topic, userRegistered(), USER_ID);

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
        server.dispatch(USER_REGISTERED_EVENT.topic, envelope, USER_ID),
      ).resolves.toBeUndefined();

      expect(commandBus.execute).not.toHaveBeenCalled();
      const [record] = server.deadLetters();
      expect(record?.topic).toBe(`${USER_REGISTERED_EVENT.topic}.dlq`);
      expect(record?.messages[0]?.headers).toMatchObject({
        'x-original-topic': USER_REGISTERED_EVENT.topic,
        'x-error-type': 'INVALID_EVENT',
      });
      // The original bytes are kept for replay.
      expect(JSON.parse(String(record?.messages[0]?.value))).toEqual(envelope);
    });

    it('dead-letters an envelope of another topic (type mismatch)', async () => {
      await server.dispatch(USER_REGISTERED_EVENT.topic, paymentSucceeded());
      expect(commandBus.execute).not.toHaveBeenCalled();
      expect(server.deadLetters()).toHaveLength(1);
    });

    it('MEMBERSHIP_CREATED → UpsertRecipientCommand in the envelope tenant', async () => {
      commandBus.execute.mockResolvedValue(undefined);

      await server.dispatch(MEMBERSHIP_CREATED_EVENT.topic, membershipCreated(), USER_ID);

      const [command] = commandBus.execute.mock.calls[0] ?? [];
      expect(command).toBeInstanceOf(UpsertRecipientCommand);
      expect((command as UpsertRecipientCommand).input).toEqual({
        tenantId: TENANT_ID,
        userId: USER_ID,
        email: 'ada@example.com',
        displayName: 'Ada',
        createdAt: new Date(membershipCreatedAt),
      });
      expect(server.deadLetters()).toHaveLength(0);
    });

    it('MEMBERSHIP_REMOVED → RemoveRecipientCommand in the envelope tenant', async () => {
      commandBus.execute.mockResolvedValue(undefined);

      await server.dispatch(MEMBERSHIP_REMOVED_EVENT.topic, membershipRemoved(), USER_ID);

      const [command] = commandBus.execute.mock.calls[0] ?? [];
      expect(command).toBeInstanceOf(RemoveRecipientCommand);
      expect((command as RemoveRecipientCommand).input).toEqual({
        tenantId: TENANT_ID,
        userId: USER_ID,
        removedAt: new Date(membershipRemovedAt),
      });
      expect(server.deadLetters()).toHaveLength(0);
    });

    it.each([
      ['membership-created', MEMBERSHIP_CREATED_EVENT.topic, membershipCreated],
      ['membership-removed', MEMBERSHIP_REMOVED_EVENT.topic, membershipRemoved],
    ])(
      'dead-letters a %s envelope without tenantId and runs no command',
      async (_name, topic, build) => {
        commandBus.execute.mockResolvedValue(undefined);

        await server.dispatch(topic, withoutTenant(build()), USER_ID);

        expect(commandBus.execute).not.toHaveBeenCalled();
        const [record] = server.deadLetters();
        expect(record?.topic).toBe(`${topic}.dlq`);
      },
    );

    it('dead-letters a membership envelope whose tenant is the platform (nil) tenant', async () => {
      await server.dispatch(
        MEMBERSHIP_CREATED_EVENT.topic,
        { ...membershipCreated(), tenantId: '00000000-0000-0000-0000-000000000000' },
        USER_ID,
      );
      expect(commandBus.execute).not.toHaveBeenCalled();
      expect(server.deadLetters()).toHaveLength(1);
    });

    it('dead-letters a failing command instead of blocking the partition', async () => {
      commandBus.execute.mockRejectedValue(new Error('mail queue unavailable'));

      await expect(
        server.dispatch(USER_REGISTERED_EVENT.topic, userRegistered()),
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

      await server.dispatch(PAYMENT_SUCCEEDED_EVENT.topic, paymentSucceeded(), USER_ID);

      const [command] = commandBus.execute.mock.calls[0] ?? [];
      expect(command).toBeInstanceOf(SendPaymentReceiptCommand);
      expect((command as SendPaymentReceiptCommand).input).toEqual({
        tenantId: TENANT_ID,
        paymentId: PAYMENT_ID,
        userId: USER_ID,
        amountTotal: 1999,
        currency: 'usd',
        paidAt: new Date(paidAt),
      });
    });

    it('dead-letters a payment envelope without tenantId and runs no command', async () => {
      commandBus.execute.mockResolvedValue(undefined);

      await server.dispatch(
        PAYMENT_SUCCEEDED_EVENT.topic,
        withoutTenant(paymentSucceeded()),
        USER_ID,
      );

      expect(commandBus.execute).not.toHaveBeenCalled();
      expect(server.deadLetters()[0]?.topic).toBe(`${PAYMENT_SUCCEEDED_EVENT.topic}.dlq`);
    });

    it('dead-letters a negative amount (schema violation) to billing.payment-succeeded.v1.dlq', async () => {
      const bad = paymentSucceeded();
      await server.dispatch(PAYMENT_SUCCEEDED_EVENT.topic, {
        ...bad,
        payload: { ...bad.payload, amountTotal: -1 },
      });
      expect(commandBus.execute).not.toHaveBeenCalled();
      expect(server.deadLetters()[0]?.topic).toBe(`${PAYMENT_SUCCEEDED_EVENT.topic}.dlq`);
    });
  });
});
