import { Inject } from '@nestjs/common';

/** Injection token of the connected, keyspace-bound `cassandra.Client` (`CassandraClient`). */
export const CASSANDRA_CLIENT = Symbol('CASSANDRA_CLIENT');

/** Injection token of the options passed to `CassandraModule.forRootAsync()`. */
export const CASSANDRA_MODULE_OPTIONS = Symbol('CASSANDRA_MODULE_OPTIONS');

/**
 * `constructor(@InjectCassandra() private readonly client: CassandraClient) {}` — import
 * `CassandraClient` with `import type` (it is an alias of the driver's CJS class).
 */
export const InjectCassandra = (): PropertyDecorator & ParameterDecorator =>
  Inject(CASSANDRA_CLIENT);

/** Page size used when a query does not set `fetchSize` (the driver's own default is 5000). */
export const DEFAULT_FETCH_SIZE = 100;
