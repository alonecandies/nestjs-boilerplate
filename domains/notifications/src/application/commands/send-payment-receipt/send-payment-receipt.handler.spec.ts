import { Logger } from '@nestjs/common';
import type { CommandBus } from '@nestjs/cqrs';
import type { MailService } from '@platform/mailer';
import { createMock } from '@platform/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  asClass,
  makeContractNotification,
  OTHER_TENANT_ID,
  TENANT_ID,
  USER_ID,
} from '../../../../test/support/fixtures.js';
import { InMemoryNotificationRecipientsRepository } from '../../../testing/in-memory-notification-recipients.repository.js';
import type { NotificationRecipient } from '../../ports/notification-recipients.repository.js';
import { CreateNotificationCommand } from '../create-notification/create-notification.command.js';
import { SendPaymentReceiptCommand } from './send-payment-receipt.command.js';
import {
  RECEIPT_NOTIFICATION_TITLE,
  SendPaymentReceiptHandler,
} from './send-payment-receipt.handler.js';

const PAYMENT_ID = '01920000-0000-7000-8000-0000000000aa';
const paidAt = new Date('2026-09-29T07:30:00.000Z');
const recipientIn = (tenantId: string, email: string): NotificationRecipient => ({
  tenantId,
  userId: USER_ID,
  email,
  displayName: 'Ada',
  updatedAt: paidAt,
});

async function setup(rows: NotificationRecipient[]) {
  const notification = makeContractNotification({ type: 'payment_receipt' });
  const recipients = new InMemoryNotificationRecipientsRepository();
  for (const row of rows) await recipients.upsert(row);
  const find = vi.spyOn(recipients, 'find');
  const commandBus = createMock<CommandBus>({ execute: async () => notification });
  const mail = createMock<MailService>({ enqueue: async () => ({ jobId: 'receipt' }) });
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  return {
    notification,
    find,
    commandBus,
    mail,
    warn,
    handler: new SendPaymentReceiptHandler(recipients, asClass(commandBus), asClass(mail)),
  };
}

/** A receipt for (B, U): B = OTHER_TENANT_ID, the payment's tenant. */
const command = new SendPaymentReceiptCommand({
  tenantId: OTHER_TENANT_ID,
  paymentId: PAYMENT_ID,
  userId: USER_ID,
  amountTotal: 1999,
  currency: 'usd',
  paidAt,
});

describe('SendPaymentReceiptHandler', () => {
  it('creates an idempotent receipt notification and mails the recipient of the payment tenant', async () => {
    const { notification, find, commandBus, mail, warn, handler } = await setup([
      recipientIn(TENANT_ID, 'ada@a.example'),
      recipientIn(OTHER_TENANT_ID, 'ada@b.example'),
    ]);

    await expect(handler.execute(command)).resolves.toBe(notification);

    const [created] = commandBus.execute.mock.calls[0] ?? [];
    // The inbox entry lives in the payment's tenant.
    expect((created as CreateNotificationCommand).input).toEqual({
      tenantId: OTHER_TENANT_ID,
      userId: USER_ID,
      type: 'payment_receipt',
      title: RECEIPT_NOTIFICATION_TITLE,
      body: 'We received your payment of $19.99. Thank you!',
      data: { paymentId: PAYMENT_ID, amountTotal: '1999', currency: 'USD' },
      idempotency: { key: `receipt:${PAYMENT_ID}`, occurredAt: paidAt },
    });
    expect(commandBus.execute.mock.calls[0]?.[0]).toBeInstanceOf(CreateNotificationCommand);
    expect(find).toHaveBeenCalledWith(OTHER_TENANT_ID, USER_ID);
    expect(warn).not.toHaveBeenCalled();
    expect(mail.enqueue).toHaveBeenCalledWith({
      to: 'ada@b.example',
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

  it('creates the inbox entry but sends no mail when the user is a recipient only in another tenant', async () => {
    const { notification, find, commandBus, mail, warn, handler } = await setup([
      recipientIn(TENANT_ID, 'ada@a.example'),
    ]);
    await expect(handler.execute(command)).resolves.toBe(notification);
    expect(commandBus.execute).toHaveBeenCalledTimes(1);
    // No fallback lookup in another tenant.
    expect(find.mock.calls).toEqual([[OTHER_TENANT_ID, USER_ID]]);
    expect(mail.enqueue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
