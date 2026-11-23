import { Field, InputType, Int } from '@nestjs/graphql';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
} from '@platform/common';
import { IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { BILLING_LIMITS } from '../../../billing.constants.js';

/** Validated by the global class-validator pipe (every field needs a decorator). */
@InputType('CreateCheckoutSessionInput')
export class CreateCheckoutSessionInput {
  @Field({ description: 'Stripe Price id (price_…)' })
  @IsString()
  @Length(1, BILLING_LIMITS.PRICE_ID_MAX_LENGTH)
  priceId: string;

  @Field(() => Int, { defaultValue: 1 })
  @IsInt()
  @Min(1)
  @Max(BILLING_LIMITS.MAX_QUANTITY)
  quantity: number;

  @Field(() => String, {
    nullable: true,
    description: 'Replays with the same key return the same session',
  })
  @IsOptional()
  @IsString()
  @Length(IDEMPOTENCY_KEY_MIN_LENGTH, IDEMPOTENCY_KEY_MAX_LENGTH)
  @Matches(IDEMPOTENCY_KEY_PATTERN)
  idempotencyKey?: string | null;
}
