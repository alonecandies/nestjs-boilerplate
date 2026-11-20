import { Query } from '@nestjs/cqrs';
import type { CursorPage } from '@platform/common';
import type { Conversation } from '../../../domain/ai.types.js';
import type { ListConversationsRequest } from '../../ports/ai.port.js';

export class ListConversationsQuery extends Query<CursorPage<Conversation>> {
  constructor(readonly request: ListConversationsRequest) {
    super();
  }
}
