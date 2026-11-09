import { defineEventContract, type EventContract } from '@platform/contracts';
import { z } from 'zod';

/** Test-local event contracts of the @platform/transport Kafka specs. */
export const fixtureUserRegisteredPayload = z.object({
  userId: z.uuid(),
  email: z.email(),
  displayName: z.string(),
  registeredAt: z.iso.datetime(),
});
export type FixtureUserRegisteredPayload = z.infer<typeof fixtureUserRegisteredPayload>;

export const FIXTURE_USER_REGISTERED_EVENT: EventContract<FixtureUserRegisteredPayload> =
  defineEventContract('fixture.user-registered.v1', fixtureUserRegisteredPayload);

export const fixtureOrderPlacedPayload = z.object({
  orderId: z.uuid(),
  userId: z.uuid(),
  amountTotal: z.number().int().nonnegative(),
  currency: z.string().length(3),
  placedAt: z.iso.datetime(),
});
export type FixtureOrderPlacedPayload = z.infer<typeof fixtureOrderPlacedPayload>;

export const FIXTURE_ORDER_PLACED_EVENT: EventContract<FixtureOrderPlacedPayload> =
  defineEventContract('fixture.order-placed.v1', fixtureOrderPlacedPayload);
