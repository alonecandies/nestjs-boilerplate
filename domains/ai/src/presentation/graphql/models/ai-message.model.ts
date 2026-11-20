import { Field, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import type { CursorPage } from '@platform/common';
import { GraphQLJSONObject, GraphQLUUID } from '@platform/graphql';
import { toUpper, zipObject } from 'lodash-es';
import type { SendMessageResult } from '../../../application/ports/ai.port.js';
import {
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
  type Message,
  type MessageRole,
  type MessageStatus,
} from '../../../domain/ai.types.js';
import { type MessageResponse, toMessageResponse } from '../../http/ai.dto.js';

/** `AiMessageRole`: SCREAMING_CASE names whose values are the domain roles (`USER` ↔ `'user'`). */
export const AiMessageRoleEnum: Readonly<Record<string, MessageRole>> = zipObject(
  MESSAGE_ROLES.map(toUpper),
  MESSAGE_ROLES,
);
registerEnumType(AiMessageRoleEnum, { name: 'AiMessageRole', description: 'Who wrote a message.' });

export const AiMessageStatusEnum: Readonly<Record<string, MessageStatus>> = zipObject(
  MESSAGE_STATUSES.map(toUpper),
  MESSAGE_STATUSES,
);
registerEnumType(AiMessageStatusEnum, {
  name: 'AiMessageStatus',
  description: '`INCOMPLETE`: a reply cut short (the client left mid-stream, or the call failed).',
});

@ObjectType('AiMessage', { description: 'One message of an AI conversation.' })
export class AiMessageModel {
  @Field(() => GraphQLUUID)
  id: string;

  @Field(() => GraphQLUUID)
  conversationId: string;

  @Field(() => AiMessageRoleEnum)
  role: MessageRole;

  @Field(() => String, {
    nullable: true,
    description: 'The text; null when the message has parts.',
  })
  text: string | null;

  @Field(() => [GraphQLJSONObject], {
    nullable: true,
    description: 'AI SDK message parts (tool calls and results); null for plain text.',
  })
  parts: Record<string, unknown>[] | null;

  @Field(() => AiMessageStatusEnum)
  status: MessageStatus;

  @Field(() => String, {
    nullable: true,
    description: 'The model that wrote an assistant message.',
  })
  model: string | null;

  @Field(() => Int, { nullable: true })
  inputTokens: number | null;

  @Field(() => Int, { nullable: true })
  outputTokens: number | null;

  @Field()
  createdAt: Date;
}

@ObjectType('AiMessageConnection', { description: 'One page of messages, newest first.' })
export class AiMessageConnectionModel {
  @Field(() => [AiMessageModel])
  items: AiMessageModel[];

  @Field(() => String, { nullable: true, description: 'Pass as `cursor`; null on the last page.' })
  nextCursor: string | null;
}

@ObjectType('AiSendMessageResult')
export class AiSendMessageResultModel {
  @Field(() => AiMessageModel, { description: "The assistant's reply." })
  message: AiMessageModel;

  @Field({ description: '`true` when an `idempotencyKey` replay returned the stored reply.' })
  replayed: boolean;
}

/**
 * The REST `AiMessage` (JSON: what the stream subscription carries over Redis) → the GraphQL
 * model, so both transports present a message the same way.
 */
export function toAiMessageModel(message: MessageResponse): AiMessageModel {
  const { content } = message;
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    text: typeof content === 'string' ? content : null,
    parts: typeof content === 'string' ? null : content,
    status: message.status,
    model: message.model,
    inputTokens: message.inputTokens,
    outputTokens: message.outputTokens,
    createdAt: new Date(message.createdAt),
  };
}

export const aiMessageModelOf = (message: Message): AiMessageModel =>
  toAiMessageModel(toMessageResponse(message));

export const toAiMessageConnection = (page: CursorPage<Message>): AiMessageConnectionModel => ({
  items: page.items.map(aiMessageModelOf),
  nextCursor: page.nextCursor,
});

export const toAiSendMessageResult = (result: SendMessageResult): AiSendMessageResultModel => ({
  message: aiMessageModelOf(result.message),
  replayed: result.replayed,
});
