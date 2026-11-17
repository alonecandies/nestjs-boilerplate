import type { Notification } from '@domain/notifications-contracts';
import { CommandBus, CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { MailService } from '@platform/mailer';
import { trim } from 'lodash-es';
import { defineNotificationsMail } from '../../mail/notifications-mail.js';
import { CreateNotificationCommand } from '../create-notification/create-notification.command.js';
import { WelcomeUserCommand } from './welcome-user.command.js';

export const WELCOME_NOTIFICATION_TITLE = 'Welcome aboard!';
export const WELCOME_MAIL_SUBJECT = 'Welcome aboard!';

@CommandHandler(WelcomeUserCommand)
export class WelcomeUserHandler implements ICommandHandler<WelcomeUserCommand> {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly mail: MailService,
  ) {}

  async execute({ input }: WelcomeUserCommand): Promise<Notification> {
    const { tenantId, userId, email, registeredAt } = input;
    // The mail goes to the event's own email: the recipients projection follows memberships
    // (`membership-created`, published alongside this event for the personal workspace).
    const displayName = trim(input.displayName);

    // Keyed by the user, not the envelope id: a re-published event (new envelope id) is
    // still recognised as the same welcome. A user registers once, so one tenant holds it.
    const notification = await this.commandBus.execute(
      new CreateNotificationCommand({
        tenantId,
        userId,
        type: 'welcome',
        title: WELCOME_NOTIFICATION_TITLE,
        body: `Hi ${displayName || 'there'}, your account is ready. Enjoy!`,
        idempotency: { key: `welcome:${userId}`, occurredAt: registeredAt },
      }),
    );

    await this.mail.enqueue(
      defineNotificationsMail({
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
