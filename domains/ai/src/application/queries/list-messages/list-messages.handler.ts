import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { type CursorPage, resolvePageSize } from '@platform/common';
import { Transactional } from '@platform/database';
import { AI_PAGE_SIZE } from '../../../ai.constants.js';
import { ConversationNotFoundException } from '../../../domain/ai.errors.js';
import type { Message } from '../../../domain/ai.types.js';
import { requireCaller } from '../../caller-scope.js';
import { ConversationsRepository } from '../../repositories/conversations.repository.js';
import { MessagesRepository } from '../../repositories/messages.repository.js';
import { ListMessagesQuery } from './list-messages.query.js';

/**
 * One page of a conversation's messages, newest first. The conversation is loaded as the caller in
 * the same unit of work first, so another user's conversation is a 404, not an empty page.
 */
@QueryHandler(ListMessagesQuery)
export class ListMessagesHandler implements IQueryHandler<ListMessagesQuery> {
  constructor(
    private readonly conversations: ConversationsRepository,
    private readonly messages: MessagesRepository,
  ) {}

  execute({ request }: ListMessagesQuery): Promise<CursorPage<Message>> {
    requireCaller(request);
    return this.read(request);
  }

  @Transactional()
  protected async read(request: ListMessagesQuery['request']): Promise<CursorPage<Message>> {
    const conversation = await this.conversations.findById(
      request.tenantId,
      request.conversationId,
    );
    if (conversation === null) throw new ConversationNotFoundException(request.conversationId);
    return this.messages.list({
      tenantId: request.tenantId,
      conversationId: request.conversationId,
      limit: resolvePageSize(request.limit, AI_PAGE_SIZE),
      cursor: request.cursor,
    });
  }
}
