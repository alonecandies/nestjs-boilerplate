import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORM_TENANT_ID, SystemContext } from '@platform/common';
import type { SystemDatabase, SystemMethod } from '@platform/database';
import { OUTBOX_SYSTEM_METHODS, OutboxSystemRepository } from '@platform/outbox';
import { describe, expect, it } from 'vitest';
import type { LedgerSystemRepository } from '../../application/repositories/ledger.system-repository.js';
import { BILLING_SYSTEM_METHODS } from './billing.system-methods.js';
import { DrizzleLedgerSystemRepository } from './drizzle-ledger.system-repository.js';
import { BillingOutboxSystemRepository } from './drizzle-outbox.system-repository.js';
import { DrizzleStripeEventsSystemRepository } from './drizzle-stripe-events.system-repository.js';

/** Billing's `src` folder, and every non-test TypeScript source file under it (relative paths). */
const SRC = join(import.meta.dirname, '..', '..');
const TEST_FILE = /\.(?:int-)?spec\.ts$|\.test\.ts$/;
const sourceFiles = (): string[] =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !TEST_FILE.test(file))
    .map((file) => file.split('\\').join('/'))
    .toSorted();

/** The three system repositories: the only files that may name the app_system pool. */
const SYSTEM_REPOSITORY_FILES = [
  'infrastructure/persistence/drizzle-ledger.system-repository.ts',
  'infrastructure/persistence/drizzle-outbox.system-repository.ts',
  'infrastructure/persistence/drizzle-stripe-events.system-repository.ts',
];

/** The pinned groups the ledger system repository serves (spec §9 items 9-11 and plan delta 4). */
const LEDGER_GROUPS = [
  'ledgerReconciliation',
  'ledgerEntryRefs',
  'ledgerAccounts',
  'ledgerTrustedState',
  'ledgerRuns',
] as const;

/**
 * `LedgerSystemRepository`'s methods and the system method each one runs, with arguments that pass
 * every check made before SQL.
 */
const STATE = { database: 'ledger', txId: 1n, txHash: new Uint8Array([1]) };
const LEDGER_CALLS: Record<
  keyof LedgerSystemRepository,
  { readonly method: string; readonly call: (repository: LedgerSystemRepository) => unknown }
> = {
  listSucceededPayments: {
    method: 'ledgerReconciliation.listSucceededPayments',
    call: (r) => r.listSucceededPayments(new Date(0), new Date(1), null, 10),
  },
  listEntryRefs: {
    method: 'ledgerReconciliation.listEntryRefs',
    call: (r) => r.listEntryRefs(new Date(0), new Date(1), null, 10),
  },
  appendDiscrepancies: {
    method: 'ledgerReconciliation.appendDiscrepancies',
    call: (r) => r.appendDiscrepancies([]),
  },
  enqueueMissingPostings: {
    method: 'ledgerReconciliation.enqueueMissingPostings',
    call: (r) => r.enqueueMissingPostings([]),
  },
  recordEntryRefs: { method: 'ledgerEntryRefs.recordAsSystem', call: (r) => r.recordEntryRefs([]) },
  recordPlatformAccounts: {
    method: 'ledgerAccounts.recordPlatformAccounts',
    call: (r) =>
      r.recordPlatformAccounts([
        {
          tenantId: PLATFORM_TENANT_ID,
          code: 'asset:stripe_balance',
          currency: 'usd',
          immudbAccountId: PLATFORM_TENANT_ID,
        },
      ]),
  },
  readTrustedState: {
    method: 'ledgerTrustedState.read',
    call: (r) => r.readTrustedState('ledger'),
  },
  advanceTrustedState: {
    method: 'ledgerTrustedState.advance',
    call: (r) => r.advanceTrustedState('ledger', null, STATE),
  },
  startRun: {
    method: 'ledgerRuns.start',
    call: (r) => r.startRun({ id: PLATFORM_TENANT_ID, from: new Date(0), to: new Date(1) }),
  },
  finishRun: {
    method: 'ledgerRuns.finish',
    call: (r) => r.finishRun(PLATFORM_TENANT_ID, 'succeeded', { found: {}, appended: {} }),
  },
};

/** Public methods along the prototype chain (a subclass of a shared base inherits them). */
const publicMethods = (prototype: object | null): string[] => {
  const names = new Set<string>();
  for (let at = prototype; at !== null && at !== Object.prototype; ) {
    for (const name of Object.getOwnPropertyNames(at)) {
      if (name !== 'constructor') names.add(name);
    }
    at = Object.getPrototypeOf(at) as object | null;
  }
  return [...names].toSorted();
};

