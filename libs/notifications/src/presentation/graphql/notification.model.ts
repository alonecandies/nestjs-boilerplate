import type { NotificationType } from '@app/contracts';
import { GraphQLJSONObject, GraphQLUUID } from '@app/graphql';
import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';

/** GraphQL enum names (SCREAMING_CASE) → wire values; exhaustive over the contract's types. */
export const NotificationTypeEnum = {
  WELCOME: 'welcome',
  PAYMENT_RECEIPT: 'payment_receipt',
  DIGEST: 'digest',
  SYSTEM: 'system',
} as const satisfies Record<string, NotificationType>;

registerEnumType(NotificationTypeEnum, {
  name: 'NotificationType',
  description: 'What produced the notification.',
});

@ObjectType('Notification', { description: 'One entry of the caller’s inbox.' })
export class NotificationModel {
  @Field(() => GraphQLUUID)
  id: string;

  @Field(() => NotificationTypeEnum)
  type: NotificationType;

  @Field()
  title: string;

  @Field()
  body: string;

  @Field()
  read: boolean;

  @Field(() => GraphQLJSONObject, { description: 'String attributes (deep links, ids).' })
  data: Record<string, string>;

  @Field()
  createdAt: Date;
}

@ObjectType('NotificationConnection', { description: 'One page of the inbox, newest first.' })
export class NotificationConnectionModel {
  @Field(() => [NotificationModel])
  items: NotificationModel[];

  @Field(() => String, {
    nullable: true,
    description: 'Pass as `pageState` to get the next page; null on the last page.',
  })
  nextPageState: string | null;
}
