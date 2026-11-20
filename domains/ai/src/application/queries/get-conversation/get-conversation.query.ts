import { Query } from '@nestjs/cqrs';
import type { Conversation } from '../../../domain/ai.types.js';
import type { ConversationRequest } from '../../ports/ai.port.js';

export class GetConversationQuery extends Query<Conversation> {
  constructor(readonly request: ConversationRequest) {
    super();
  }
}
