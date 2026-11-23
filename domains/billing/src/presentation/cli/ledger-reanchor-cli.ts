import { parseArgs } from 'node:util';
import {
  ConsoleLogger,
  type DynamicModule,
  type INestApplicationContext,
  Module,
  type Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { SystemContext } from '@platform/common';
import { AppConfigModule, observabilityConfig } from '@platform/config';
import { type DatabaseMigrationSet, DatabaseModule } from '@platform/database';
import { ImmudbModule } from '@platform/immudb';
import { DistributedLockService, type LockResult, RedisModule } from '@platform/redis';
import { KafkaProducerModule } from '@platform/transport';
import { ClsModule } from 'nestjs-cls';
import {
  type LedgerReanchorRequest,
  type LedgerReanchorResult,
  type LedgerReconcileOnlyResult,
  ReanchorLedgerCommand,
  RerunLedgerReconciliationCommand,
} from '../../application/commands/reanchor-ledger/reanchor-ledger.command.js';
import { RECONCILE_LEDGER_LOCK, RECONCILE_LEDGER_LOCK_TTL_MS } from '../../billing.constants.js';
import { billingLedgerMigrations } from '../../infrastructure/ledger/billing-ledger.migrations.js';
import { BillingLedgerReanchorModule } from '../../infrastructure/ledger/billing-ledger-reanchor.module.js';
import { ledgerConfig } from '../../infrastructure/ledger/ledger.config.js';
import { billingSchema } from '../../infrastructure/persistence/billing.schema.js';

/** The `SystemContext` reason the re-anchor runs under (logs, `db_system_calls_total`). */
export const LEDGER_REANCHOR_REASON = 'billing.ledger-reanchor';

/** The CLI's exit codes (documented in its usage and in docs/OPERATIONS.md, immudb step 5). */
export const LEDGER_REANCHOR_EXIT = {
  /** Done, and the reconciliation run succeeded. */
  ok: 0,
  /** Refused (nothing written) or failed (logged). */
  error: 1,
  /** Bad arguments: the usage is printed, nothing is read or opened. */
  usage: 2,
  /** The reconciliation run finished `failed` (a re-anchor itself committed): re-run it. */
  reconciliationFailed: 3,
  /** The reconcile lock stayed busy for the whole wait: nothing was written, run it again. */
  lockBusy: 4,
} as const;

/** How long the CLI waits for the reconcile lock (held by the hourly run) before giving up. */
export const LEDGER_REANCHOR_LOCK_WAIT_MS = 10 * 60_000;
/** How often it tries the lock again while waiting. */
export const LEDGER_REANCHOR_LOCK_POLL_MS = 5_000;

const USAGE =
  'usage: ledger-reanchor --database <db> --lost-from <ISO time> --operator <name> --reason <text>\n' +
  '       ledger-reanchor --reconcile-only --database <db> --lost-from <ISO time> --operator <name>\n' +
  '                       --reason <text>\n' +
  '  Re-anchors billing.ledger_trusted_state after an immudb restore, with an audit row\n' +
  '  (billing.ledger_reanchors), then runs one reconciliation over [lost-from, now).\n' +
  '  --reconcile-only: only runs that reconciliation again (no re-anchor, no audit row);\n' +
  '                    refused while the trusted state still needs a re-anchor\n' +
  '  --database <db>: the immudb database (IMMUDB_DATABASE of the apps)\n' +
  '  --lost-from <ISO time>: where the lost history starts (the restore point), e.g.\n' +
  '                          2026-11-20T03:00:00Z\n' +
  '  --operator <name>: who runs it (stored in the audit row)\n' +
  '  --reason <text>: why (stored in the audit row)\n' +
  '  Refused, writing nothing, with the ledger off, without a pinned signing key\n' +
  '  (LEDGER_ALLOW_UNVERIFIED does not help), when the state signature does not verify, and\n' +
  '  when the current state still extends the trusted one. Both modes take the hourly\n' +
  "  reconciliation's Redis lock first, waiting up to 10 minutes for it.\n" +
  '  Exit codes: 0 done; 1 refused or failed; 2 usage; 3 the reconciliation run failed\n' +
  '  (re-run it with --reconcile-only); 4 the lock stayed busy, nothing written (run it again).\n' +
  '  Runbook: docs/OPERATIONS.md (immudb).\n';

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** What the arguments ask for: a re-anchor, or only its reconciliation again. */
interface LedgerReanchorInvocation {
  readonly reconcileOnly: boolean;
  readonly request: LedgerReanchorRequest;
}

export interface LedgerReanchorCliOptions {
  /** The app's migration sets, as its `DatabaseModule` lists them (the CLI never runs them). */
  readonly migrations: readonly DatabaseMigrationSet[];
  /** Default `process.argv.slice(2)`. */
  readonly args?: readonly string[];
  /** Builds the Nest context from the CLI's root module (tests pass a fake). */
  readonly createContext?: (root: Type) => Promise<INestApplicationContext>;
}

/**
 * The body of the monolith's and billing-service's `src/cli/ledger-reanchor.ts` (audit fixes
 * OPS-1): `node dist/cli/ledger-reanchor.js --database <db> --lost-from <ISO time> --operator
 * <name> --reason <text>` in the app's image (docker compose `run`, a k8s Job), after an immudb
 * restore. It dispatches `ReanchorLedgerCommand` inside `SystemContext.run(LEDGER_REANCHOR_REASON)`
 * in a context of its own (`createLedgerReanchorModule`): the only place that registers the
 * command's handler.
 *
 * With `--reconcile-only` (audit batch 1 review #2) it dispatches `RerunLedgerReconciliationCommand`
 * instead: the same reconciliation over `[lost-from, now)` again, no re-anchor, no audit row.
 *
 * Both modes run under the hourly cron's `RECONCILE_LEDGER_LOCK` (review #5; Redis from the app's
 * env, `RedisModule` in the CLI's context), so the CLI's run never races the cron's R5
 * compare-and-set. The lock never waits on its own: the CLI tries it every
 * `LEDGER_REANCHOR_LOCK_POLL_MS` for up to `LEDGER_REANCHOR_LOCK_WAIT_MS`, then gives up having
 * written nothing.
 *
 * Without the four flags (each once, non-blank, `--lost-from` an ISO time with a zone; plus
 * `--reconcile-only` at most once), or with anything else, it prints the usage and exits 2 BEFORE
 * reading any config or building anything (no Redis either): run without arguments it only prints
 * its usage, which is what the image build's load check relies on. Sets `process.exitCode`
 * (`LEDGER_REANCHOR_EXIT`) instead of exiting: 0 = done and the run succeeded, the result printed
 * as one JSON line on stdout; 1 = refused or failed, logged; 3 = the reconciliation run finished
 * `failed`, the result printed and its failed checks logged (a re-anchor itself committed); 4 =
 * the lock stayed busy, nothing written. The caller imports `reflect-metadata` first, as the other
 * entrypoints do.
 */
export async function runLedgerReanchorCli(options: LedgerReanchorCliOptions): Promise<void> {
  const invocation = parseInvocation(options.args ?? process.argv.slice(2));
  if (invocation === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = LEDGER_REANCHOR_EXIT.usage;
    return;
  }

  let logger = createLogger(false);
  let context: INestApplicationContext | undefined;
  try {
    if (observabilityConfig.parse().logPretty) logger = createLogger(true);
    const root = createLedgerReanchorModule(options.migrations, ledgerConfig.parse().enabled);
    context = await (options.createContext ?? createContext(logger))(root);
    const commands = context.get(CommandBus);
    const { request, reconcileOnly } = invocation;
    const locked = await underReconcileLock(context.get(DistributedLockService), logger, () =>
      SystemContext.run(LEDGER_REANCHOR_REASON, () =>
        reconcileOnly
          ? commands.execute(new RerunLedgerReconciliationCommand(request))
          : commands.execute(new ReanchorLedgerCommand(request)),
      ),
    );
    if (!locked.acquired) {
      process.exitCode = lockNotAcquired(logger, locked.reason);
      return;
    }
    const result = locked.result;
    process.stdout.write(`${JSON.stringify(printable(result))}\n`);
    const { runId, status, failedChecks } = result.reconciliation;
    if (status === 'failed') {
      logger.error(
        `the reconciliation run ${runId} failed (checks: ${failedChecks.join(', ')})` +
          (reconcileOnly ? '' : '; the re-anchor itself committed') +
          ': fix the cause, then run it again with --reconcile-only',
      );
      process.exitCode = LEDGER_REANCHOR_EXIT.reconciliationFailed;
      return;
    }
    process.exitCode = LEDGER_REANCHOR_EXIT.ok;
  } catch (error) {
    // The Error itself: ConsoleLogger in JSON mode serialises it with its message and stack.
    logger.error(error instanceof Error ? error : String(error));
    process.exitCode = LEDGER_REANCHOR_EXIT.error;
  } finally {
    await context?.close();
  }
}

/**
 * Runs `work` holding `RECONCILE_LEDGER_LOCK` (auto-extended while it runs). A lock held
 * elsewhere is tried again every `LEDGER_REANCHOR_LOCK_POLL_MS` until `LEDGER_REANCHOR_LOCK_WAIT_MS`
 * has passed; Redis being unreachable is not waited on.
 */
async function underReconcileLock<T>(
  lock: Pick<DistributedLockService, 'using'>,
  logger: ConsoleLogger,
  work: () => Promise<T>,
): Promise<LockResult<T>> {
  const deadline = Date.now() + LEDGER_REANCHOR_LOCK_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    const outcome = await lock.using(RECONCILE_LEDGER_LOCK, RECONCILE_LEDGER_LOCK_TTL_MS, work);
    const left = deadline - Date.now();
    if (outcome.acquired || outcome.reason !== 'held' || left <= 0) return outcome;
    if (attempt === 0) {
      logger.log(
        'the reconcile lock is held (the hourly reconciliation is running): waiting up to ' +
          `${LEDGER_REANCHOR_LOCK_WAIT_MS / 60_000} minutes for it`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(LEDGER_REANCHOR_LOCK_POLL_MS, left)),
    );
  }
}

