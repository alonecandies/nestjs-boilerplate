import { Query } from '@nestjs/cqrs';
import type { NotificationPage } from '@platform/contracts';

/** One page of a user's inbox, newest first (Cassandra-native paging). */
export class ListNotificationsQuery extends Query<NotificationPage> {
  constructor(
    readonly userId: string,
    readonly limit: number,
    readonly pageState?: string,
  ) {
    super();
  }
}
