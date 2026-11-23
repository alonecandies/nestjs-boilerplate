import type { DynamicModule, INestApplicationContext } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { SystemContext } from '@platform/common';
import { DatabaseModule } from '@platform/database';
import { ImmudbModule } from '@platform/immudb';
import { DistributedLockService, type LockResult, RedisModule } from '@platform/redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ReanchorLedgerCommand,
  RerunLedgerReconciliationCommand,
} from '../../application/commands/reanchor-ledger/reanchor-ledger.command.js';
import { RECONCILE_LEDGER_LOCK, RECONCILE_LEDGER_LOCK_TTL_MS } from '../../billing.constants.js';
import { LedgerReanchorRefusedException } from '../../domain/ledger/ledger.errors.js';
import { ledgerConfig } from '../../infrastructure/ledger/ledger.config.js';
import { billingMigrations } from '../../infrastructure/persistence/billing.migrations.js';
import {
  createLedgerReanchorModule,
  LEDGER_REANCHOR_LOCK_WAIT_MS,
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

  /**
   * A Nest context whose CommandBus answers with `execute`, recording the commands and contexts,
   * and whose lock service answers each attempt with the next of `lock` (then: acquired).
   */
  const fakeContext = (
    execute: (command: unknown) => Promise<unknown>,
    lock: ('held' | 'error')[] = [],
  ) => {
    const dispatched: { command: unknown; system: string | undefined; locked: boolean }[] = [];
    const close = vi.fn(async () => undefined);
    let locked = false;
    const using = vi.fn(
      async <T>(
        _resource: string,
        _ttlMs: number,
        fn: (signal: AbortSignal) => Promise<T>,
      ): Promise<LockResult<T>> => {
        const busy = lock.shift();
        if (busy !== undefined) return { acquired: false, reason: busy };
        locked = true;
        try {
          return { acquired: true, result: await fn(new AbortController().signal) };
        } finally {
          locked = false;
        }
      },
    );
    const context = {
      get: (token: unknown) => {
        if (token === DistributedLockService) return { using };
        if (token !== CommandBus) throw new Error('only the CommandBus and the lock service');
        return {
          execute: async (command: unknown) => {
            dispatched.push({ command, system: SystemContext.current()?.reason, locked });
            return execute(command);
          },
        };
      },
      close,
    } as unknown as INestApplicationContext;
    const createContext = vi.fn(async () => context);
    return { createContext, dispatched, close, using };
  };
  /** A re-anchor result whose follow-up run finished `status`, `failedChecks` failing. */
  const reanchored = (status = 'succeeded', failedChecks: string[] = []) => ({
    reanchorId: 'r-1',
    database: 'ledger',
    replacedTxId: 12n,
    txId: 9n,
    reconciliation: {
      runId: 'run-1',
      status,
      failedChecks,
      found: { verification_failed: 1 },
      appended: { verification_failed: 1 },
    },
  });

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
    ['--reconcile-only given twice', [...ARGS, '--reconcile-only', '--reconcile-only']],
    ['--reconcile-only with a value', [...ARGS, '--reconcile-only=yes']],
    ['--reconcile-only without --reason', ['--reconcile-only', ...ARGS.slice(0, 6)]],
  ])('%s: the usage, exit 2, no context', async (_, args) => {
    const { createContext } = fakeContext(async () => undefined);
    await runLedgerReanchorCli({ migrations: [billingMigrations], args, createContext });
    expect(process.exitCode).toBe(2);
    expect(written(stderr)).toContain('usage: ledger-reanchor');
    expect(createContext).not.toHaveBeenCalled();
  });

  it('dispatches one ReanchorLedgerCommand inside SystemContext and the reconcile lock, prints the result and closes the context', async () => {
    const { createContext, dispatched, close, using } = fakeContext(async () => reanchored());

    await runLedgerReanchorCli({ migrations: [billingMigrations], args: ARGS, createContext });

    expect(process.exitCode).toBe(0);
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(using).toHaveBeenCalledTimes(1);
    expect(using.mock.calls[0]?.slice(0, 2)).toEqual([
      RECONCILE_LEDGER_LOCK,
      RECONCILE_LEDGER_LOCK_TTL_MS,
    ]);
    expect(dispatched).toEqual([
      {
        command: expect.any(ReanchorLedgerCommand),
        system: LEDGER_REANCHOR_REASON,
        locked: true,
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
    expect(output).toContain('"status":"succeeded"');
  });

  it('a failed reconciliation run: exit 3, the result printed, the failed checks logged (review #2)', async () => {
    const { createContext, close } = fakeContext(async () => reanchored('failed', ['R4', 'R5']));

    await runLedgerReanchorCli({ migrations: [billingMigrations], args: ARGS, createContext });

    expect(process.exitCode).toBe(3);
    expect(close).toHaveBeenCalledTimes(1);
    expect(written(stdout)).toContain('"reanchorId":"r-1"');
    expect(written(stdout)).toContain('"status":"failed"');
    expect(`${written(stdout)}${written(stderr)}`).toMatch(/run-1 failed \(checks: R4, R5\)/);
    expect(`${written(stdout)}${written(stderr)}`).toContain('--reconcile-only');
  });

  it('--reconcile-only dispatches RerunLedgerReconciliationCommand under the lock, never the re-anchor', async () => {
    const result = {
      database: 'ledger',
      reconciliation: { ...reanchored().reconciliation, found: {}, appended: {} },
    };
    const { createContext, dispatched } = fakeContext(async () => result);

    await runLedgerReanchorCli({
      migrations: [billingMigrations],
      args: ['--reconcile-only', ...ARGS],
      createContext,
    });

    expect(process.exitCode).toBe(0);
    expect(dispatched).toEqual([
      {
        command: expect.any(RerunLedgerReconciliationCommand),
        system: LEDGER_REANCHOR_REASON,
        locked: true,
      },
    ]);
    const [{ command } = expect.fail('nothing dispatched')] = dispatched;
    expect((command as RerunLedgerReconciliationCommand).request).toEqual({
      database: 'ledger',
      lostFrom: new Date('2026-11-20T03:00:00Z'),
      operator: 'ops-oncall',
      reason: 'immudb restored from the nightly backup',
    });
    expect(JSON.parse(written(stdout))).toEqual({
      database: 'ledger',
      reconciliation: result.reconciliation,
    });
  });

  it('--reconcile-only whose run fails: exit 3', async () => {
    const { createContext } = fakeContext(async () => ({
      database: 'ledger',
      reconciliation: reanchored('failed', ['R4']).reconciliation,
    }));
    await runLedgerReanchorCli({
      migrations: [billingMigrations],
      args: [...ARGS, '--reconcile-only'],
      createContext,
    });
    expect(process.exitCode).toBe(3);
  });

  describe('the reconcile lock (review #5)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('held for the whole wait: waits the bounded time, then exits 4 (retry), dispatching nothing', async () => {
      const busy = Array.from({ length: 10_000 }, () => 'held' as const);
      const { createContext, dispatched, close, using } = fakeContext(
        async () => reanchored(),
        busy,
      );

      const run = runLedgerReanchorCli({
        migrations: [billingMigrations],
        args: ARGS,
        createContext,
      });
      const started = Date.now();
      await vi.advanceTimersByTimeAsync(LEDGER_REANCHOR_LOCK_WAIT_MS - 1);
      expect(process.exitCode).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await run;

      expect(Date.now() - started).toBe(LEDGER_REANCHOR_LOCK_WAIT_MS);
      expect(process.exitCode).toBe(4);
      expect(using.mock.calls.length).toBeGreaterThan(2);
      expect(dispatched).toEqual([]);
      expect(close).toHaveBeenCalledTimes(1);
      expect(`${written(stdout)}${written(stderr)}`).toContain('run it again');
    });

    it('held for a while: waits, then runs under the lock', async () => {
      const { createContext, dispatched, using } = fakeContext(
        async () => reanchored(),
        ['held', 'held'],
      );

      const run = runLedgerReanchorCli({
        migrations: [billingMigrations],
        args: ARGS,
        createContext,
      });
      await vi.advanceTimersByTimeAsync(LEDGER_REANCHOR_LOCK_WAIT_MS);
      await run;

      expect(process.exitCode).toBe(0);
      expect(using).toHaveBeenCalledTimes(3);
      expect(dispatched).toHaveLength(1);
    });

    it('Redis unreachable: exit 1 at once, dispatching nothing', async () => {
      const { createContext, dispatched, using } = fakeContext(async () => reanchored(), ['error']);

      await runLedgerReanchorCli({ migrations: [billingMigrations], args: ARGS, createContext });

      expect(process.exitCode).toBe(1);
      expect(using).toHaveBeenCalledTimes(1);
      expect(dispatched).toEqual([]);
    });
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
    expect(on.has(RedisModule)).toBe(true);
    expect(options(false).has(ImmudbModule)).toBe(false);
  });
});
