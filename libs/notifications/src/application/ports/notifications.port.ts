import type {
  ListNotificationsRequest,
  MarkNotificationReadRequest,
  NotificationPage,
} from '@app/contracts';

/**
 * The seam between the edges (REST controller, GraphQL resolver, WebSocket gateway) and the
 * notifications core. Bound by `NotificationsApiModule.forLocal()` (CQRS buses, monolith) or
 * `.forRemote()` (gRPC client, gateway). Both adapters return the ts-proto contract shapes, so
 * presentation code cannot tell them apart.
 */
export abstract class NotificationsPort {
  /** Newest first. `pageState` is the opaque Cassandra paging state of the previous page. */
  abstract list(input: ListNotificationsRequest): Promise<NotificationPage>;

  /** Idempotent. Rejects with `NotificationNotFoundException` (404) outside the user's inbox. */
  abstract markRead(input: MarkNotificationReadRequest): Promise<void>;
}
