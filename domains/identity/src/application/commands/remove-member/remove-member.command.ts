import { Command } from '@nestjs/cqrs';

/** Removes a member from the actor's tenant (members:manage; owner rank for an owner). Audited. */
export class RemoveMemberCommand extends Command<void> {
  constructor(
    readonly tenantId: string,
    readonly actorId: string,
    readonly userId: string,
  ) {
    super();
  }
}
