import type { TenantInvitationMailContext } from '@domain/identity-contracts';

/** Sends the invitation mail (queued: delivery is retried by the mail worker). */
export abstract class InvitationMailer {
  abstract send(mail: {
    to: string;
    invitationId: string;
    context: TenantInvitationMailContext;
  }): Promise<void>;
}
