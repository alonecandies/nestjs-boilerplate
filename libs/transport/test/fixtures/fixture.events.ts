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

export const fixturePaymentSucceededPayload = z.object({
  paymentId: z.uuid(),
  userId: z.uuid(),
  amountTotal: z.number().int().nonnegative(),
  currency: z.string().length(3),
  paidAt: z.iso.datetime(),
});
export type FixturePaymentSucceededPayload = z.infer<typeof fixturePaymentSucceededPayload>;

export const FIXTURE_PAYMENT_SUCCEEDED_EVENT: EventContract<FixturePaymentSucceededPayload> =
  defineEventContract('fixture.payment-succeeded.v1', fixturePaymentSucceededPayload);
