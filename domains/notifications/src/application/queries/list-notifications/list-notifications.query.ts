import type { NotificationPage } from '@domain/notifications-contracts';
import { Query } from '@nestjs/cqrs';

/**
 * One page of the `(tenantId, userId)` inbox, newest first (Cassandra-native paging). The pair must
 * be the caller principal's own (`requireInboxActor`).
 */
export class ListNotificationsQuery extends Query<NotificationPage> {
  constructor(
    readonly tenantId: string,
    readonly userId: string,
    readonly limit: number,
    readonly pageState?: string,
  ) {
    super();
  }
}
