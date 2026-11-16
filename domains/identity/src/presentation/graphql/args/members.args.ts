import { ArgsType, Field, Int } from '@nestjs/graphql';
import { MAX_CURSOR_LENGTH, MAX_PAGE_LIMIT } from '@platform/common';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

@ArgsType()
export class MembersArgs {
  @Field(() => Int, { nullable: true, description: '1-100; omitted = the default page size' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit?: number | null;

  @Field(() => String, { nullable: true, description: '`nextCursor` of the previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CURSOR_LENGTH)
  cursor?: string | null;
}
