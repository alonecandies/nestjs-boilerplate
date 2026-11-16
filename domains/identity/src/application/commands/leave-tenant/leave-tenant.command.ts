import { Command } from '@nestjs/cqrs';

/** The user leaves the tenant they act in (never the last owner; not staff switch-in). Audited. */
export class LeaveTenantCommand extends Command<void> {
  constructor(
    readonly tenantId: string,
    readonly userId: string,
  ) {
    super();
  }
}
