import {
  createPrincipal,
  generateId,
  PLATFORM_TENANT_ID,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { describe, expect, it } from 'vitest';
import { InMemoryStripeEventsSystemRepository } from './in-memory-stripe-events-system-repository.js';

describe('InMemoryStripeEventsSystemRepository (refuses what the real one refuses)', () => {
  const inSystem = <T>(fn: () => Promise<T>): Promise<T> =>
    SystemContext.run('billing.fake-spec', fn);
  const payout = { tenantId: PLATFORM_TENANT_ID, userId: null, id: 'evt_p', type: 'payout.paid' };

  it('records a user-less event once', async () => {
    const repository = new InMemoryStripeEventsSystemRepository();
    await expect(inSystem(() => repository.markProcessedAsPlatform(payout))).resolves.toBe(true);
    await expect(inSystem(() => repository.markProcessedAsPlatform(payout))).resolves.toBe(false);
    expect(repository.events).toEqual([expect.objectContaining(payout)]);
  });

  it('refuses a receipt with a user, and both methods outside SystemContext', async () => {
    const repository = new InMemoryStripeEventsSystemRepository();
    await expect(
      inSystem(() => repository.markProcessedAsPlatform({ ...payout, userId: generateId() })),
    ).rejects.toThrow(/user/);
    const refused = { name: 'SystemDatabaseError', code: 'SYSTEM_CONTEXT_REQUIRED' };
    await expect(repository.markProcessedAsPlatform(payout)).rejects.toMatchObject(refused);
    await expect(repository.deleteProcessedBefore(new Date())).rejects.toMatchObject(refused);
    const member = createPrincipal({ userId: generateId(), tenantId: generateId() });
    await expect(
      inSystem(() => runWithPrincipal(member, () => repository.deleteProcessedBefore(new Date()))),
    ).rejects.toMatchObject(refused);
    expect(repository.events).toEqual([]);
  });

  it('purges events processed before the cutoff, in every tenant', async () => {
    const repository = new InMemoryStripeEventsSystemRepository();
    const cutoff = new Date('2026-10-01T00:00:00.000Z');
    repository.seed(payout, new Date('2026-09-01T00:00:00.000Z'));
    repository.seed(
      { ...payout, tenantId: generateId(), id: 'evt_old' },
      new Date('2026-09-02T00:00:00.000Z'),
    );
    repository.seed({ ...payout, id: 'evt_fresh' }, cutoff);

    await expect(inSystem(() => repository.deleteProcessedBefore(cutoff))).resolves.toBe(2);
    expect(repository.events.map((event) => event.id)).toEqual(['evt_fresh']);
  });
});
