import type { InvitationRecord } from './invitations.repository.js';

/** Invitations reads on the system pool (BYPASSRLS; identity's named system methods). */
export abstract class InvitationsSystemRepository {
  /**
   * `pre-auth` (spec §9 method 3): the accept flow knows only the token, not the tenant. A
   * multi-shard read on Citus.
   */
  abstract findByTokenHash(tokenHash: string): Promise<InvitationRecord | null>;
}
