import { NOTIFICATION_CREATED_EVENT } from '@domain/notifications-contracts';
import { Global, Logger, Module } from '@nestjs/common';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { CASSANDRA_CLIENT, type CassandraClient } from '@platform/cassandra';
import { type MailMessage, MailService } from '@platform/mailer';
import { createMock } from '@platform/testing';
import { isRetriableKafkaHandlerError, KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TENANT_ID, USER_ID } from '../test/support/fixtures.js';
import { SendPaymentReceiptCommand } from './application/commands/send-payment-receipt/send-payment-receipt.command.js';
import { WelcomeUserCommand } from './application/commands/welcome-user/welcome-user.command.js';
import { NotificationRecipientsRepository } from './application/ports/notification-recipients.repository.js';
import { NotificationsRepository } from './application/ports/notifications.repository.js';
import { NotificationsCoreModule } from './notifications-core.module.js';
import { InMemoryNotificationRecipientsRepository } from './testing/in-memory-notification-recipients.repository.js';
import { InMemoryNotificationsRepository } from './testing/in-memory-notifications.repository.js';

const PAYMENT_ID = '01920000-0000-7000-8000-0000000000aa';
const registeredAt = new Date('2026-09-29T07:00:00.000Z');
const paidAt = new Date('2026-09-29T07:30:00.000Z');

const welcome = new WelcomeUserCommand({
  tenantId: TENANT_ID,
  userId: USER_ID,
  email: 'ada@example.com',
  displayName: 'Ada',
  registeredAt,
});

const receipt = new SendPaymentReceiptCommand({
  tenantId: TENANT_ID,
  paymentId: PAYMENT_ID,
  userId: USER_ID,
  amountTotal: 1999,
  currency: 'usd',
  paidAt,
});

/**
 * The real notifications core behind the real `CommandBus`: in-memory repositories, a recording
 * Kafka producer, and a mail queue that, like BullMQ with a job id, ignores a second enqueue of a
 * key it already holds.
 */
async function setup() {
  const kafka = new FakeKafkaProducer({ source: 'notifications-test' });
  const notifications = new InMemoryNotificationsRepository();
  const recipients = new InMemoryNotificationRecipientsRepository();
  await recipients.upsert({
    tenantId: TENANT_ID,
    userId: USER_ID,
    email: 'ada@example.com',
    displayName: 'Ada',
    updatedAt: paidAt,
  });
  const queued = new Map<string, unknown>();
  const mail = createMock<MailService>({
    enqueue: async (message: MailMessage) => {
      const jobId = message.idempotencyKey ?? `job-${queued.size}`;
      if (!queued.has(jobId)) queued.set(jobId, message);
      return { jobId };
    },
  });

  @Global()
  @Module({
    providers: [
      { provide: CASSANDRA_CLIENT, useValue: createMock<CassandraClient>() },
      { provide: KafkaProducer, useValue: kafka },
      { provide: MailService, useValue: mail },
    ],
    exports: [CASSANDRA_CLIENT, KafkaProducer, MailService],
  })
  class FakeInfrastructureModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [CqrsModule.forRoot(), FakeInfrastructureModule, NotificationsCoreModule],
  })
    .overrideProvider(NotificationsRepository)
    .useValue(notifications)
    .overrideProvider(NotificationRecipientsRepository)
    .useValue(recipients)
    .compile();
  await moduleRef.init();
  return { moduleRef, commandBus: moduleRef.get(CommandBus), kafka, notifications, mail, queued };
}

describe('notifications push: a failed publish fails the upstream event (at-least-once)', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    vi.restoreAllMocks();
  });

  it.each([
    ['welcome', welcome, 'welcome-'],
    ['receipt', receipt, 'receipt-'],
  ] as const)(
    '%s: a broker failure rejects; the redelivery publishes once, with one row and one mail',
    async (_name, command, mailKeyPrefix) => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const infra = await setup();
      moduleRef = infra.moduleRef;
      infra.kafka.failNextWith(new Error('broker down'));

      // The row and the mail were written before the publish failed; the event is not done.
      const failure = await infra.commandBus.execute(command).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((failure as Error | undefined)?.cause).toEqual(new Error('broker down'));
      // Retriable: the consumer retries it in process, then dead-letters it.
      expect(isRetriableKafkaHandlerError(failure)).toBe(true);
      expect(infra.kafka.envelopes(NOTIFICATION_CREATED_EVENT)).toHaveLength(0);
      expect(infra.notifications.all()).toHaveLength(1);
      expect(infra.queued.size).toBe(1);

      // The consumer's retry (or a DLQ replay) runs the same command again.
      const notification = await infra.commandBus.execute(command);

      const envelopes = infra.kafka.envelopes(NOTIFICATION_CREATED_EVENT);
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]).toMatchObject({
        id: notification.id,
        tenantId: TENANT_ID,
        payload: { notificationId: notification.id, userId: USER_ID },
      });
      expect(infra.notifications.all().map((row) => row.id)).toEqual([notification.id]);
      // Both attempts enqueue under the same idempotency key, so the queue holds one mail.
      const keys = infra.mail.enqueue.mock.calls.map(([message]) => message.idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]?.startsWith(mailKeyPrefix)).toBe(true);
      expect(infra.queued.size).toBe(1);
    },
  );
});
