import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { CommandBus } from '@nestjs/cqrs';
import { SystemContext } from '@platform/common';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHARGE_DRAFT } from '../../../../test/ledger-fixtures.js';
import {
  LedgerReanchorRefusedException,
  LedgerSigningKeyNotPinnedException,
  LedgerVerificationFailedException,
} from '../../../domain/ledger/ledger.errors.js';
import type { LedgerEntryDraft, LedgerTrustedState } from '../../../domain/ledger/ledger.types.js';
import type { LedgerConfig } from '../../../infrastructure/ledger/ledger.config.js';
import { InMemoryLedger } from '../../../testing/in-memory-ledger.js';
import { InMemoryLedgerStore } from '../../../testing/in-memory-ledger-store.js';
import { ReconcileLedgerCommand } from '../reconcile-ledger/reconcile-ledger.command.js';
import {
  type LedgerReanchorRequest,
  ReanchorLedgerCommand,
  RerunLedgerReconciliationCommand,
} from './reanchor-ledger.command.js';
import {
  ReanchorLedgerHandler,
  RerunLedgerReconciliationHandler,
} from './reanchor-ledger.handler.js';

const DB = 'in-memory';
const NOW = new Date('2026-11-23T12:00:00.000Z');
const LOST_FROM = new Date('2026-11-23T03:00:00.000Z');
/** Where the follow-up run's window ends: the cron's 15-minute grace before now (review #3). */
const GRACE_END = new Date(NOW.getTime() - 15 * 60_000);
const REQUEST: LedgerReanchorRequest = {
  database: DB,
  lostFrom: LOST_FROM,
  operator: 'ops-oncall',
  reason: 'immudb restored from the nightly backup',
};
const ENABLED: LedgerConfig = {
  enabled: true,
  reconcileLookbackHours: 72,
  verify: true,
  allowUnverified: false,
};
const asSystem = <T>(fn: () => Promise<T>) => SystemContext.run('billing.ledger-reanchor', fn);
/** How the fake reconciliation run finishes (what it reports to `onFinished`). */
const SUCCEEDED = {
  runId: 'run-1',
  status: 'succeeded',
  failedChecks: [],
  found: {},
  appended: {},
};

const draft = (n: number): LedgerEntryDraft => ({
  ...CHARGE_DRAFT,
  sourceKey: `stripe:txn:txn_reanchor_${n}`,
});

/** What the reconcile handler does at the end of a run: reports it, resolves with its counts. */
const finishRun = (command: unknown, outcome: typeof SUCCEEDED | Record<string, unknown>) => {
  (command as ReconcileLedgerCommand).onFinished?.(outcome as never);
  return { found: outcome.found, appended: outcome.appended };
};

