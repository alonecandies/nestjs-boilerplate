import { createMock } from '@app/testing';
import { describe, expect, it } from 'vitest';
import { PURGE_STRIPE_EVENTS_BATCH_SIZE } from '../../../billing.constants.js';
import type { StripeEventsRepository } from '../../repositories/stripe-events.repository.js';
import { PurgeStripeEventsCommand } from './purge-stripe-events.command.js';
import { PurgeStripeEventsHandler } from './purge-stripe-events.handler.js';

describe('PurgeStripeEventsHandler', () => {
  const cutoff = new Date('2026-09-05T12:00:00.000Z');

  it('deletes in bounded batches until a partial batch, and returns the total', async () => {
    const events = createMock<StripeEventsRepository>();
    events.deleteProcessedBefore
      .mockResolvedValueOnce(PURGE_STRIPE_EVENTS_BATCH_SIZE)
      .mockResolvedValueOnce(PURGE_STRIPE_EVENTS_BATCH_SIZE)
      .mockResolvedValueOnce(7);

    const total = await new PurgeStripeEventsHandler(events).execute(
      new PurgeStripeEventsCommand(cutoff),
    );

    expect(total).toBe(2 * PURGE_STRIPE_EVENTS_BATCH_SIZE + 7);
    expect(events.deleteProcessedBefore).toHaveBeenCalledTimes(3);
    expect(events.deleteProcessedBefore).toHaveBeenCalledWith(
      cutoff,
      PURGE_STRIPE_EVENTS_BATCH_SIZE,
    );
  });

  it('stops after the per-run batch cap even if rows keep coming', async () => {
    const events = createMock<StripeEventsRepository>();
    events.deleteProcessedBefore.mockResolvedValue(PURGE_STRIPE_EVENTS_BATCH_SIZE);

    await new PurgeStripeEventsHandler(events).execute(new PurgeStripeEventsCommand(cutoff));

    expect(events.deleteProcessedBefore).toHaveBeenCalledTimes(200);
  });
});
