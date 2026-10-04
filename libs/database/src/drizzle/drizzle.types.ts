import type { TransactionHost } from '@nestjs-cls/transactional';
import type { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';

/** A Drizzle schema module (`import * as schema from './x.schema.js'`): tables + relations. */
export type DrizzleSchema = Record<string, unknown>;

/**
 * The injected database handle. `$client` is the underlying postgres.js pool — use it for raw
 * tagged-template SQL, LISTEN/NOTIFY or COPY; never call `$client.end()` yourself (the module owns
 * the pool lifecycle).
 */
export type DrizzleDB<TSchema extends DrizzleSchema = DrizzleSchema> =
  PostgresJsDatabase<TSchema> & { $client: Sql };

/** What `db.transaction(async (tx) => …)` hands you. */
export type DrizzleTransaction<TSchema extends DrizzleSchema = DrizzleSchema> = Parameters<
  Parameters<DrizzleDB<TSchema>['transaction']>[0]
>[0];

/** Anything that can run queries — the db itself or a transaction. Accept this in helpers. */
export type DrizzleExecutor<TSchema extends DrizzleSchema = DrizzleSchema> =
  | DrizzleDB<TSchema>
  | DrizzleTransaction<TSchema>;

/** The `@nestjs-cls/transactional` adapter type bound to our Drizzle handle. */
export type DrizzleTransactionalAdapter<TSchema extends DrizzleSchema = DrizzleSchema> =
  TransactionalAdapterDrizzleOrm<DrizzleDB<TSchema>>;

/**
 * `TransactionHost` typed for Drizzle: `txHost.tx` is the active transaction inside
 * `@Transactional()` / `txHost.withTransaction()`, otherwise the plain db.
 *
 * DI gotcha: this is a type alias, so it carries no runtime metadata. Inject the class itself —
 * `constructor(private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<S>>)` with
 * `TransactionHost` imported as a VALUE — or use `@InjectTransactionHost()`.
 */
export type DrizzleTransactionHost<TSchema extends DrizzleSchema = DrizzleSchema> = TransactionHost<
  DrizzleTransactionalAdapter<TSchema>
>;
