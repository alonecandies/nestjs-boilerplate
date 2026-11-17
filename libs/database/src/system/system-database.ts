import { Inject, Logger } from '@nestjs/common';
import { SystemContext } from '@platform/common';
import { getOrCreateCounter } from '@platform/observability';
import type { DrizzleDB, DrizzleSchema } from '../drizzle/drizzle.types.js';
import { isDefinedSystemMethod, type SystemMethod } from './system-method.js';

/**
 * Injection token of the `SystemDatabase` (spec §9 option (b)). Only `*.system-repository.ts` files
 * may name it, `SystemDatabase` or `InjectSystemDatabase` (scripts/check-boundaries.mjs).
 */
export const SYSTEM_DATABASE: unique symbol = Symbol('SYSTEM_DATABASE');

/** `constructor(@InjectSystemDatabase() private readonly system: SystemDatabase<typeof schema>)` */
export const InjectSystemDatabase = (): ParameterDecorator => Inject(SYSTEM_DATABASE);

/**
 * Package-internal token of the raw `app_system` Drizzle handle (`null` without
 * DATABASE_SYSTEM_URL). Never exported from the package or the module: `SystemDatabase.run` is
 * the only door to it.
 */
export const SYSTEM_POOL = Symbol('SYSTEM_POOL');

export const DB_SYSTEM_CALLS_TOTAL = 'db_system_calls_total';

export type SystemDatabaseErrorCode = 'SYSTEM_DATABASE_UNAVAILABLE' | 'SYSTEM_CONTEXT_REQUIRED';

export class SystemDatabaseError extends Error {
  override readonly name = 'SystemDatabaseError';

  constructor(
    readonly code: SystemDatabaseErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type Outcome = 'ok' | 'error';

/**
 * The only door to the `app_system` (BYPASSRLS) pool on DATABASE_SYSTEM_URL. Each call names a
 * `SystemMethod` (`defineSystemMethod`); a `system`-scope method runs only inside
 * `SystemContext`. Every call, a refused one too, is logged once as
 * `{ systemMethod, scope, reason, outcome }` and counted in `db_system_calls_total{method,outcome}`.
 * `work` gets the system handle, never the runtime pool or its open transaction: a write there
 * commits on its own.
 */
export class SystemDatabase<TSchema extends DrizzleSchema = DrizzleSchema> {
  readonly #db: DrizzleDB<TSchema> | null;
  readonly #logger = new Logger('SystemDatabase');
  readonly #calls = getOrCreateCounter({
    name: DB_SYSTEM_CALLS_TOTAL,
    help: 'Calls to the app_system pool through SystemDatabase.run, by system method and outcome',
    labelNames: ['method', 'outcome'] as const,
  });

  /** Built by `DatabaseModule` only; `db` is `null` when DATABASE_SYSTEM_URL is not set. */
  constructor(db: DrizzleDB<TSchema> | null) {
    this.#db = db;
  }

  /**
   * Runs `work` on the app_system pool (never joins a runtime transaction); logs and counts every
   * call.
   * @throws SystemDatabaseError SYSTEM_DATABASE_UNAVAILABLE (no DATABASE_SYSTEM_URL) |
   *   SYSTEM_CONTEXT_REQUIRED (a `system` method outside SystemContext); TypeError for a method
   *   not made by `defineSystemMethod`
   */
  async run<T>(method: SystemMethod, work: (db: DrizzleDB<TSchema>) => Promise<T>): Promise<T> {
    if (!isDefinedSystemMethod(method)) {
      throw new TypeError('SystemDatabase.run: the method must come from defineSystemMethod()');
    }
    const reason = SystemContext.current()?.reason;
    let outcome: Outcome = 'error';
    try {
      // Fail closed on scope: anything but 'pre-auth' needs a system context.
      if (method.scope !== 'pre-auth' && reason === undefined) {
        throw new SystemDatabaseError(
          'SYSTEM_CONTEXT_REQUIRED',
          `System method ${method.name} runs only inside SystemContext.run()`,
        );
      }
      const db = this.#db;
      if (db === null) {
        throw new SystemDatabaseError(
          'SYSTEM_DATABASE_UNAVAILABLE',
          `System method ${method.name}: no system pool (set DATABASE_SYSTEM_URL)`,
        );
      }
      const result = await work(db);
      outcome = 'ok';
      return result;
    } finally {
      this.#calls.inc({ method: method.name, outcome });
      const record = {
        systemMethod: method.name,
        scope: method.scope,
        ...(reason === undefined ? {} : { reason }),
        outcome,
      };
      if (outcome === 'ok') this.#logger.log(record, 'System database call');
      else this.#logger.warn(record, 'System database call');
    }
  }
}
