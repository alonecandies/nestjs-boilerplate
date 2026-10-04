import { CurrentUser, Permission, RequirePermissions } from '@app/auth';
import type { NotificationCreatedPayload, NotificationPage } from '@app/contracts';
import { type GqlContext, type GraphqlPubSub, InjectPubSub } from '@app/graphql';
import { Args, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';
import { notificationFromCreatedPayload } from '../../application/mappers/notification.mapper.js';
import { NotificationsPort } from '../../application/ports/notifications.port.js';
import { NOTIFICATION_CREATED_TRIGGER } from '../../notifications.constants.js';
import { toNotificationView } from '../notification-view.js';
import { ListNotificationsArgs } from './list-notifications.args.js';
import { MarkNotificationReadInput } from './mark-notification-read.input.js';
import { NotificationConnectionModel, NotificationModel } from './notification.model.js';

/** Contract page → GraphQL connection. */
export function toNotificationConnection(page: NotificationPage): NotificationConnectionModel {
  return {
    items: page.items.map(toNotificationView),
    nextPageState: page.nextPageState ?? null,
  };
}

/**
 * Subscribers only receive their own notifications. The trigger is global (one Redis channel)
 * and the filter runs per subscriber on each replica — cheap, since it is one string compare.
 */
export function isOwnNotification(
  payload: NotificationCreatedPayload,
  _variables: unknown,
  context: GqlContext,
): boolean {
  const userId = context.req.user?.id;
  return userId !== undefined && payload.userId === userId;
}

/**
 * RedisPubSub carries JSON, so the payload is the Kafka event payload (ISO `createdAt`); map it to
 * the model the same way queries do.
 */
export function toCreatedNotificationModel(payload: NotificationCreatedPayload): NotificationModel {
  return toNotificationView(notificationFromCreatedPayload(payload));
}

@Resolver(() => NotificationModel)
export class NotificationsResolver {
  constructor(
    private readonly port: NotificationsPort,
    @InjectPubSub() private readonly pubSub: GraphqlPubSub,
  ) {}

  @Query(() => NotificationConnectionModel, {
    name: 'notifications',
    description: 'My notifications, newest first.',
    complexity: 5,
  })
  @RequirePermissions(Permission.NotificationsRead)
  async notifications(
    @Args() args: ListNotificationsArgs,
    @CurrentUser('id') userId: string,
  ): Promise<NotificationConnectionModel> {
    const page = await this.port.list({
      userId,
      limit: args.limit,
      pageState: args.pageState ?? undefined,
    });
    return toNotificationConnection(page);
  }

  @Mutation(() => Boolean, {
    name: 'markNotificationRead',
    description: 'Marks one of my notifications read (idempotent). NOT_FOUND outside my inbox.',
  })
  @RequirePermissions(Permission.NotificationsRead)
  async markNotificationRead(
    @Args('input') input: MarkNotificationReadInput,
    @CurrentUser('id') userId: string,
  ): Promise<boolean> {
    await this.port.markRead({ userId, notificationId: input.id });
    return true;
  }

  @Subscription(() => NotificationModel, {
    name: 'notificationCreated',
    description: 'Real-time feed of my new notifications.',
    filter: isOwnNotification,
    resolve: toCreatedNotificationModel,
  })
  @RequirePermissions(Permission.NotificationsRead)
  notificationCreated(): AsyncIterableIterator<NotificationCreatedPayload> {
    return this.pubSub.asyncIterableIterator<NotificationCreatedPayload>(
      NOTIFICATION_CREATED_TRIGGER,
    );
  }
}
