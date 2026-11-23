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
import { KafkaProducerModule } from '@platform/transport';
import { ClsModule } from 'nestjs-cls';
import {
  type LedgerReanchorRequest,
  type LedgerReanchorResult,
  ReanchorLedgerCommand,
} from '../../application/commands/reanchor-ledger/reanchor-ledger.command.js';
import { billingLedgerMigrations } from '../../infrastructure/ledger/billing-ledger.migrations.js';
import { BillingLedgerReanchorModule } from '../../infrastructure/ledger/billing-ledger-reanchor.module.js';
import { ledgerConfig } from '../../infrastructure/ledger/ledger.config.js';
import { billingSchema } from '../../infrastructure/persistence/billing.schema.js';

/** The `SystemContext` reason the re-anchor runs under (logs, `db_system_calls_total`). */
export const LEDGER_REANCHOR_REASON = 'billing.ledger-reanchor';

const USAGE =
  'usage: ledger-reanchor --database <db> --lost-from <ISO time> --operator <name> --reason <text>\n' +
  '  Re-anchors billing.ledger_trusted_state after an immudb restore, with an audit row\n' +
  '  (billing.ledger_reanchors), then runs one reconciliation over [lost-from, now).\n' +
  '  --database <db>: the immudb database (IMMUDB_DATABASE of the apps)\n' +
  '  --lost-from <ISO time>: where the lost history starts (the restore point), e.g.\n' +
  '                          2026-11-20T03:00:00Z\n' +
  '  --operator <name>: who runs it (stored in the audit row)\n' +
  '  --reason <text>: why (stored in the audit row)\n' +
  '  Refused, writing nothing, with the ledger off, without a pinned signing key\n' +
  '  (LEDGER_ALLOW_UNVERIFIED does not help), when the state signature does not verify, and\n' +
  '  when the current state still extends the trusted one. Runbook: docs/OPERATIONS.md (immudb).\n';

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

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
 * Without the four flags (each once, non-blank, `--lost-from` an ISO time with a zone), or with
 * anything else, it prints the usage and exits 2 BEFORE reading any config or building anything:
 * run without arguments it only prints its usage, which is what the image build's load check
 * relies on. Sets `process.exitCode` (0 = re-anchored and reconciled, the result printed as one
 * JSON line on stdout; 1 = refused or failed, logged) instead of exiting. The caller imports
 * `reflect-metadata` first, as the other entrypoints do.
 */
export async function runLedgerReanchorCli(options: LedgerReanchorCliOptions): Promise<void> {
  const request = parseRequest(options.args ?? process.argv.slice(2));
  if (request === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  let logger = createLogger(false);
  let context: INestApplicationContext | undefined;
  try {
    if (observabilityConfig.parse().logPretty) logger = createLogger(true);
    const root = createLedgerReanchorModule(options.migrations, ledgerConfig.parse().enabled);
    context = await (options.createContext ?? createContext(logger))(root);
    const commands = context.get(CommandBus);
    const result: LedgerReanchorResult = await SystemContext.run(LEDGER_REANCHOR_REASON, () =>
      commands.execute(new ReanchorLedgerCommand(request)),
    );
    process.stdout.write(
      `${JSON.stringify({
        reanchorId: result.reanchorId,
        database: result.database,
        replacedTxId: result.replacedTxId.toString(),
        txId: result.txId.toString(),
        reconciliation: result.reconciliation,
      })}\n`,
    );
    process.exitCode = 0;
  } catch (error) {
    // The Error itself: ConsoleLogger in JSON mode serialises it with its message and stack.
    logger.error(error instanceof Error ? error : String(error));
    process.exitCode = 1;
  } finally {
    await context?.close();
  }
}

/**
 * The CLI's root module: config, CLS, CQRS, the database pools and immudb while the ledger is on
 * (the handler refuses when it is off), neither running migrations whatever
 * `DATABASE_RUN_MIGRATIONS` / `IMMUDB_RUN_MIGRATIONS` say (a refusal writes nothing), a Kafka producer that never connects (R4 only
 * builds outbox records) and `BillingLedgerReanchorModule`. No scheduler, no outbox relay, no
 * consumer, no HTTP or gRPC server.
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

/** The request, or undefined when the arguments are not exactly the four valid flags. */
function parseRequest(args: readonly string[]): LedgerReanchorRequest | undefined {
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
    return { database, lostFrom: at, operator: operator.trim(), reason: reason.trim() };
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