/** Logs why the lock was not taken; the exit code for it. */
function lockNotAcquired(logger: ConsoleLogger, reason: 'held' | 'error'): number {
  if (reason === 'held') {
    logger.error(
      `the reconcile lock (${RECONCILE_LEDGER_LOCK}) stayed held for ` +
        `${LEDGER_REANCHOR_LOCK_WAIT_MS / 60_000} minutes: nothing was written, run it again`,
    );
    return LEDGER_REANCHOR_EXIT.lockBusy;
  }
  logger.error(
    `the reconcile lock (${RECONCILE_LEDGER_LOCK}) could not be taken: Redis is unreachable ` +
      '(REDIS_URL); nothing was written',
  );
  return LEDGER_REANCHOR_EXIT.error;
}

/** The result as one JSON line (tx ids as strings). */
function printable(result: LedgerReanchorResult | LedgerReconcileOnlyResult): object {
  if (!('reanchorId' in result)) return result;
  return {
    reanchorId: result.reanchorId,
    database: result.database,
    replacedTxId: result.replacedTxId.toString(),
    txId: result.txId.toString(),
    reconciliation: result.reconciliation,
  };
}

/**
 * The CLI's root module: config, CLS, CQRS, the database pools and immudb while the ledger is on
 * (the handler refuses when it is off), neither running migrations whatever
 * `DATABASE_RUN_MIGRATIONS` / `IMMUDB_RUN_MIGRATIONS` say (a refusal writes nothing), Redis (the
 * reconcile lock), a Kafka producer that never connects (R4 only builds outbox records) and
 * `BillingLedgerReanchorModule`. No scheduler, no outbox relay, no consumer, no HTTP or gRPC
 * server.
 */
