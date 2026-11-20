import { Command } from '@nestjs/cqrs';
import type { ChatStreamEvent, StreamMessageRequest } from '../../ports/ai.port.js';

/**
 * Sends a user message and streams the reply (`AiPort.streamMessage`). Resolves once the turn
 * started; the stored reply comes as the stream's `done` event.
 */
export class StreamMessageCommand extends Command<AsyncIterable<ChatStreamEvent>> {
  constructor(readonly request: StreamMessageRequest) {
    super();
  }
}
