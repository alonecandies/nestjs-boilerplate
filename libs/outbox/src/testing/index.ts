/**
 * @platform/outbox/testing — test doubles and shared specs for code that uses @platform/outbox.
 * Not imported by production code (a separate subpath, so it never lands in a service's graph).
 */
export * from './describe-outbox-table.js';
export * from './in-memory-outbox.js';
