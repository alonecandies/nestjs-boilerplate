import {
  type DrizzleOrmTransactionalAdapterOptions,
  TransactionalAdapterDrizzleOrm,
} from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { getPrincipal } from '@platform/common';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { isEmpty, isNil, omitBy } from 'lodash-es';
import {
  appliedRlsContextOf,
  assertRlsContextCurrent,
  buildRlsContextSql,
  RlsContextError,
  type RlsContextInput,
  recordAppliedRlsContext,
  rlsContextOf,
} from '../rls/rls-context.js';
import { transactionClientOf } from '../rls/transaction-client.js';
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

/** The CLS principal's context and its SQL; throws before any SQL is sent. */
function contextForBegin(): { context: RlsContextInput; sql: string } {
  const principal = getPrincipal();
  if (principal === undefined) {
    throw new RlsContextError(
      'RLS_NO_PRINCIPAL',
      'RLS context: no principal in CLS; a runtime unit of work always runs as a user ' +
        '(principal-less work goes through SystemDatabase)',
    );
  }
  const input = rlsContextOf(principal);
  const sql = buildRlsContextSql(input);
  return {
    sql,
    context: {
      userId: input.userId.toLowerCase(),
      tenantId: input.tenantId === null ? null : input.tenantId.toLowerCase(),
    },
  };
}

/**
 * `TransactionalAdapterDrizzleOrm` for our Postgres handle, with two changes.
 *
 * 1. **The RLS context (always on).** Every new transaction runs, right after BEGIN (and after
 *    drizzle's own `SET TRANSACTION`, when options are given), `SET LOCAL app.user_id = …;
 *    SET LOCAL app.tenant_id = …; SET LOCAL app.elevated = 'off'` from the CLS principal, in ONE
 *    simple-protocol round trip (`unsafe(sql).simple()`: several commands cannot be one prepared
 *    statement, and `preferPreparedStatements` would otherwise force `prepare: true`). `SET LOCAL`,
 *    not `set_config()`: Citus propagates only `SET LOCAL` to the worker connections
 *    (`citus.propagate_set_commands = 'local'` on the app roles). Without a principal (also inside
 *    a system context) it throws RLS_NO_PRINCIPAL before BEGIN. A savepoint sends nothing and
 *    requires the same principal; at COMMIT the CLS principal is compared with what was applied,
 *    and a different one rolls back with RLS_CONTEXT_STALE.
 * 2. **Empty configs.** `TransactionHost` always merges `defaultTxOptions` with the per-call
 *    options, so a plain `@Transactional()` hands drizzle `{}`, and drizzle then sends
 *    `set transaction ` with no modes — every transaction fails on a real server (reproduced in
 *    the unit and integration tests). Empty configs are dropped.
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
        // async: a refusal is a rejection (the host chains `.finally()` on the result).
        wrapWithTransaction: async (config, fn, setClient): Promise<unknown> => {
          const { context, sql } = contextForBegin();
          let tx: unknown;
          return base.wrapWithTransaction(
            normalizeTxConfig(config),
            async () => {
              await transactionClientOf(tx).unsafe(sql).simple();
              recordAppliedRlsContext(tx as object, context);
              const result: unknown = await fn();
              // Inside the transaction callback: a throw here rolls back instead of committing.
              assertRlsContextCurrent(context);
              return result;
            },
            (client) => {
              tx = client;
              setClient(client);
            },
          ) as Promise<unknown>;
        },
        wrapWithNestedTransaction: async (config, fn, setClient, client): Promise<unknown> => {
          const context = appliedRlsContextOf(client);
          assertRlsContextCurrent(context);
          return base.wrapWithNestedTransaction(
            normalizeTxConfig(config),
            fn,
            (savepoint) => {
              if (context !== undefined) recordAppliedRlsContext(savepoint as object, context);
              setClient(savepoint);
            },
            client,
          ) as Promise<unknown>;
        },
      };
    };
  }
}
