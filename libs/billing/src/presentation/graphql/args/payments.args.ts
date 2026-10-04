import { MAX_CURSOR_LENGTH } from '@app/common';
import { ArgsType, Field, Int } from '@nestjs/graphql';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { BILLING_LIMITS } from '../../../billing.constants.js';

@ArgsType()
export class PaymentsArgs {
  @Field({ defaultValue: false, description: "Every user's payments (requires billing:read-all)" })
  @IsBoolean()
  all: boolean;

  @Field(() => Int, { defaultValue: BILLING_LIMITS.DEFAULT_PAGE_SIZE })
  @IsInt()
  @Min(1)
  @Max(BILLING_LIMITS.MAX_PAGE_SIZE)
  limit: number;

  @Field(() => String, { nullable: true, description: '`nextCursor` of the previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CURSOR_LENGTH)
  cursor?: string | null;
}
