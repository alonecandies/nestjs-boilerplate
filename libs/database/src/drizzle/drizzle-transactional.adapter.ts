import {
  type DrizzleOrmTransactionalAdapterOptions,
  TransactionalAdapterDrizzleOrm,
} from '@nestjs-cls/transactional-adapter-drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { isEmpty, isNil, omitBy } from 'lodash-es';
import type { DrizzleDB } from './drizzle.types.js';

/**
 * `undefined` for a config without any effective setting. drizzle only skips `SET TRANSACTION`
 * when the config is falsy — `{}` renders a bare `set transaction` (a Postgres syntax error).
 */
export function normalizeTxConfig(
  config: PgTransactionConfig | undefined,
): PgTransactionConfig | undefined {
  if (isNil(config)) return undefined;
  const effective = omitBy(config, isNil) as PgTransactionConfig;
  return isEmpty(effective) ? undefined : effective;
}

/**
 * `TransactionalAdapterDrizzleOrm` for our Postgres handle, with one fix: `TransactionHost`
 * always merges `defaultTxOptions` with the per-call options, so a plain `@Transactional()`
 * hands drizzle `{}`, and drizzle then sends `set transaction ` with no modes — every
 * transaction fails on a real server (reproduced in the unit and integration tests). Empty
 * configs are dropped, so a default transaction is just BEGIN…COMMIT (no extra round trip).
 *
 * Bound to the schema-agnostic `DrizzleDB`: the runtime adapter is the same for every schema,
 * and consumers type `TransactionHost<DrizzleTransactionalAdapter<typeof schema>>` independently.
 */
export class DrizzlePostgresTransactionalAdapter extends TransactionalAdapterDrizzleOrm<DrizzleDB> {
  constructor(options: DrizzleOrmTransactionalAdapterOptions<DrizzleDB>) {
    super(options);
    const createOptions = this.optionsFactory;
    this.optionsFactory = (db) => {
      const base = createOptions(db);
      return {
        ...base,
        wrapWithTransaction: (config, fn, setClient) =>
          base.wrapWithTransaction(normalizeTxConfig(config), fn, setClient),
        wrapWithNestedTransaction: (config, fn, setClient, client) =>
          base.wrapWithNestedTransaction(normalizeTxConfig(config), fn, setClient, client),
      };
    };
  }
}
