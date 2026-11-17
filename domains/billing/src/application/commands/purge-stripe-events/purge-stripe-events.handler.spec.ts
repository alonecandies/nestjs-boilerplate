import { createMock } from '@platform/testing';
import { describe, expect, it } from 'vitest';
import type { StripeEventsRepository } from '../../repositories/stripe-events.repository.js';
import { PurgeStripeEventsCommand } from './purge-stripe-events.command.js';
import { PurgeStripeEventsHandler } from './purge-stripe-events.handler.js';

describe('PurgeStripeEventsHandler', () => {
  const cutoff = new Date('2026-09-05T12:00:00.000Z');

  it('deletes every event processed before the cutoff in one call, and returns the count', async () => {
    const events = createMock<StripeEventsRepository>();
    events.deleteProcessedBefore.mockResolvedValue(12_345);

    const total = await new PurgeStripeEventsHandler(events).execute(
      new PurgeStripeEventsCommand(cutoff),
    );

    expect(total).toBe(12_345);
    expect(events.deleteProcessedBefore).toHaveBeenCalledTimes(1);
    expect(events.deleteProcessedBefore).toHaveBeenCalledWith(cutoff);
  });

  it('calls the repository once even when nothing is left to delete', async () => {
    const events = createMock<StripeEventsRepository>();
    events.deleteProcessedBefore.mockResolvedValue(0);

    await expect(
      new PurgeStripeEventsHandler(events).execute(new PurgeStripeEventsCommand(cutoff)),
    ).resolves.toBe(0);
    expect(events.deleteProcessedBefore).toHaveBeenCalledTimes(1);
  });
});
