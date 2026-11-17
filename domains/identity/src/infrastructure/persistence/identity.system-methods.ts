import { defineSystemMethod } from '@platform/database';
import { OUTBOX_SYSTEM_METHODS } from '@platform/outbox';

/**
 * Identity's doors to the `app_system` pool (BYPASSRLS), pinned by
 * `identity.system-methods.spec.ts`; only the `drizzle-*.system-repository.ts` files use them.
 *
 * - `pre-auth` (spec §9 methods 1-3): the lookups before there is a principal (login, register,
 *   the invitation token). They run anywhere.
 * - `system`: inside `SystemContext.run(reason, …)` only. `sessions.deleteExpired` (spec §9
 *   method 5) is the purge cron's. The others are the co-member and cross-tenant reads the
 *   row-local policies no longer allow (ruling `b3-identity-policies`, 2026-11-17): the caller
 *   asserts the scope (the tenant it acts in, or itself) and the SQL filters on it.
 * - `outbox` (spec §9 item 6 plus the purge; outbox plan Task 5): the relay's poll, mark and
 *   purge of `identity.outbox`, the shared `@platform/outbox` methods (system scope). Identity
 *   writes no platform-tenant rows: `outbox.insertAsPlatform` is not in its list.
 *
 * Method 7 (`staff:grant`) is not a pool method: the CLI connects as `app_owner`.
 */
export const IDENTITY_SYSTEM_METHODS = Object.freeze({
  users: Object.freeze({
    findCredentialsByEmail: defineSystemMethod('users.findCredentialsByEmail', 'pre-auth'),
    existsByEmail: defineSystemMethod('users.existsByEmail', 'pre-auth'),
    findByIdInTenant: defineSystemMethod('users.findByIdInTenant', 'system'),
    listInTenant: defineSystemMethod('users.listInTenant', 'system'),
    findByIdsInTenant: defineSystemMethod('users.findByIdsInTenant', 'system'),
  }),
  invitations: Object.freeze({
    findByTokenHash: defineSystemMethod('invitations.findByTokenHash', 'pre-auth'),
  }),
  sessions: Object.freeze({
    deleteExpired: defineSystemMethod('sessions.deleteExpired', 'system'),
  }),
  memberships: Object.freeze({
    findMember: defineSystemMethod('memberships.findMember', 'system'),
    listMembers: defineSystemMethod('memberships.listMembers', 'system'),
    listForUser: defineSystemMethod('memberships.listForUser', 'system'),
  }),
  outbox: Object.freeze({
    pollUnpublished: OUTBOX_SYSTEM_METHODS.poll,
    markPublished: OUTBOX_SYSTEM_METHODS.markPublished,
    deletePublishedBefore: OUTBOX_SYSTEM_METHODS.deletePublishedBefore,
  }),
});
