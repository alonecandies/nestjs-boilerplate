import type { Notification } from '@app/contracts';
import { defineMail, MailService } from '@app/mailer';
import { CommandBus, CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { trim } from 'lodash-es';
import { NotificationRecipientsRepository } from '../../ports/notification-recipients.repository.js';
import { CreateNotificationCommand } from '../create-notification/create-notification.command.js';
import { WelcomeUserCommand } from './welcome-user.command.js';

export const WELCOME_NOTIFICATION_TITLE = 'Welcome aboard!';
export const WELCOME_MAIL_SUBJECT = 'Welcome aboard!';

@CommandHandler(WelcomeUserCommand)
export class WelcomeUserHandler implements ICommandHandler<WelcomeUserCommand> {
  constructor(
    private readonly recipients: NotificationRecipientsRepository,
    private readonly commandBus: CommandBus,
    private readonly mail: MailService,
  ) {}

  async execute({ input }: WelcomeUserCommand): Promise<Notification> {
    const { userId, email, registeredAt } = input;
    const displayName = trim(input.displayName);
    await this.recipients.upsert({ userId, email, displayName, updatedAt: registeredAt });

    // Keyed by the user, not the envelope id: a re-published event (new envelope id) is
    // still recognised as the same welcome.
    const notification = await this.commandBus.execute(
      new CreateNotificationCommand({
        userId,
        type: 'welcome',
        title: WELCOME_NOTIFICATION_TITLE,
        body: `Hi ${displayName || 'there'}, your account is ready. Enjoy!`,
        idempotency: { key: `welcome:${userId}`, occurredAt: registeredAt },
      }),
    );

    await this.mail.enqueue(
      defineMail({
        to: email,
        subject: WELCOME_MAIL_SUBJECT,
        template: 'welcome',
        context: { displayName: displayName || email },
        idempotencyKey: `welcome-${userId}`,
      }),
    );
    return notification;
  }
}
