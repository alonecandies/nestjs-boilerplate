import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { NotificationRecipientsRepository } from '../../ports/notification-recipients.repository.js';
import { RemoveRecipientCommand } from './remove-recipient.command.js';

@CommandHandler(RemoveRecipientCommand)
export class RemoveRecipientHandler implements ICommandHandler<RemoveRecipientCommand> {
  constructor(private readonly recipients: NotificationRecipientsRepository) {}

  async execute({ input }: RemoveRecipientCommand): Promise<void> {
    await this.recipients.remove(input.tenantId, input.userId, input.removedAt);
  }
}
