import type { Member } from '@domain/identity-contracts';
import { Command } from '@nestjs/cqrs';

/** Replaces a member's roles on behalf of the actor (members:manage; owner rank for owner changes). Audited. */
export class UpdateMemberRolesCommand extends Command<Member> {
  constructor(
    readonly tenantId: string,
    readonly actorId: string,
    readonly userId: string,
    readonly roles: readonly string[],
  ) {
    super();
  }
}
