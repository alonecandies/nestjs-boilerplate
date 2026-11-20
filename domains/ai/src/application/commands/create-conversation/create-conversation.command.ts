import { Command } from '@nestjs/cqrs';
import type { Conversation } from '../../../domain/ai.types.js';
import type { CreateConversationRequest } from '../../ports/ai.port.js';

/** Starts a conversation for the caller on an allowed model. */
export class CreateConversationCommand extends Command<Conversation> {
  constructor(readonly request: CreateConversationRequest) {
    super();
  }
}
