import type { MyTenant } from '@domain/identity-contracts';
import { Command } from '@nestjs/cqrs';

/** A new (non-personal) tenant with `userId` as its only owner (spec §5.2, §9: same path as register). */
export class CreateTenantCommand extends Command<MyTenant> {
  constructor(
    readonly userId: string,
    readonly name: string,
  ) {
    super();
  }
}
