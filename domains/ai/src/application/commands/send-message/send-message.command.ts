import { Command } from '@nestjs/cqrs';
import type { SendMessageRequest, SendMessageResult } from '../../ports/ai.port.js';

/** Sends a user message to the model and stores the exchange. Idempotent per `Idempotency-Key`. */
export class SendMessageCommand extends Command<SendMessageResult> {
  constructor(readonly request: SendMessageRequest) {
    super();
  }
}
