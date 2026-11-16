import type { MailService } from '@platform/mailer';
import { describe, expect, it, vi } from 'vitest';
import { INVITATION_MAIL_RETENTION, QueuedInvitationMailer } from './queued-invitation.mailer.js';

describe('QueuedInvitationMailer', () => {
  it('enqueues the tenant-invitation template, one job per invitation, deleted once done', async () => {
    const enqueue = vi.fn().mockResolvedValue({ jobId: 'x' });
    const mailer = new QueuedInvitationMailer({ enqueue } as unknown as MailService);
    const context = {
      tenantName: 'Acme',
      inviterName: 'Ada',
      roles: 'admin',
      token: 't'.repeat(43),
      acceptUrl: 'https://app.example.io/invitations/accept?token=abc',
      expiresAt: '2031-01-08T00:00:00.000Z',
    };

    await mailer.send({ to: 'bob@example.com', invitationId: 'inv-1', context });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toEqual({
      to: 'bob@example.com',
      subject: 'Ada invited you to Acme',
      template: 'tenant-invitation',
      context,
      idempotencyKey: 'tenant-invitation-inv-1',
    });
    expect(enqueue.mock.calls[0]?.[1]).toEqual({ removeOnComplete: true, removeOnFail: true });
    expect(enqueue.mock.calls[0]?.[1]).toBe(INVITATION_MAIL_RETENTION);
  });
});