export function createLedgerReanchorModule(
  migrations: readonly DatabaseMigrationSet[],
  ledgerEnabled: boolean,
): Type {
  const ledger: (Type | DynamicModule)[] = ledgerEnabled
    ? [ImmudbModule.forRootAsync({ migrations: [billingLedgerMigrations], runMigrations: false })]
    : [];

  @Module({
    imports: [
      AppConfigModule.forRoot(),
      ClsModule.forRoot({ global: true }),
      CqrsModule.forRoot(),
      DatabaseModule.forRootAsync({ schema: billingSchema, migrations, runMigrations: false }),
      RedisModule.forRootAsync(),
      KafkaProducerModule.forRootAsync({ eagerConnect: false }),
      ...ledger,
      BillingLedgerReanchorModule,
    ],
  })
  class LedgerReanchorCliModule {}
  return LedgerReanchorCliModule;
}

function createContext(logger: ConsoleLogger): (root: Type) => Promise<INestApplicationContext> {
  return (root) => NestFactory.createApplicationContext(root, { logger, abortOnError: false });
}

/**
 * What the arguments ask for, or undefined when they are not exactly the four valid flags (plus
 * `--reconcile-only` at most once).
 */
function parseInvocation(args: readonly string[]): LedgerReanchorInvocation | undefined {
  try {
    const { values, positionals, tokens } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: {
        database: { type: 'string' },
        'lost-from': { type: 'string' },
        operator: { type: 'string' },
        reason: { type: 'string' },
        'reconcile-only': { type: 'boolean' },
      },
    });
    const names = tokens.filter((token) => token.kind === 'option').map((token) => token.name);
    if (positionals.length > 0 || new Set(names).size !== names.length) return undefined;
    const { database, operator, reason } = values;
    const lostFrom = values['lost-from'];
    if (database === undefined || operator === undefined || reason === undefined) return undefined;
    if (lostFrom === undefined || !ISO_TIME.test(lostFrom)) return undefined;
    const at = new Date(lostFrom);
    if (Number.isNaN(at.getTime())) return undefined;
    if ([database, operator, reason].some((value) => value.trim() === '')) return undefined;
    return {
      reconcileOnly: values['reconcile-only'] === true,
      request: { database, lostFrom: at, operator: operator.trim(), reason: reason.trim() },
    };
  } catch {
    // An unknown flag or a missing option value: the usage says what is accepted.
    return undefined;
  }
}

function createLogger(pretty: boolean): ConsoleLogger {
  return new ConsoleLogger(
    'LedgerReanchor',
    pretty ? { colors: true } : { json: true, colors: false },
  );
}
