import { createMock } from '@platform/testing';
import { describe, expect, it } from 'vitest';
import { TENANT_ID, USER_ID } from '../../../../test/support/fixtures.js';
import type { NotificationRecipientsRepository } from '../../ports/notification-recipients.repository.js';
import { RemoveRecipientCommand } from './remove-recipient.command.js';
import { RemoveRecipientHandler } from './remove-recipient.handler.js';

describe('RemoveRecipientHandler', () => {
  it('removes the (tenant, user) row stamped with the removal time', async () => {
    const recipients = createMock<NotificationRecipientsRepository>({
      remove: async () => undefined,
    });
    const removedAt = new Date('2026-09-29T08:00:00.000Z');

    await new RemoveRecipientHandler(recipients).execute(
      new RemoveRecipientCommand({ tenantId: TENANT_ID, userId: USER_ID, removedAt }),
    );

    expect(recipients.remove).toHaveBeenCalledWith(TENANT_ID, USER_ID, removedAt);
  });
});
