import { describe, expect, it } from 'vitest';
import { OTHER_TENANT_ID, TENANT_ID, USER_ID } from '../../../../test/support/fixtures.js';
import { InMemoryNotificationRecipientsRepository } from '../../../testing/in-memory-notification-recipients.repository.js';
import { RemoveRecipientCommand } from '../remove-recipient/remove-recipient.command.js';
import { RemoveRecipientHandler } from '../remove-recipient/remove-recipient.handler.js';
import { UpsertRecipientCommand } from './upsert-recipient.command.js';
import { UpsertRecipientHandler } from './upsert-recipient.handler.js';

const createdAt = new Date('2026-09-29T07:00:00.000Z');
const later = new Date('2026-09-29T08:00:00.000Z');

function setup() {
  const recipients = new InMemoryNotificationRecipientsRepository();
  return {
    recipients,
    upsert: new UpsertRecipientHandler(recipients),
    remove: new RemoveRecipientHandler(recipients),
  };
}

const created = (tenantId: string, email: string, at = createdAt) =>
  new UpsertRecipientCommand({
    tenantId,
    userId: USER_ID,
    email,
    displayName: '  Ada  ',
    createdAt: at,
  });

describe('UpsertRecipientHandler / RemoveRecipientHandler', () => {
  it('records the recipient of one (tenant, user), display name trimmed, stamped createdAt', async () => {
    const { recipients, upsert } = setup();
    await upsert.execute(created(TENANT_ID, 'ada@a.example'));

    await expect(recipients.find(TENANT_ID, USER_ID)).resolves.toEqual({
      tenantId: TENANT_ID,
      userId: USER_ID,
      email: 'ada@a.example',
      displayName: 'Ada',
      updatedAt: createdAt,
    });
    await expect(recipients.find(OTHER_TENANT_ID, USER_ID)).resolves.toBeNull();
  });

  it('removes only the pair of the command', async () => {
    const { recipients, upsert, remove } = setup();
    await upsert.execute(created(TENANT_ID, 'ada@a.example'));
    await upsert.execute(created(OTHER_TENANT_ID, 'ada@b.example'));

    await remove.execute(
      new RemoveRecipientCommand({ tenantId: TENANT_ID, userId: USER_ID, removedAt: later }),
    );

    await expect(recipients.find(TENANT_ID, USER_ID)).resolves.toBeNull();
    await expect(recipients.find(OTHER_TENANT_ID, USER_ID)).resolves.toMatchObject({
      email: 'ada@b.example',
    });
  });

  it('a replayed, earlier-stamped created does not resurrect a removed member', async () => {
    const { recipients, upsert, remove } = setup();
    await remove.execute(
      new RemoveRecipientCommand({ tenantId: TENANT_ID, userId: USER_ID, removedAt: later }),
    );
    await upsert.execute(created(TENANT_ID, 'ada@a.example'));
    await expect(recipients.find(TENANT_ID, USER_ID)).resolves.toBeNull();

    await upsert.execute(created(TENANT_ID, 'ada@a.example', new Date('2026-09-29T09:00:00.000Z')));
    await expect(recipients.find(TENANT_ID, USER_ID)).resolves.not.toBeNull();
  });
});