describe('BILLING_SYSTEM_METHODS (spec §9: methods 5, 6, 8 (stripe_events half), 9-11 and G-1)', () => {
  it('pins exactly the two stripe_events, four outbox and ten ledger methods, all in system scope', () => {
    const methods = Object.values(BILLING_SYSTEM_METHODS).flatMap((repository) =>
      Object.values(repository).map(({ name, scope }) => ({ name, scope })),
    );
    expect(methods).toEqual([
      { name: 'stripeEvents.deleteProcessedBefore', scope: 'system' },
      { name: 'stripeEvents.markProcessedAsPlatform', scope: 'system' },
      // Outbox plan Task 6 (spec §9 item 6, ruling 1): the relay's poll, mark and purge, and
      // the only door for PLATFORM_TENANT_ID rows (G-1).
      { name: 'outbox.pollUnpublished', scope: 'system' },
      { name: 'outbox.markPublished', scope: 'system' },
      { name: 'outbox.insertAsPlatform', scope: 'system' },
      { name: 'outbox.deletePublishedBefore', scope: 'system' },
      // Outbox plan Task 11: spec §9 items 9-11 and delta 4 (ruling 2).
      { name: 'ledgerReconciliation.listSucceededPayments', scope: 'system' },
      { name: 'ledgerReconciliation.listEntryRefs', scope: 'system' },
      { name: 'ledgerReconciliation.appendDiscrepancies', scope: 'system' },
      { name: 'ledgerReconciliation.enqueueMissingPostings', scope: 'system' },
      { name: 'ledgerEntryRefs.recordAsSystem', scope: 'system' },
      { name: 'ledgerAccounts.recordPlatformAccounts', scope: 'system' },
      { name: 'ledgerTrustedState.read', scope: 'system' },
      { name: 'ledgerTrustedState.advance', scope: 'system' },
      { name: 'ledgerRuns.start', scope: 'system' },
      { name: 'ledgerRuns.finish', scope: 'system' },
    ]);
    expect(Object.isFrozen(BILLING_SYSTEM_METHODS)).toBe(true);
    for (const group of Object.values(BILLING_SYSTEM_METHODS)) {
      expect(Object.isFrozen(group)).toBe(true);
    }
  });

  it('keys each method by its own name', () => {
    for (const [repository, methods] of Object.entries(BILLING_SYSTEM_METHODS)) {
      for (const [method, { name }] of Object.entries(methods)) {
        expect(name).toBe(`${repository}.${method}`);
      }
    }
  });

  it('the outbox entries are the shared @platform/outbox methods, all four', () => {
    expect(BILLING_SYSTEM_METHODS.outbox).toEqual({
      pollUnpublished: OUTBOX_SYSTEM_METHODS.poll,
      markPublished: OUTBOX_SYSTEM_METHODS.markPublished,
      insertAsPlatform: OUTBOX_SYSTEM_METHODS.insertAsPlatform,
      deletePublishedBefore: OUTBOX_SYSTEM_METHODS.deletePublishedBefore,
    });
  });

  it('each system repository implements exactly its pinned methods', () => {
    const repositories = {
      stripeEvents: DrizzleStripeEventsSystemRepository,
      outbox: BillingOutboxSystemRepository,
    };
    expect([...Object.keys(repositories), ...LEDGER_GROUPS].toSorted()).toEqual(
      Object.keys(BILLING_SYSTEM_METHODS).toSorted(),
    );
    for (const [name, repository] of Object.entries(repositories)) {
      const pinned = Object.keys(
        BILLING_SYSTEM_METHODS[name as keyof typeof BILLING_SYSTEM_METHODS],
      ).toSorted();
      expect(publicMethods(repository.prototype), name).toEqual(pinned);
    }
    expect(Object.getPrototypeOf(BillingOutboxSystemRepository.prototype)).toBe(
      OutboxSystemRepository.prototype,
    );
  });

  it('the ledger system repository has exactly the ten methods of its port', () => {
    // LEDGER_CALLS is keyed by the port (a compile error when a method is missing or extra).
    expect(publicMethods(DrizzleLedgerSystemRepository.prototype)).toEqual(
      Object.keys(LEDGER_CALLS).toSorted(),
    );
    const pinned = LEDGER_GROUPS.flatMap((group) =>
      Object.values(BILLING_SYSTEM_METHODS[group]).map(({ name }) => name),
    );
    expect(Object.values(LEDGER_CALLS).map(({ method }) => method)).toEqual(pinned);
  });

  it('each ledger method runs its own pinned system method, once, and nothing else', async () => {
    for (const [name, { method, call }] of Object.entries(LEDGER_CALLS)) {
      const ran: SystemMethod[] = [];
      const system = {
        run: (systemMethod: SystemMethod) => {
          ran.push(systemMethod);
          return Promise.reject(new Error('no database'));
        },
      } as unknown as SystemDatabase;
      const repository = new DrizzleLedgerSystemRepository(system as never);
      await expect(
        SystemContext.run('billing.system-methods-spec', () => call(repository)),
        name,
      ).rejects.toThrow('no database');
      expect(
        ran.map(({ name: ranName }) => ranName),
        name,
      ).toEqual([method]);
      const group = method.split('.')[0] as (typeof LEDGER_GROUPS)[number];
      expect(Object.values(BILLING_SYSTEM_METHODS[group]), name).toContain(ran[0]);
    }
  });

  it('the *.system-repository.ts files under infrastructure are the ledger, outbox and stripe_events ones', () => {
    expect(
      sourceFiles().filter(
        (file) => file.startsWith('infrastructure/') && file.endsWith('.system-repository.ts'),
      ),
    ).toEqual(SYSTEM_REPOSITORY_FILES);
  });

  it('no other source file of the domain names SystemDatabase', () => {
    const names = /\b(?:SystemDatabase|SYSTEM_DATABASE|InjectSystemDatabase)\b/;
    const naming = sourceFiles().filter((file) =>
      names.test(readFileSync(join(SRC, file), 'utf8')),
    );
    expect(naming).toEqual(SYSTEM_REPOSITORY_FILES);
  });
});
