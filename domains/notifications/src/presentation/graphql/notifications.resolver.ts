import type { NotificationCreatedPayload, NotificationPage } from '@domain/notifications-contracts';
import { Args, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';
import { type AuthUser, CurrentUser, RequirePermissions } from '@platform/auth';
import { type GqlContext, type GraphqlPubSub, InjectPubSub } from '@platform/graphql';
import { RateLimit } from '@platform/redis';
import { notificationFromCreatedPayload } from '../../application/mappers/notification.mapper.js';
import { NotificationsPort } from '../../application/ports/notifications.port.js';
import {
  type NotificationCreatedPush,
  notificationCreatedTrigger,
} from '../../notifications.constants.js';
import { NotificationsPermission } from '../../notifications.permissions.js';
import { toNotificationView } from '../notification-view.js';
import { NOTIFICATIONS_RATE_LIMITS } from '../rate-limit/notifications-rate-limit.js';
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
 * Subscribers only receive their own notifications in the tenant their token is for. The trigger
 * is already per (tenant, user) (`notificationCreatedTrigger`), so this filter is defence in depth:
 * a payload published on the wrong trigger, or without a tenant, still reaches nobody else.
 */
export function isOwnNotification(
  payload: NotificationCreatedPush,
  _variables: unknown,
  context: GqlContext,
): boolean {
  const user = context.req.user;
  if (user === undefined) return false;
  return (
    typeof payload.tenantId === 'string' &&
    payload.tenantId === user.tenantId &&
    payload.userId === user.id
  );
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
  @RequirePermissions(NotificationsPermission.Read)
  async notifications(
    @Args() args: ListNotificationsArgs,
    @CurrentUser() user: AuthUser,
  ): Promise<NotificationConnectionModel> {
    // The caller's own (tenant, user) inbox: both from the verified token.
    const page = await this.port.list({
      tenantId: user.tenantId,
      userId: user.id,
      limit: args.limit,
      pageState: args.pageState ?? undefined,
    });
    return toNotificationConnection(page);
  }

  @Mutation(() => Boolean, {
    name: 'markNotificationRead',
    description: 'Marks one of my notifications read (idempotent). NOT_FOUND outside my inbox.',
  })
  @RequirePermissions(NotificationsPermission.Read)
  @RateLimit(NOTIFICATIONS_RATE_LIMITS.MARK_READ)
  async markNotificationRead(
    @Args('input') input: MarkNotificationReadInput,
    @CurrentUser() user: AuthUser,
  ): Promise<boolean> {
    await this.port.markRead({
      tenantId: user.tenantId,
      userId: user.id,
      notificationId: input.id,
    });
    return true;
  }

  @Subscription(() => NotificationModel, {
    name: 'notificationCreated',
    description: 'Real-time feed of my new notifications.',
    filter: isOwnNotification,
    resolve: toCreatedNotificationModel,
  })
  @RequirePermissions(NotificationsPermission.Read)
  notificationCreated(
    @CurrentUser() user: AuthUser,
  ): AsyncIterableIterator<NotificationCreatedPush> {
    // Tenant and user both from the verified token, fixed for the life of the subscription.
    return this.pubSub.asyncIterableIterator<NotificationCreatedPush>(
      notificationCreatedTrigger(user.tenantId, user.id),
    );
  }
}
