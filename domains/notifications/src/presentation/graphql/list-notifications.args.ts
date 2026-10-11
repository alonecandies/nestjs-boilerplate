import { ArgsType, Field, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import {
  DEFAULT_NOTIFICATIONS_PAGE_SIZE,
  MAX_NOTIFICATIONS_PAGE_SIZE,
  PAGE_STATE_MAX_LENGTH,
  PAGE_STATE_PATTERN,
} from '../../notifications.constants.js';

/** `notifications(limit, pageState)` — every field carries class-validator rules (whitelisting). */
@ArgsType()
export class ListNotificationsArgs {
  @Field(() => Int, { defaultValue: DEFAULT_NOTIFICATIONS_PAGE_SIZE })
  @IsInt()
  @Min(1)
  @Max(MAX_NOTIFICATIONS_PAGE_SIZE)
  limit: number = DEFAULT_NOTIFICATIONS_PAGE_SIZE;

  @Field(() => String, {
    nullable: true,
    description: 'Opaque `nextPageState` of the previous page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(PAGE_STATE_MAX_LENGTH)
  @Matches(PAGE_STATE_PATTERN, { message: 'pageState must be a nextPageState of a previous page' })
  pageState?: string | null;
}
