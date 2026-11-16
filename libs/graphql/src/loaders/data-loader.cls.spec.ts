import { createPrincipal, generateId, getPrincipal, runWithPrincipal } from '@platform/common';
import DataLoader from 'dataloader';
import { describe, expect, it } from 'vitest';
import { DataLoaderRegistry } from './data-loader.registry.js';

const principal = () =>
  createPrincipal({ userId: generateId(), tenantId: generateId(), roles: ['member'] });

/** The principals built here always act in a tenant. */
const tenantOf = (p: ReturnType<typeof principal>): string => {
  if (p.tenantId === null) throw new Error('expected a tenant principal');
  return p.tenantId;
};

describe('DataLoader batches and the request CLS (spec §7, B2-25)', () => {
  const seenByBatch: (string | undefined)[] = [];
  const registry = new DataLoaderRegistry();
  registry.register(
    'orders',
    () =>
      new DataLoader<string, string>(async (ids) => {
        // Simulate I/O before reading the context, as a real batch (gRPC, SQL) would.
        await new Promise((resolve) => setTimeout(resolve, 5));
        seenByBatch.push(getPrincipal()?.tenantId ?? undefined);
        return ids.map((id) => `${getPrincipal()?.tenantId ?? 'none'}:${id}`);
      }),
  );

  it('a batch sees the principal of the operation that loaded the keys', async () => {
    const ada = principal();
    const result = await runWithPrincipal(ada, async () => {
      const loaders = registry.createLoaders();
      const orders = loaders['orders'] as DataLoader<string, string>;
      return Promise.all([orders.load('o1'), orders.load('o2')]);
    });
    expect(result).toEqual([`${tenantOf(ada)}:o1`, `${tenantOf(ada)}:o2`]);
  });

  it('two concurrent operations never see each other (one batch each, own principal)', async () => {
    seenByBatch.length = 0;
    const ada = principal();
    const bob = principal();
    const operation = (p: ReturnType<typeof principal>) =>
      runWithPrincipal(p, async () => {
        const orders = registry.createLoaders()['orders'] as DataLoader<string, string>;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return Promise.all([orders.load('a'), orders.load('b')]);
      });

    const [forAda, forBob] = await Promise.all([operation(ada), operation(bob)]);

    expect(forAda).toEqual([`${tenantOf(ada)}:a`, `${tenantOf(ada)}:b`]);
    expect(forBob).toEqual([`${tenantOf(bob)}:a`, `${tenantOf(bob)}:b`]);
    expect([...seenByBatch].sort()).toEqual([tenantOf(ada), tenantOf(bob)].sort());
  });

  it('a loader created lazily in one operation is never reused by another', async () => {
    const ada = principal();
    const bob = principal();
    const shared = registry.createLoaders();
    const first = await runWithPrincipal(ada, () =>
      (shared['orders'] as DataLoader<string, string>).load('x'),
    );
    const second = await runWithPrincipal(bob, () => registry.createLoaders()['orders']!.load('x'));
    expect(first).toBe(`${tenantOf(ada)}:x`);
    expect(second).toBe(`${tenantOf(bob)}:x`);
  });
});
