import {
  IDENTITY_MAIL_TEMPLATES,
  type TenantInvitationMailContext,
} from '@domain/identity-contracts';
import { Injectable } from '@nestjs/common';
import { type MailJobRetention, MailService } from '@platform/mailer';
import type { InvitationMailer } from '../../application/ports/invitation-mailer.port.js';

/**
 * The job data holds the raw invitation token: delete the job once it is sent or has given up
 * (MAIL_JOB_OPTIONS would keep it 24 h after success and 7 days after failure).
 */
export const INVITATION_MAIL_RETENTION: MailJobRetention = {
  removeOnComplete: true,
  removeOnFail: true,
};

@Injectable()
export class QueuedInvitationMailer implements InvitationMailer {
  constructor(private readonly mail: MailService) {}

  async send(mail: {
    to: string;
    invitationId: string;
    context: TenantInvitationMailContext;
  }): Promise<void> {
    await this.mail.enqueue(
      {
        to: mail.to,
        subject: `${mail.context.inviterName} invited you to ${mail.context.tenantName}`,
        template: IDENTITY_MAIL_TEMPLATES.TENANT_INVITATION,
        context: { ...mail.context },
        // One job per invitation id, so a duplicate enqueue in the same request is a no-op.
        idempotencyKey: `tenant-invitation-${mail.invitationId}`,
      },
      INVITATION_MAIL_RETENTION,
    );
  }
}
