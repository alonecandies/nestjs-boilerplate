import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { ConversationNotFoundException } from '../../../domain/ai.errors.js';
import type { Conversation } from '../../../domain/ai.types.js';
import { requireCaller } from '../../caller-scope.js';
import { ConversationsRepository } from '../../repositories/conversations.repository.js';
import { GetConversationQuery } from './get-conversation.query.js';

/** One of the caller's conversations; another user's or tenant's is a 404 (RLS hides it). */
@QueryHandler(GetConversationQuery)
export class GetConversationHandler implements IQueryHandler<GetConversationQuery> {
  constructor(private readonly conversations: ConversationsRepository) {}

  async execute({ request }: GetConversationQuery): Promise<Conversation> {
    requireCaller(request);
    const conversation = await this.conversations.findById(
      request.tenantId,
      request.conversationId,
    );
    if (conversation === null) throw new ConversationNotFoundException(request.conversationId);
    return conversation;
  }
}
