import type { Tenant } from '@domain/identity-contracts';
import { Command } from '@nestjs/cqrs';

/** Renames the actor's active tenant (owners only: `tenant:manage`). Audited. */
export class RenameTenantCommand extends Command<Tenant> {
  constructor(
    readonly tenantId: string,
    readonly actorId: string,
    readonly name: string,
  ) {
    super();
  }
}
