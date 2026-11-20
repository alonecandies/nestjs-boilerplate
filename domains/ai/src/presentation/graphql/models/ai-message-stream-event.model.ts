import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';
import { GraphQLUUID } from '@platform/graphql';
import { AiMessageModel } from './ai-message.model.js';

/** The kinds of `aiMessageStream` events (GraphQL `DELTA` ↔ wire `'delta'`). */
export const AI_MESSAGE_STREAM_EVENT_TYPES = ['delta', 'done', 'error'] as const;
export type AiMessageStreamEventType = (typeof AI_MESSAGE_STREAM_EVENT_TYPES)[number];

export const AiMessageStreamEventTypeEnum = {
  DELTA: 'delta',
  DONE: 'done',
  ERROR: 'error',
} as const satisfies Record<string, AiMessageStreamEventType>;
registerEnumType(AiMessageStreamEventTypeEnum, {
  name: 'AiMessageStreamEventType',
  description: '`DELTA`: a chunk of the reply. `DONE`: the stored reply. `ERROR`: the turn failed.',
});

@ObjectType('AiMessageStreamEvent', {
  description:
    'One event of a streamed turn (`streamAiMessage`): `DELTA`s in order, then `DONE` or `ERROR`.',
})
export class AiMessageStreamEventModel {
  @Field(() => GraphQLUUID)
  conversationId: string;

  @Field(() => AiMessageStreamEventTypeEnum)
  type: AiMessageStreamEventType;

  @Field(() => String, { nullable: true, description: 'The next chunk of text (`DELTA`).' })
  delta: string | null;

  @Field(() => AiMessageModel, { nullable: true, description: 'The stored reply (`DONE`).' })
  message: AiMessageModel | null;

  @Field(() => Boolean, {
    nullable: true,
    description: '`true` when an `idempotencyKey` replay returned the stored reply (`DONE`).',
  })
  replayed: boolean | null;

  @Field(() => String, { nullable: true, description: 'The error code (`ERROR`).' })
  errorCode: string | null;
}
