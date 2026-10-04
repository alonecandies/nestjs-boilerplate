import { DEFAULT_PAGE_LIMIT, MAX_CURSOR_LENGTH, MAX_PAGE_LIMIT } from '@app/common';
import { ArgsType, Field, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';
import { TrimString } from '../../shared/transforms.js';

@ArgsType()
export class UsersArgs {
  @Field(() => Int, { defaultValue: DEFAULT_PAGE_LIMIT })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit: number = DEFAULT_PAGE_LIMIT;

  @Field(() => String, { nullable: true, description: '`nextCursor` of the previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CURSOR_LENGTH)
  cursor?: string | null;

  @Field(() => String, { nullable: true, description: 'Substring of email or display name' })
  @IsOptional()
  @TrimString()
  @IsString()
  @MaxLength(IDENTITY_LIMITS.SEARCH_MAX_LENGTH)
  search?: string | null;
}
