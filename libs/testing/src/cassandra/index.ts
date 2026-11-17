/**
 * @platform/testing/cassandra: a single-node Cassandra per integration spec. A separate subpath so
 * that specs which only need `createMock` never load testcontainers or the driver. Test code only.
 */
export * from './start-test-cassandra.js';
