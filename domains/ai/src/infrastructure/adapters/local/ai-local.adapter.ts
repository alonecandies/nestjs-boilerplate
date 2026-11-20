import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { CursorPage } from '@platform/common';
import { CreateConversationCommand } from '../../../application/commands/create-conversation/create-conversation.command.js';
import { DeleteConversationCommand } from '../../../application/commands/delete-conversation/delete-conversation.command.js';
import { SendMessageCommand } from '../../../application/commands/send-message/send-message.command.js';
import type {
  AiPort,
  ConversationRequest,
  CreateConversationRequest,
  ListConversationsRequest,
  ListMessagesRequest,
  SendMessageRequest,
  SendMessageResult,
} from '../../../application/ports/ai.port.js';
import { GetConversationQuery } from '../../../application/queries/get-conversation/get-conversation.query.js';
import { ListConversationsQuery } from '../../../application/queries/list-conversations/list-conversations.query.js';
import { ListMessagesQuery } from '../../../application/queries/list-messages/list-messages.query.js';
import type { Conversation, Message } from '../../../domain/ai.types.js';

/** `AiPort` in-process (monolith): straight onto the CQRS buses, no serialisation. */
@Injectable()
export class AiLocalAdapter implements AiPort {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  createConversation(input: CreateConversationRequest): Promise<Conversation> {
    return this.commandBus.execute(new CreateConversationCommand(input));
  }

  listConversations(input: ListConversationsRequest): Promise<CursorPage<Conversation>> {
    return this.queryBus.execute(new ListConversationsQuery(input));
  }

  getConversation(input: ConversationRequest): Promise<Conversation> {
    return this.queryBus.execute(new GetConversationQuery(input));
  }

  deleteConversation(input: ConversationRequest): Promise<void> {
    return this.commandBus.execute(new DeleteConversationCommand(input));
  }

  listMessages(input: ListMessagesRequest): Promise<CursorPage<Message>> {
    return this.queryBus.execute(new ListMessagesQuery(input));
  }

  sendMessage(input: SendMessageRequest): Promise<SendMessageResult> {
    return this.commandBus.execute(new SendMessageCommand(input));
  }
}
