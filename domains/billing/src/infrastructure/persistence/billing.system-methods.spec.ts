import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTBOX_SYSTEM_METHODS, OutboxSystemRepository } from '@platform/outbox';
import { describe, expect, it } from 'vitest';
import { BILLING_SYSTEM_METHODS } from './billing.system-methods.js';
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

/** The two system repositories: the only files that may name the app_system pool. */
const SYSTEM_REPOSITORY_FILES = [
  'infrastructure/persistence/drizzle-outbox.system-repository.ts',
  'infrastructure/persistence/drizzle-stripe-events.system-repository.ts',
];

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

describe('BILLING_SYSTEM_METHODS (spec §9: methods 5, 6, the stripe_events half of 8 and G-1)', () => {
  it('pins exactly the two stripe_events methods and the four outbox methods, all in system scope', () => {
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
    ]);
    expect(Object.isFrozen(BILLING_SYSTEM_METHODS)).toBe(true);
    expect(Object.isFrozen(BILLING_SYSTEM_METHODS.stripeEvents)).toBe(true);
    expect(Object.isFrozen(BILLING_SYSTEM_METHODS.outbox)).toBe(true);
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
    expect(Object.keys(repositories).toSorted()).toEqual(
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

  it('the *.system-repository.ts files under infrastructure are the stripe_events and outbox ones', () => {
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
