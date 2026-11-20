import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import type { CursorPage } from '@platform/common';
import type { Conversation } from '../../../domain/ai.types.js';
import { requireCaller } from '../../caller-scope.js';
import { pageSize } from '../../page-size.js';
import { ConversationsRepository } from '../../repositories/conversations.repository.js';
import { ListConversationsQuery } from './list-conversations.query.js';

/** The caller's conversations, newest first (keyset pages; the policies show no one else's). */
@QueryHandler(ListConversationsQuery)
export class ListConversationsHandler implements IQueryHandler<ListConversationsQuery> {
  constructor(private readonly conversations: ConversationsRepository) {}

  execute({ request }: ListConversationsQuery): Promise<CursorPage<Conversation>> {
    requireCaller(request);
    return this.conversations.list({
      tenantId: request.tenantId,
      userId: request.userId,
      limit: pageSize(request.limit),
      cursor: request.cursor,
    });
  }
}
