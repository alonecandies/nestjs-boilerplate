import type { MailService } from '@app/mailer';
import { createMock } from '@app/testing';
import type { CommandBus } from '@nestjs/cqrs';
import { describe, expect, it } from 'vitest';
import { asClass, makeContractNotification, USER_ID } from '../../../../test/support/fixtures.js';
import type {
  NotificationRecipient,
  NotificationRecipientsRepository,
} from '../../ports/notification-recipients.repository.js';
import { CreateNotificationCommand } from '../create-notification/create-notification.command.js';
import { SendPaymentReceiptCommand } from './send-payment-receipt.command.js';
import {
  RECEIPT_NOTIFICATION_TITLE,
  SendPaymentReceiptHandler,
} from './send-payment-receipt.handler.js';

const PAYMENT_ID = '01920000-0000-7000-8000-0000000000aa';
const paidAt = new Date('2026-09-29T07:30:00.000Z');
const recipient: NotificationRecipient = {
  userId: USER_ID,
  email: 'ada@example.com',
  displayName: 'Ada',
  updatedAt: paidAt,
};

function setup(found: NotificationRecipient | null) {
  const notification = makeContractNotification({ type: 'payment_receipt' });
  const recipients = createMock<NotificationRecipientsRepository>({ findById: async () => found });
  const commandBus = createMock<CommandBus>({ execute: async () => notification });
  const mail = createMock<MailService>({ enqueue: async () => ({ jobId: 'receipt' }) });
  return {
    notification,
    recipients,
    commandBus,
    mail,
    handler: new SendPaymentReceiptHandler(recipients, asClass(commandBus), asClass(mail)),
  };
}

const command = new SendPaymentReceiptCommand({
  paymentId: PAYMENT_ID,
  userId: USER_ID,
  amountTotal: 1999,
  currency: 'usd',
  paidAt,
});

describe('SendPaymentReceiptHandler', () => {
  it('creates an idempotent receipt notification and mails the known recipient', async () => {
    const { notification, commandBus, mail, handler } = setup(recipient);

    await expect(handler.execute(command)).resolves.toBe(notification);

    const [created] = commandBus.execute.mock.calls[0] ?? [];
    expect((created as CreateNotificationCommand).input).toEqual({
      userId: USER_ID,
      type: 'payment_receipt',
      title: RECEIPT_NOTIFICATION_TITLE,
      body: 'We received your payment of $19.99. Thank you!',
      data: { paymentId: PAYMENT_ID, amountTotal: '1999', currency: 'USD' },
      idempotency: { key: `receipt:${PAYMENT_ID}`, occurredAt: paidAt },
    });
    expect(commandBus.execute.mock.calls[0]?.[0]).toBeInstanceOf(CreateNotificationCommand);
    expect(mail.enqueue).toHaveBeenCalledWith({
      to: 'ada@example.com',
      subject: 'Your receipt ($19.99)',
      template: 'payment-receipt',
      context: {
        displayName: 'Ada',
        paymentId: PAYMENT_ID,
        amount: '$19.99',
        paidAt: paidAt.toISOString(),
      },
      idempotencyKey: `receipt-${PAYMENT_ID}`,
    });
  });

  it('still creates the notification but skips the mail for an unknown recipient', async () => {
    const { notification, commandBus, mail, handler } = setup(null);
    await expect(handler.execute(command)).resolves.toBe(notification);
    expect(commandBus.execute).toHaveBeenCalledTimes(1);
    expect(mail.enqueue).not.toHaveBeenCalled();
  });
});
