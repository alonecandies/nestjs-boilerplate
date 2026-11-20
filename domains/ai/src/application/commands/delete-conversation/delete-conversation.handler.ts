import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ConversationNotFoundException } from '../../../domain/ai.errors.js';
import { requireCaller } from '../../caller-scope.js';
import { ConversationsRepository } from '../../repositories/conversations.repository.js';
import { DeleteConversationCommand } from './delete-conversation.command.js';

/** Deletes the caller's conversation and its messages in one unit of work; usage rows stay. */
@CommandHandler(DeleteConversationCommand)
export class DeleteConversationHandler implements ICommandHandler<DeleteConversationCommand> {
  constructor(private readonly conversations: ConversationsRepository) {}

  async execute({ request }: DeleteConversationCommand): Promise<void> {
    requireCaller(request);
    const deleted = await this.conversations.delete(request.tenantId, request.conversationId);
    if (!deleted) throw new ConversationNotFoundException(request.conversationId);
  }
}
