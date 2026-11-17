import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { trim } from 'lodash-es';
import { NotificationRecipientsRepository } from '../../ports/notification-recipients.repository.js';
import { UpsertRecipientCommand } from './upsert-recipient.command.js';

@CommandHandler(UpsertRecipientCommand)
export class UpsertRecipientHandler implements ICommandHandler<UpsertRecipientCommand> {
  constructor(private readonly recipients: NotificationRecipientsRepository) {}

  async execute({ input }: UpsertRecipientCommand): Promise<void> {
    const { tenantId, userId, email, createdAt } = input;
    await this.recipients.upsert({
      tenantId,
      userId,
      email,
      displayName: trim(input.displayName),
      updatedAt: createdAt,
    });
  }
}
