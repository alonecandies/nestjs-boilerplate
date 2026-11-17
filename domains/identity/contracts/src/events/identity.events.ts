import { defineEventContract, type EventContract } from '@platform/contracts';
import { z } from 'zod';

/*
 * Every identity event is tenant-scoped (B4-1): the envelope `tenantId` names the tenant the event is
 * about (passed explicitly by the producer, never the CLS default), the Kafka key is the user id (per-user
 * order within a topic), and `actorId` is the acting user, or `null`.
 */

/** Payload of `identity.user-registered.v1`: a user account was created. */
export const userRegisteredPayload = z.object({
  userId: z.uuid(),
  /** Normalised (trimmed, lowercase) email. */
  email: z.email(),
  displayName: z.string(),
  registeredAt: z.iso.datetime(),
});

export type UserRegisteredPayload = z.infer<typeof userRegisteredPayload>;

/**
 * A user account was created. Envelope `tenantId` = the new account's personal workspace. Produced by
 * identity; notifications sends the welcome mail.
 */
export const USER_REGISTERED_EVENT: EventContract<UserRegisteredPayload> = defineEventContract(
  'identity.user-registered.v1',
  userRegisteredPayload,
  { tenantScoped: true },
);

/** Payload of `identity.membership-created.v1`: a user became a member of the envelope's tenant. */
export const membershipCreatedPayload = z.object({
  userId: z.uuid(),
  /** Normalised (trimmed, lowercase) email. */
  email: z.email(),
  displayName: z.string(),
  createdAt: z.iso.datetime(),
});

export type MembershipCreatedPayload = z.infer<typeof membershipCreatedPayload>;

/**
 * A membership was created (personal workspace, new tenant, accepted invitation). Envelope `tenantId` =
 * the membership's tenant. Notifications keeps its recipients projection per `(tenant, user)` from it.
 */
export const MEMBERSHIP_CREATED_EVENT: EventContract<MembershipCreatedPayload> =
  defineEventContract('identity.membership-created.v1', membershipCreatedPayload, {
    tenantScoped: true,
  });

/** Payload of `identity.membership-removed.v1`: a user stopped being a member of the envelope's tenant. */
export const membershipRemovedPayload = z.object({
  userId: z.uuid(),
  removedAt: z.iso.datetime(),
});

export type MembershipRemovedPayload = z.infer<typeof membershipRemovedPayload>;

/** A membership ended (member removed, member left). Envelope `tenantId` = the membership's tenant. */
export const MEMBERSHIP_REMOVED_EVENT: EventContract<MembershipRemovedPayload> =
  defineEventContract('identity.membership-removed.v1', membershipRemovedPayload, {
    tenantScoped: true,
  });
