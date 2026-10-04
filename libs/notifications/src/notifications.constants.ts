/**
 * Names shared by the notifications edges (WebSocket, GraphQL) and the core. Everything here is a
 * wire contract with clients, so renaming a value is a breaking change.
 */

/** socket.io namespace of `NotificationsGateway` (`io('<host>/notifications', { auth: { token } })`). */
export const NOTIFICATIONS_WS_NAMESPACE = '/notifications';

/** socket.io event names (server → client and client → server). */
export const NOTIFICATIONS_WS_EVENTS = {
  /** server → client: a new notification for the connected user (payload = REST `Notification`). */
  CREATED: 'notification.created',
  /** client → server, with ack: `{ id }` → `{ ok: true }`. */
  MARK_READ: 'notifications.markRead',
  /** client → server: liveness check, answered with a `pong` event. */
  PING: 'ping',
  PONG: 'pong',
  /** server → client: problem details of a failed handshake/message (see AllExceptionsFilter). */
  EXCEPTION: 'exception',
} as const;

/** Every socket joins its user's room, so a push reaches all of that user's tabs/devices. */
export const userRoom = (userId: string): string => `user:${userId}`;

/** GraphQL PubSub trigger of the `notificationCreated` subscription. */
export const NOTIFICATION_CREATED_TRIGGER = 'notificationCreated';

/** Inbox page size (REST `limit`, GraphQL `limit`, gRPC `limit`; 0 over gRPC = default). */
export const DEFAULT_NOTIFICATIONS_PAGE_SIZE = 20;
export const MAX_NOTIFICATIONS_PAGE_SIZE = 100;

/**
 * Cassandra paging states are hex blobs; `@app/cassandra` rejects anything longer than 2 KiB
 * (MAX_PAGE_STATE_LENGTH there). Validating the shape at the edge turns garbage into a 400
 * before it costs a round trip.
 */
export const PAGE_STATE_MAX_LENGTH = 2_048;
export const PAGE_STATE_PATTERN = /^(?:[0-9a-f]{2})+$/i;

/** Daily digest (09:00 UTC on every replica; only the lock winner runs it). */
export const DAILY_DIGEST_CRON = '0 9 * * *';
export const DAILY_DIGEST_JOB_NAME = 'notifications.daily-digest';
export const DAILY_DIGEST_LOCK = 'notifications:daily-digest';
export const DAILY_DIGEST_LOCK_TTL_MS = 5 * 60_000;
/** Upper bound of recipients one run looks at (the demo is deliberately bounded). */
export const DIGEST_MAX_RECIPIENTS = 1_000;
/** Recipients fetched per page of the recipients scan. */
export const DIGEST_RECIPIENTS_PAGE_SIZE = 200;
/** Newest notifications inspected per recipient to find unread ones. */
export const DIGEST_SCAN_PER_USER = 50;
/** Unread items listed in one digest mail. */
export const DIGEST_ITEMS_PER_MAIL = 10;
/** Parallel per-recipient partition reads (one Cassandra partition per user). */
export const DIGEST_CONCURRENCY = 16;
