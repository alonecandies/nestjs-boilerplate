import { defineEventContract, type EventContract } from '@platform/contracts';
import { z } from 'zod';

/** Payload of `identity.user-registered.v1`: a user account was created. */
export const userRegisteredPayload = z.object({
  userId: z.uuid(),
  /** Normalised (trimmed, lowercase) email. */
  email: z.email(),
  displayName: z.string(),
  registeredAt: z.iso.datetime(),
});

export type UserRegisteredPayload = z.infer<typeof userRegisteredPayload>;

/** A user account was created. Produced by identity; notifications sends the welcome mail. */
export const USER_REGISTERED_EVENT: EventContract<UserRegisteredPayload> = defineEventContract(
  'identity.user-registered.v1',
  userRegisteredPayload,
);
