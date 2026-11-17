import type { Notification } from '@domain/notifications-contracts';
import { Logger } from '@nestjs/common';
import { CommandBus, CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { formatMoney, MailService } from '@platform/mailer';
import { toUpper } from 'lodash-es';
import { defineNotificationsMail } from '../../mail/notifications-mail.js';
import { NotificationRecipientsRepository } from '../../ports/notification-recipients.repository.js';
import { CreateNotificationCommand } from '../create-notification/create-notification.command.js';
import { SendPaymentReceiptCommand } from './send-payment-receipt.command.js';

export const RECEIPT_NOTIFICATION_TITLE = 'Payment received';

@CommandHandler(SendPaymentReceiptCommand)
export class SendPaymentReceiptHandler implements ICommandHandler<SendPaymentReceiptCommand> {
  private readonly logger = new Logger(SendPaymentReceiptHandler.name);

  constructor(
    private readonly recipients: NotificationRecipientsRepository,
    private readonly commandBus: CommandBus,
    private readonly mail: MailService,
  ) {}

  async execute({ input }: SendPaymentReceiptCommand): Promise<Notification> {
    const { tenantId, paymentId, userId, amountTotal, currency, paidAt } = input;
    const amount = formatMoney(amountTotal, currency);

    const [notification, recipient] = await Promise.all([
      this.commandBus.execute(
        new CreateNotificationCommand({
          userId,
          type: 'payment_receipt',
          title: RECEIPT_NOTIFICATION_TITLE,
          body: `We received your payment of ${amount}. Thank you!`,
          data: { paymentId, amountTotal: String(amountTotal), currency: toUpper(currency) },
          idempotency: { key: `receipt:${paymentId}`, occurredAt: paidAt },
        }),
      ),
      this.recipients.find(tenantId, userId),
    ]);

    if (recipient) {
      await this.mail.enqueue(
        defineNotificationsMail({
          to: recipient.email,
          subject: `Your receipt (${amount})`,
          template: 'payment-receipt',
          context: {
            displayName: recipient.displayName || undefined,
            paymentId,
            amount,
            paidAt: paidAt.toISOString(),
          },
          idempotencyKey: `receipt-${paymentId}`,
        }),
      );
    } else {
      // The projection is fed by membership events: no row for this (tenant, user) means no
      // membership event was seen yet (or it ended). There is no lookup in another tenant. The
      // inbox entry is still there.
      this.logger.warn(
        `No mail recipient for user ${userId} in tenant ${tenantId}: receipt ${paymentId} not mailed`,
      );
    }
    return notification;
  }
}
