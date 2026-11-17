import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BILLING_SYSTEM_METHODS } from './billing.system-methods.js';

/** Billing's `src` folder, and every non-test TypeScript source file under it (relative paths). */
const SRC = join(import.meta.dirname, '..', '..');
const TEST_FILE = /\.(?:int-)?spec\.ts$|\.test\.ts$/;
const sourceFiles = (): string[] =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !TEST_FILE.test(file))
    .map((file) => file.split('\\').join('/'))
    .toSorted();

describe('BILLING_SYSTEM_METHODS (spec §9: methods 5 and the stripe_events half of 8)', () => {
  it('pins exactly the two stripe_events methods, both in system scope', () => {
    const methods = Object.values(BILLING_SYSTEM_METHODS).flatMap((repository) =>
      Object.values(repository).map(({ name, scope }) => ({ name, scope })),
    );
    expect(methods).toEqual([
      { name: 'stripeEvents.deleteProcessedBefore', scope: 'system' },
      { name: 'stripeEvents.markProcessedAsPlatform', scope: 'system' },
    ]);
    expect(Object.isFrozen(BILLING_SYSTEM_METHODS)).toBe(true);
    expect(Object.isFrozen(BILLING_SYSTEM_METHODS.stripeEvents)).toBe(true);
  });

  it('keys each method by its own name', () => {
    for (const [repository, methods] of Object.entries(BILLING_SYSTEM_METHODS)) {
      for (const [method, { name }] of Object.entries(methods)) {
        expect(name).toBe(`${repository}.${method}`);
      }
    }
  });

  it('the only *.system-repository.ts under infrastructure is the stripe_events one', () => {
    expect(
      sourceFiles().filter(
        (file) => file.startsWith('infrastructure/') && file.endsWith('.system-repository.ts'),
      ),
    ).toEqual(['infrastructure/persistence/drizzle-stripe-events.system-repository.ts']);
  });

  it('no other source file of the domain names SystemDatabase', () => {
    const names = /\b(?:SystemDatabase|SYSTEM_DATABASE|InjectSystemDatabase)\b/;
    const naming = sourceFiles().filter((file) =>
      names.test(readFileSync(join(SRC, file), 'utf8')),
    );
    expect(naming).toEqual([
      'infrastructure/persistence/drizzle-stripe-events.system-repository.ts',
    ]);
  });
});
