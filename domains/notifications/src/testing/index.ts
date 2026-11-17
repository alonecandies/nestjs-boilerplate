/**
 * @domain/notifications/testing — test doubles for code that depends on the notifications context.
 * Not imported by production code (a separate subpath, so it never lands in a service's module graph).
 */
export * from './fake-notifications-port.js';
export * from './in-memory-notification-recipients.repository.js';
export * from './in-memory-notifications.repository.js';
