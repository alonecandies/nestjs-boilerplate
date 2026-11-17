import type { NotificationPage } from '@domain/notifications-contracts';
import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { clamp } from 'lodash-es';
import {
  DEFAULT_NOTIFICATIONS_PAGE_SIZE,
  MAX_NOTIFICATIONS_PAGE_SIZE,
} from '../../../notifications.constants.js';
import { requireInboxActor } from '../../inbox-actor.js';
import { toNotificationPage } from '../../mappers/notification.mapper.js';
import { NotificationsRepository } from '../../ports/notifications.repository.js';
import { ListNotificationsQuery } from './list-notifications.query.js';

@QueryHandler(ListNotificationsQuery)
export class ListNotificationsHandler implements IQueryHandler<ListNotificationsQuery> {
  constructor(private readonly notifications: NotificationsRepository) {}

  async execute({
    tenantId,
    userId,
    limit,
    pageState,
  }: ListNotificationsQuery): Promise<NotificationPage> {
    // The one inbox check for both topologies, before the repository is touched.
    requireInboxActor(tenantId, userId);
    // Edges validate, but the core never trusts them: 0/negative (proto default) → default page.
    const pageSize =
      limit > 0
        ? clamp(Math.trunc(limit), 1, MAX_NOTIFICATIONS_PAGE_SIZE)
        : DEFAULT_NOTIFICATIONS_PAGE_SIZE;
    const slice = await this.notifications.listByUser(
      tenantId,
      userId,
      pageSize,
      pageState || undefined,
    );
    return toNotificationPage(slice);
  }
}
