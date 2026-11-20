import { Field, ObjectType } from '@nestjs/graphql';
import type { CursorPage } from '@platform/common';
import { GraphQLUUID } from '@platform/graphql';
import type { Conversation } from '../../../domain/ai.types.js';

@ObjectType('AiConversation', { description: 'One of your AI conversations.' })
export class AiConversationModel {
  @Field(() => GraphQLUUID)
  id: string;

  @Field(() => String, { nullable: true })
  title: string | null;

  @Field({ description: 'The model the conversation uses unless a message asks for another.' })
  model: string;

  @Field()
  createdAt: Date;

  @Field({ description: 'Last activity.' })
  updatedAt: Date;
}

@ObjectType('AiConversationConnection', { description: 'One page of conversations, newest first.' })
export class AiConversationConnectionModel {
  @Field(() => [AiConversationModel])
  items: AiConversationModel[];

  @Field(() => String, { nullable: true, description: 'Pass as `cursor`; null on the last page.' })
  nextCursor: string | null;
}

export const toAiConversationModel = (conversation: Conversation): AiConversationModel => ({
  id: conversation.id,
  title: conversation.title,
  model: conversation.model,
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
});

export const toAiConversationConnection = (
  page: CursorPage<Conversation>,
): AiConversationConnectionModel => ({
  items: page.items.map(toAiConversationModel),
  nextCursor: page.nextCursor,
});