describe('ReanchorLedgerHandler (audit fixes OPS-1)', () => {
  let ledger: InMemoryLedger;
  let store: InMemoryLedgerStore;
  let commands: { execute: ReturnType<typeof vi.fn> };
  /** The stored trusted state: the original server at tx 3, before the restore. */
  let trusted: LedgerTrustedState;

  const handler = (config: LedgerConfig = ENABLED) =>
    new ReanchorLedgerHandler(config, ledger, store.system, commands as unknown as CommandBus);
  const reanchor = (request: LedgerReanchorRequest = REQUEST, config?: LedgerConfig) =>
    asSystem(() => handler(config).execute(new ReanchorLedgerCommand(request)));
  /** How a refused re-anchor fails: its refusal code. */
  const refusal = async (attempt: Promise<unknown>): Promise<string> => {
    const error = await attempt.then(
      () => expect.fail('the re-anchor went through'),
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(LedgerReanchorRefusedException);
    return (error as LedgerReanchorRefusedException).refusal;
  };
  /** Nothing written: the stored state is the original one, no audit row, no reconciliation. */
  const nothingWritten = () => {
    expect(store.trustedStates.get(DB)).toMatchObject({ txId: trusted.txId });
    expect([...(store.trustedStates.get(DB)?.txHash ?? [])]).toEqual([...trusted.txHash]);
    expect(store.reanchors).toEqual([]);
    expect(commands.execute).not.toHaveBeenCalled();
  };

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    store = new InMemoryLedgerStore();
    commands = { execute: vi.fn(async (command: unknown) => finishRun(command, SUCCEEDED)) };
    // The original server reached tx 3 and R5 stored that state.
    const original = new InMemoryLedger();
    for (const n of [1, 2, 3]) await original.post(draft(n));
    trusted = await original.currentState();
    await asSystem(() =>
      store.system.advanceTrustedState(DB, null, trusted, new Date(NOW.getTime() - 3_600_000)),
    );
    // The restored server holds the first entry only; the client pins its signing key.
    ledger = new InMemoryLedger();
    await ledger.post(draft(1));
    vi.spyOn(ledger, 'signedState').mockImplementation(() => ledger.currentState());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the audit row and the restored state together, lost-from as its read time, then reconciles [lost-from, now − 15 min)', async () => {
    const state = await ledger.currentState();

    const result = await reanchor();

    expect(result).toEqual({
      reanchorId: expect.any(String),
      database: DB,
      replacedTxId: 3n,
      txId: 1n,
      reconciliation: SUCCEEDED,
    });
    expect(store.reanchors).toEqual([
      {
        id: result.reanchorId,
        database: DB,
        from: { database: DB, txId: 3n, txHash: trusted.txHash },
        to: state,
        lostFrom: LOST_FROM,
        operator: 'ops-oncall',
        reason: 'immudb restored from the nightly backup',
        createdAt: NOW,
      },
    ]);
    expect(store.trustedStates.get(DB)).toEqual({
      database: DB,
      txId: 1n,
      txHash: state.txHash,
      verifiedAt: NOW,
      readAt: LOST_FROM,
    });
    expect(commands.execute).toHaveBeenCalledTimes(1);
    const [[command]] = commands.execute.mock.calls as [[ReconcileLedgerCommand]];
    expect(command).toBeInstanceOf(ReconcileLedgerCommand);
    expect(command.window).toEqual({ from: LOST_FROM, to: GRACE_END });
  });

  it('re-anchors a lost-from just before the grace: the window is that last millisecond', async () => {
    const lostFrom = new Date(GRACE_END.getTime() - 1);

    await reanchor({ ...REQUEST, lostFrom });

    expect(store.reanchors).toHaveLength(1);
    const [[command]] = commands.execute.mock.calls as [[ReconcileLedgerCommand]];
    expect(command.window).toEqual({ from: lostFrom, to: GRACE_END });
  });

  it.each([
    ['5 minutes ago', new Date(NOW.getTime() - 5 * 60_000)],
    ['15 minutes ago (the grace boundary)', GRACE_END],
  ])('a lost-from %s (in the grace): re-anchors, skips the empty run', async (_, lostFrom) => {
    const state = await ledger.currentState();

    const result = await reanchor({ ...REQUEST, lostFrom });

    expect(result).toEqual({
      reanchorId: expect.any(String),
      database: DB,
      replacedTxId: 3n,
      txId: 1n,
      reconciliation: { status: 'skipped', reason: 'lost-from-in-grace' },
    });
    expect(store.reanchors).toEqual([
      expect.objectContaining({ id: result.reanchorId, database: DB, to: state, lostFrom }),
    ]);
    expect(store.trustedStates.get(DB)).toEqual({
      database: DB,
      txId: 1n,
      txHash: state.txHash,
      verifiedAt: NOW,
      readAt: lostFrom,
    });
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it('carries a failed reconciliation run: its status and failed checks (review #2)', async () => {
    const failed = {
      runId: 'run-2',
      status: 'failed',
      failedChecks: ['R4', 'R5'],
      found: { verification_failed: 1 },
      appended: { verification_failed: 1 },
    };
    commands.execute.mockImplementation(async (command: unknown) => finishRun(command, failed));

    const result = await reanchor();

    expect(result.reconciliation).toEqual(failed);
    expect(store.reanchors).toHaveLength(1);
  });

  it('a reconciliation that reports no outcome is an error, after the re-anchor committed', async () => {
    commands.execute.mockImplementation(async () => ({ found: {}, appended: {} }));
    await expect(reanchor()).rejects.toThrow('reported no outcome');
    expect(store.reanchors).toHaveLength(1);
  });

  it('stores exactly the state whose signature it verified', async () => {
    const signed = await ledger.currentState();
    // A posting lands between the signature check and the extension check.
    vi.spyOn(ledger, 'signedState').mockImplementation(async () => {
      await ledger.post(draft(7));
      return signed;
    });

    await reanchor();

    expect(store.trustedStates.get(DB)).toMatchObject({ txId: signed.txId });
    expect(store.reanchors[0]?.to).toEqual(signed);
  });

  it('runs only inside SystemContext', async () => {
    await expect(handler().execute(new ReanchorLedgerCommand(REQUEST))).rejects.toMatchObject({
      code: 'SYSTEM_CONTEXT_REQUIRED',
    });
    nothingWritten();
  });

  describe('refuses in order, writing nothing', () => {
    it('ledger-disabled: LEDGER_ENABLED=false, before reading the ledger', async () => {
      const signedState = vi.spyOn(ledger, 'signedState');
      await expect(refusal(reanchor(REQUEST, { ...ENABLED, enabled: false }))).resolves.toBe(
        'ledger-disabled',
      );
      expect(signedState).not.toHaveBeenCalled();
      nothingWritten();
    });

    it.each([
      ['now', NOW],
      ['in the future', new Date(NOW.getTime() + 60_000)],
    ])('lost-from-not-past: a lost-from %s', async (_, lostFrom) => {
      await expect(refusal(reanchor({ ...REQUEST, lostFrom }))).resolves.toBe('lost-from-not-past');
      nothingWritten();
    });

    it('signing-key-not-pinned: the client pins no key, whatever LEDGER_ALLOW_UNVERIFIED says', async () => {
      // The guard itself is ImmudbLedgerAdapter.signedState (pinsSigningKey(), its own spec) and
      // test/ledger-reanchor.int-spec.ts; this case pins that the handler maps it and writes nothing.
      vi.spyOn(ledger, 'signedState').mockRejectedValue(new LedgerSigningKeyNotPinnedException());
      await expect(refusal(reanchor(REQUEST, { ...ENABLED, allowUnverified: true }))).resolves.toBe(
        'signing-key-not-pinned',
      );
      nothingWritten();
    });

    it('signing-key-not-pinned: the in-memory ledger signs nothing', async () => {
      vi.mocked(ledger.signedState).mockRestore();
      await expect(refusal(reanchor())).resolves.toBe('signing-key-not-pinned');
      nothingWritten();
    });

    it('signature-invalid: the state does not verify against the pinned key', async () => {
      vi.spyOn(ledger, 'signedState').mockRejectedValue(
        new LedgerVerificationFailedException('trusted-state', 'state signature does not verify'),
      );
      await expect(refusal(reanchor())).resolves.toBe('signature-invalid');
      nothingWritten();
    });

    it('other-database: --database is not the database the store names', async () => {
      await expect(refusal(reanchor({ ...REQUEST, database: 'ledger' }))).resolves.toBe(
        'other-database',
      );
      nothingWritten();
    });

    it('no-trusted-state: nothing stored to replace', async () => {
      store.trustedStates.clear();
      await expect(refusal(reanchor())).resolves.toBe('no-trusted-state');
      expect(store.trustedStates.size).toBe(0);
      expect(store.reanchors).toEqual([]);
      expect(commands.execute).not.toHaveBeenCalled();
    });

    it('nothing-lost: the current state still extends the trusted one (a healthy ledger)', async () => {
      // The original server itself, one posting further: it extends the stored state.
      const healthy = new InMemoryLedger();
      for (const n of [1, 2, 3, 4]) await healthy.post(draft(n));
      vi.spyOn(healthy, 'signedState').mockImplementation(() => healthy.currentState());
      ledger = healthy;
      await expect(refusal(reanchor())).resolves.toBe('nothing-lost');
      nothingWritten();
    });

    it('a transport error of the extension proof propagates (it is not "does not extend")', async () => {
      vi.spyOn(ledger, 'advanceTrustedState').mockRejectedValue(new Error('immudb unavailable'));
      await expect(reanchor()).rejects.toThrow('immudb unavailable');
      nothingWritten();
    });

    it('trusted-state-changed: the stored state moved before the compare-and-set', async () => {
      const read = store.system.readTrustedState.bind(store.system);
      vi.spyOn(store.system, 'readTrustedState').mockImplementation(async (database) => {
        const stored = await read(database);
        // Another writer replaces the row right after this read.
        store.trustedStates.set(DB, {
          ...(stored ?? expect.fail('no state')),
          txHash: new Uint8Array(32).fill(7),
        });
        return stored;
      });
      await expect(refusal(reanchor())).resolves.toBe('trusted-state-changed');
      expect(store.reanchors).toEqual([]);
      expect(commands.execute).not.toHaveBeenCalled();
    });
  });
});

describe('RerunLedgerReconciliationHandler (--reconcile-only, review #2)', () => {
  let ledger: InMemoryLedger;
  let store: InMemoryLedgerStore;
  let commands: { execute: ReturnType<typeof vi.fn> };

  const rerun = (request: LedgerReanchorRequest = REQUEST, config: LedgerConfig = ENABLED) =>
    asSystem(() =>
      new RerunLedgerReconciliationHandler(
        config,
        ledger,
        store.system,
        commands as unknown as CommandBus,
      ).execute(new RerunLedgerReconciliationCommand(request)),
    );
  const refusal = async (attempt: Promise<unknown>): Promise<string> => {
    const error = await attempt.then(
      () => expect.fail('the re-run went through'),
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(LedgerReanchorRefusedException);
    return (error as LedgerReanchorRefusedException).refusal;
  };
  const stored = () => {
    const state = store.trustedStates.get(DB);
    return state === undefined ? undefined : { ...state, txHash: [...state.txHash] };
  };

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    store = new InMemoryLedgerStore();
    commands = { execute: vi.fn(async (command: unknown) => finishRun(command, SUCCEEDED)) };
    // The ledger was re-anchored: the stored state is the restored server's current one.
    ledger = new InMemoryLedger();
    for (const n of [1, 2]) await ledger.post(draft(n));
    const current = await ledger.currentState();
    await asSystem(() => store.system.advanceTrustedState(DB, null, current, LOST_FROM));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconciles [lost-from, now − 15 min) again, writing no audit row and leaving the trusted state', async () => {
    const before = stored();

    const result = await rerun();

    expect(result).toEqual({ database: DB, reconciliation: SUCCEEDED });
    expect(store.reanchors).toEqual([]);
    expect(stored()).toEqual(before);
    expect(commands.execute).toHaveBeenCalledTimes(1);
    const [[command]] = commands.execute.mock.calls as [[ReconcileLedgerCommand]];
    expect(command).toBeInstanceOf(ReconcileLedgerCommand);
    expect(command.window).toEqual({ from: LOST_FROM, to: GRACE_END });
  });

  it('reconciles a lost-from just before the grace: the window is that last millisecond', async () => {
    const lostFrom = new Date(GRACE_END.getTime() - 1);
    await rerun({ ...REQUEST, lostFrom });
    const [[command]] = commands.execute.mock.calls as [[ReconcileLedgerCommand]];
    expect(command.window).toEqual({ from: lostFrom, to: GRACE_END });
  });

  it('carries a failed run: its status and failed checks', async () => {
    const failed = { ...SUCCEEDED, status: 'failed', failedChecks: ['R4'] };
    commands.execute.mockImplementation(async (command: unknown) => finishRun(command, failed));
    await expect(rerun()).resolves.toEqual({ database: DB, reconciliation: failed });
  });

  it('reconciles when no trusted state is stored yet (R5 stores the first one)', async () => {
    store.trustedStates.clear();
    await expect(rerun()).resolves.toMatchObject({ database: DB });
    expect(commands.execute).toHaveBeenCalledTimes(1);
  });

  it('runs only inside SystemContext', async () => {
    const handler = new RerunLedgerReconciliationHandler(
      ENABLED,
      ledger,
      store.system,
      commands as unknown as CommandBus,
    );
    await expect(
      handler.execute(new RerunLedgerReconciliationCommand(REQUEST)),
    ).rejects.toMatchObject({ code: 'SYSTEM_CONTEXT_REQUIRED' });
    expect(commands.execute).not.toHaveBeenCalled();
  });

  describe('refuses, reconciling nothing', () => {
    afterEach(() => {
      expect(commands.execute).not.toHaveBeenCalled();
      expect(store.reanchors).toEqual([]);
    });

    it('ledger-disabled', async () => {
      await expect(refusal(rerun(REQUEST, { ...ENABLED, enabled: false }))).resolves.toBe(
        'ledger-disabled',
      );
    });

    it('lost-from-not-past', async () => {
      await expect(refusal(rerun({ ...REQUEST, lostFrom: NOW }))).resolves.toBe(
        'lost-from-not-past',
      );
    });

    it.each([
      ['15 minutes ago (the grace boundary)', GRACE_END],
      ['5 minutes ago', new Date(NOW.getTime() - 5 * 60_000)],
    ])('lost-from-in-grace: a lost-from %s (nothing to reconcile yet)', async (_, lostFrom) => {
      await expect(refusal(rerun({ ...REQUEST, lostFrom }))).resolves.toBe('lost-from-in-grace');
    });

    it('other-database', async () => {
      await expect(refusal(rerun({ ...REQUEST, database: 'ledger' }))).resolves.toBe(
        'other-database',
      );
    });

    it('reanchor-needed: the current state does not extend the trusted one (a restore not re-anchored)', async () => {
      // A restore to before entry 2: the stored state is ahead of the server's history.
      const restored = new InMemoryLedger();
      await restored.post(draft(1));
      ledger = restored;
      const before = stored();
      await expect(refusal(rerun())).resolves.toBe('reanchor-needed');
      expect(stored()).toEqual(before);
    });

    it('a transport error of the extension proof propagates', async () => {
      vi.spyOn(ledger, 'advanceTrustedState').mockRejectedValue(new Error('immudb unavailable'));
      await expect(rerun()).rejects.toThrow('immudb unavailable');
    });
  });
});

