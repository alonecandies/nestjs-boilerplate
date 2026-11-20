import { Command } from '@nestjs/cqrs';
import type { ConversationRequest } from '../../ports/ai.port.js';

/** Deletes one of the caller's conversations with its messages. */
export class DeleteConversationCommand extends Command<void> {
  constructor(readonly request: ConversationRequest) {
    super();
  }
}
