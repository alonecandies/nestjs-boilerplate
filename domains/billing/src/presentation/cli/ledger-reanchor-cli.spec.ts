import type { DynamicModule, INestApplicationContext } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { SystemContext } from '@platform/common';
import { DatabaseModule } from '@platform/database';
import { ImmudbModule } from '@platform/immudb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReanchorLedgerCommand } from '../../application/commands/reanchor-ledger/reanchor-ledger.command.js';
import { LedgerReanchorRefusedException } from '../../domain/ledger/ledger.errors.js';
import { ledgerConfig } from '../../infrastructure/ledger/ledger.config.js';
import { billingMigrations } from '../../infrastructure/persistence/billing.migrations.js';
import {
  createLedgerReanchorModule,
  LEDGER_REANCHOR_REASON,
  runLedgerReanchorCli,
} from './ledger-reanchor-cli.js';

const ARGS = [
  '--database',
  'ledger',
  '--lost-from',
  '2026-11-20T03:00:00Z',
  '--operator',
  'ops-oncall',
  '--reason',
  'immudb restored from the nightly backup',
];

/** What a `process.stdout.write` / `process.stderr.write` spy recorded. */
interface WriteSpy {
  mock: { calls: unknown[][] };
}
const written = (spy: WriteSpy): string => spy.mock.calls.map(([chunk]) => String(chunk)).join('');

describe('runLedgerReanchorCli (the dist/cli/ledger-reanchor.js body, audit fixes OPS-1)', () => {
  let stderr: WriteSpy;
  let stdout: WriteSpy;

  /** A Nest context whose CommandBus answers with `execute`, recording the commands and contexts. */
  const fakeContext = (execute: (command: unknown) => Promise<unknown>) => {
    const dispatched: { command: unknown; system: string | undefined }[] = [];
    const close = vi.fn(async () => undefined);
    const context = {
      get: (token: unknown) => {
        if (token !== CommandBus) throw new Error('only the CommandBus');
        return {
          execute: async (command: unknown) => {
            dispatched.push({ command, system: SystemContext.current()?.reason });
            return execute(command);
          },
        };
      },
      close,
    } as unknown as INestApplicationContext;
    const createContext = vi.fn(async () => context);
    return { createContext, dispatched, close };
  };

  beforeEach(() => {
    process.exitCode = undefined;
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubEnv('LOG_PRETTY', 'false');
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('without arguments prints its usage, exits 2, and reads no config and builds no context (the image load check)', async () => {
    const parse = vi.spyOn(ledgerConfig, 'parse');
    const { createContext } = fakeContext(async () => undefined);

    await runLedgerReanchorCli({ migrations: [billingMigrations], args: [], createContext });

    expect(process.exitCode).toBe(2);
    expect(written(stderr)).toMatch(
      /^usage: ledger-reanchor --database <db> --lost-from <ISO time> --operator <name> --reason <text>\n/,
    );
    expect(createContext).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(written(stdout)).toBe('');
  });

  it.each([
    ['a missing flag', ARGS.slice(0, 6)],
    ['an unknown flag', [...ARGS, '--force']],
    ['a positional argument', [...ARGS, 'extra']],
    [
      'a lost-from that is not an ISO time',
      ARGS.map((a) => (a.startsWith('2026') ? 'yesterday' : a)),
    ],
    ['a blank operator', ARGS.map((a) => (a === 'ops-oncall' ? '  ' : a))],
    ['a blank reason', ARGS.map((a) => (a.startsWith('immudb') ? '' : a))],
    ['a flag given twice', [...ARGS, '--database', 'other']],
  ])('%s: the usage, exit 2, no context', async (_, args) => {
    const { createContext } = fakeContext(async () => undefined);
    await runLedgerReanchorCli({ migrations: [billingMigrations], args, createContext });
    expect(process.exitCode).toBe(2);
    expect(written(stderr)).toContain('usage: ledger-reanchor');
    expect(createContext).not.toHaveBeenCalled();
  });

  it('dispatches one ReanchorLedgerCommand inside SystemContext, prints the result and closes the context', async () => {
    const { createContext, dispatched, close } = fakeContext(async () => ({
      reanchorId: 'r-1',
      database: 'ledger',
      replacedTxId: 12n,
      txId: 9n,
      reconciliation: { found: { verification_failed: 1 }, appended: { verification_failed: 1 } },
    }));

    await runLedgerReanchorCli({ migrations: [billingMigrations], args: ARGS, createContext });

    expect(process.exitCode).toBe(0);
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual([
      {
        command: expect.any(ReanchorLedgerCommand),
        system: LEDGER_REANCHOR_REASON,
      },
    ]);
    const [{ command } = expect.fail('nothing dispatched')] = dispatched;
    expect((command as ReanchorLedgerCommand).request).toEqual({
      database: 'ledger',
      lostFrom: new Date('2026-11-20T03:00:00Z'),
      operator: 'ops-oncall',
      reason: 'immudb restored from the nightly backup',
    });
    expect(close).toHaveBeenCalledTimes(1);
    const output = written(stdout);
    expect(output).toContain('"replacedTxId":"12"');
    expect(output).toContain('"txId":"9"');
    expect(output).toContain('verification_failed');
  });

  it('a refusal: exit 1, its reason logged, the context closed', async () => {
    const { createContext, close } = fakeContext(async () => {
      throw new LedgerReanchorRefusedException('nothing-lost', 'nothing was lost');
    });

    await runLedgerReanchorCli({ migrations: [billingMigrations], args: ARGS, createContext });

    expect(process.exitCode).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(`${written(stdout)}${written(stderr)}`).toContain('nothing was lost');
  });

  it('a context that cannot start: exit 1, nothing dispatched', async () => {
    const createContext = vi.fn(async (): Promise<INestApplicationContext> => {
      throw new Error('database unreachable');
    });

    await runLedgerReanchorCli({ migrations: [billingMigrations], args: ARGS, createContext });

    expect(process.exitCode).toBe(1);
    expect(`${written(stdout)}${written(stderr)}`).toContain('database unreachable');
  });

  it('its root module runs no migrations, whatever the env says, and imports immudb only with the ledger on', () => {
    /** The options each dynamic module of the root was given, by its module class. */
    const options = (ledgerEnabled: boolean): Map<unknown, Record<string, unknown>> => {
      const root = createLedgerReanchorModule([billingMigrations], ledgerEnabled);
      const imports = Reflect.getMetadata('imports', root) as DynamicModule[];
      return new Map(
        imports.map((imported) => {
          const value = (imported.providers ?? []).find(
            (provider) =>
              typeof provider === 'object' &&
              'useValue' in provider &&
              'migrations' in provider.useValue,
          );
          return [
            imported.module,
            (value as { useValue?: Record<string, unknown> })?.useValue ?? {},
          ];
        }),
      );
    };
    const on = options(true);
    expect(on.get(ImmudbModule)).toMatchObject({ runMigrations: false });
    expect(on.get(DatabaseModule)).toMatchObject({ runMigrations: false });
    expect(options(false).has(ImmudbModule)).toBe(false);
  });
});
