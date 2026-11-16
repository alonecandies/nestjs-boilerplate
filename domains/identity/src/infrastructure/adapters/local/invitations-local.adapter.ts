import type {
  AcceptInvitationRequest,
  CreateInvitationRequest,
  Invitation,
  MyTenant,
} from '@domain/identity-contracts';
import { Injectable } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { AcceptInvitationCommand } from '../../../application/commands/accept-invitation/accept-invitation.command.js';
import { CreateInvitationCommand } from '../../../application/commands/create-invitation/create-invitation.command.js';
import type { InvitationsPort } from '../../../application/ports/invitations.port.js';

/** Monolith binding of `InvitationsPort`: the CQRS command bus of `IdentityCoreModule`. */
@Injectable()
export class InvitationsLocalAdapter implements InvitationsPort {
  constructor(private readonly commandBus: CommandBus) {}

  createInvitation(input: CreateInvitationRequest): Promise<Invitation> {
    return this.commandBus.execute(
      new CreateInvitationCommand(input.tenantId, input.actorId, input.email, input.roles),
    );
  }

  acceptInvitation(input: AcceptInvitationRequest): Promise<MyTenant> {
    return this.commandBus.execute(new AcceptInvitationCommand(input.userId, input.token));
  }
}
