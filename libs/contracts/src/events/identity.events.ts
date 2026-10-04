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
