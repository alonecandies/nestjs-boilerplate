import type { Notification } from '@app/contracts';
import { defineMail, formatMoney, MailService } from '@app/mailer';
import { Logger } from '@nestjs/common';
import { CommandBus, CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { toUpper } from 'lodash-es';
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
    const { paymentId, userId, amountTotal, currency, paidAt } = input;
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
      this.recipients.findById(userId),
    ]);

    if (recipient) {
      await this.mail.enqueue(
        defineMail({
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
      // The recipient projection is fed by user-registered events; a user created before this
      // service existed has no row yet. The inbox entry is still there.
      this.logger.warn(`No mail recipient for user ${userId}: receipt ${paymentId} not mailed`);
    }
    return notification;
  }
}
