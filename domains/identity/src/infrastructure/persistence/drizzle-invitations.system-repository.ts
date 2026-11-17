import { Injectable } from '@nestjs/common';
import { InjectSystemDatabase, SystemDatabase } from '@platform/database';
import { eq } from 'drizzle-orm';
import type { InvitationRecord } from '../../application/persistence/invitations.repository.js';
import type { InvitationsSystemRepository } from '../../application/persistence/invitations.system-repository.js';
import { type IdentitySchema, invitations } from './identity.schema.js';
import { IDENTITY_SYSTEM_METHODS } from './identity.system-methods.js';

/** `InvitationsSystemRepository` on the app_system pool, one named system method per call. */
@Injectable()
export class DrizzleInvitationsSystemRepository implements InvitationsSystemRepository {
  constructor(@InjectSystemDatabase() private readonly system: SystemDatabase<IdentitySchema>) {}

  /** No tenant_id in the filter: a multi-shard read (the token hash is unique per tenant). */
  findByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
    return this.system.run(IDENTITY_SYSTEM_METHODS.invitations.findByTokenHash, async (db) => {
      const [row] = await db
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, tokenHash))
        .limit(1);
      return row ?? null;
    });
  }
}
