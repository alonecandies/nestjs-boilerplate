import { ArgsType, Field, Int } from '@nestjs/graphql';
import { MAX_CURSOR_LENGTH } from '@platform/common';
import { GraphQLUUID } from '@platform/graphql';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { AI_LIMITS } from '../../../ai.constants.js';

/** `aiConversations(limit, cursor)`. */
@ArgsType()
export class AiConversationsArgs {
  @Field(() => Int, { defaultValue: AI_LIMITS.DEFAULT_PAGE_SIZE })
  @IsInt()
  @Min(1)
  @Max(AI_LIMITS.MAX_PAGE_SIZE)
  limit: number = AI_LIMITS.DEFAULT_PAGE_SIZE;

  @Field(() => String, { nullable: true, description: '`nextCursor` of the previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CURSOR_LENGTH)
  cursor?: string | null;
}

/** `aiMessages(conversationId, limit, cursor)`. */
@ArgsType()
export class AiMessagesArgs extends AiConversationsArgs {
  @Field(() => GraphQLUUID)
  @IsUUID()
  conversationId: string;
}
