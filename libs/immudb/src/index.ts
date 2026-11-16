/**
 * @platform/immudb — immudb over gRPC (never pg-wire): the client generated from immudb's
 * schema.proto, a session pool with SQL transactions and error mapping, versioned SQL migrations
 * with provisioning, and client-side proof verification. Names no domain.
 */

/** The immudb server version the vendored proto, the error strings and the int specs are pinned to. */
export const IMMUDB_SERVER_VERSION = '1.11.2';
/** Image for integration specs and compose (`docker-compose.yml` pins the same tag). */
export const IMMUDB_TEST_IMAGE = `codenotary/immudb:${IMMUDB_SERVER_VERSION}`;

export * from './client/immudb.client.js';
export * from './errors/immudb.error.js';
export * from './health/immudb.health.js';
export * from './immudb.module.js';
export type * from './immudb.types.js';
