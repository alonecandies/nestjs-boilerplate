import type { MyTenant } from '@domain/identity-contracts';
import { Command } from '@nestjs/cqrs';

/** The logged-in user accepts an invitation by its raw token (the email must match). */
export class AcceptInvitationCommand extends Command<MyTenant> {
  constructor(
    readonly userId: string,
    readonly token: string,
  ) {
    super();
  }
}