/** Billing's `src` folder and every non-test TypeScript source under it (relative paths). */
const SRC = join(import.meta.dirname, '..', '..', '..');
const APPS = join(SRC, '..', '..', '..', 'apps');
const TEST_FILE = /\.(?:int-|e2e-)?spec\.ts$|\.test\.ts$/;
const sources = (root: string): string[] =>
  readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !TEST_FILE.test(file))
    .map((file) => file.split('\\').join('/'))
    .toSorted();
const naming = (root: string, name: RegExp): string[] =>
  sources(root).filter((file) => name.test(readFileSync(join(root, file), 'utf8')));
/** The files of every app's `src` (`<app>/src/...`) that match `name`. */
const appsNaming = (name: RegExp): string[] =>
  readdirSync(APPS)
    .filter((app) => existsSync(join(APPS, app, 'src')))
    .flatMap((app) => naming(join(APPS, app, 'src'), name).map((file) => `${app}/src/${file}`))
    .toSorted();

/** A static import of the module at `file` (by its basename, `.js`). */
const importing = (file: string): RegExp =>
  new RegExp(`from '[./]*(?:[\\w.-]+/)*${file.replace(/[.]/g, '\\.')}';`);

describe('the re-anchor is reachable only from the ledger-reanchor CLI', () => {
  it('only the handler calls reanchorTrustedState, and only the Drizzle repository runs its system method', () => {
    expect(naming(SRC, /\.reanchorTrustedState\(/)).toEqual([
      'application/commands/reanchor-ledger/reanchor-ledger.handler.ts',
    ]);
    // Property access on the pinned methods (quoted names and doc mentions are not uses).
    expect(naming(SRC, /[tT]rustedState\.reanchor\b(?![`'])/)).toEqual([
      'infrastructure/persistence/drizzle-ledger.system-repository.ts',
    ]);
  });

  it('only BillingLedgerReanchorModule registers the handler, and only the CLI runner imports that module', () => {
    expect(naming(SRC, importing('reanchor-ledger.handler.js'))).toEqual([
      'infrastructure/ledger/billing-ledger-reanchor.module.ts',
    ]);
    expect(naming(SRC, importing('billing-ledger-reanchor.module.js'))).toEqual([
      'presentation/cli/ledger-reanchor-cli.ts',
    ]);
    expect(naming(SRC, importing('reanchor-ledger.command.js'))).toEqual([
      'application/commands/reanchor-ledger/reanchor-ledger.handler.ts',
      'presentation/cli/ledger-reanchor-cli.ts',
    ]);
    // The package root exports the runner, not the module, the handler or the command.
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(index).not.toMatch(/reanchor-ledger\.(?:handler|command)\.js|reanchor\.module\.js/);
  });

  it('no app names the runner outside its src/cli/ledger-reanchor.ts (monolith and billing-service)', () => {
    expect(appsNaming(/\brunLedgerReanchorCli\b/)).toEqual([
      'billing-service/src/cli/ledger-reanchor.ts',
      'monolith/src/cli/ledger-reanchor.ts',
    ]);
  });
});
