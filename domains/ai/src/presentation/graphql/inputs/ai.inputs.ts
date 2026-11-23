import { Field, InputType } from '@nestjs/graphql';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
} from '@platform/common';
import { GraphQLUUID } from '@platform/graphql';
import { Transform, type TransformFnParams } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { AI_LIMITS } from '../../../ai.constants.js';

/** Trims surrounding whitespace before validation, like the REST schemas (`z.string().trim()`). */
const Trim = (): PropertyDecorator =>
  Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim() : value,
  );

/** Validated by the global class-validator pipe (every field needs a decorator). */
@InputType('CreateAiConversationInput')
export class CreateAiConversationInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, AI_LIMITS.TITLE_MAX_LENGTH)
  title?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Default `AI_DEFAULT_MODEL`; must be allowed.',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, AI_LIMITS.MODEL_MAX_LENGTH)
  model?: string | null;
}

@InputType('SendAiMessageInput')
export class SendAiMessageInput {
  @Field(() => GraphQLUUID)
  @IsUUID()
  conversationId: string;

  @Field({ description: 'Your message.' })
  @Trim()
  @IsString()
  @Length(1, AI_LIMITS.MESSAGE_MAX_LENGTH)
  content: string;

  @Field(() => String, {
    nullable: true,
    description: "Default: the conversation's model; must be allowed.",
  })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, AI_LIMITS.MODEL_MAX_LENGTH)
  model?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Replays with the same key and message return the stored reply.',
  })
  @IsOptional()
  @IsString()
  @Length(IDEMPOTENCY_KEY_MIN_LENGTH, IDEMPOTENCY_KEY_MAX_LENGTH)
  @Matches(IDEMPOTENCY_KEY_PATTERN)
  idempotencyKey?: string | null;
}
