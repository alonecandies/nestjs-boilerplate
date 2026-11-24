import { isUuidV7, uuidV7Timestamp } from '@platform/common';
import { createMock } from '@platform/testing';
import { describe, expect, it } from 'vitest';
import { TENANT_ID, USER_ID } from '../../../../test/support/fixtures.js';
import { InvalidNotificationException } from '../../../domain/notification.errors.js';
import { deriveNotificationId } from '../../../domain/notification-id.js';
import type { NotificationsRepository } from '../../ports/notifications.repository.js';
import { CreateNotificationCommand } from './create-notification.command.js';
import { CreateNotificationHandler } from './create-notification.handler.js';

function setup() {
  const repository = createMock<NotificationsRepository>({ insert: async () => undefined });
  const handler = new CreateNotificationHandler(repository);
  return { repository, handler };
}

const input = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  type: 'system' as const,
  title: 'Maintenance tonight',
  body: '02:00–03:00 UTC',
};

describe('CreateNotificationHandler', () => {
  it('persists an unread notification with a fresh uuidv7', async () => {
    const { repository, handler } = setup();
    const before = Date.now();

    const result = await handler.execute(new CreateNotificationCommand(input));

    expect(isUuidV7(result.id)).toBe(true);
    expect(result).toMatchObject({ ...input, read: false, data: {} });
    expect(result.createdAt?.getTime()).toBeGreaterThanOrEqual(before);
    // Stored in the input's (tenant, user) inbox.
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ id: result.id, tenantId: TENANT_ID, userId: USER_ID, read: false }),
    );
  });

  it('derives a deterministic id and uses the fact time when an idempotency key is given', async () => {
    const { handler } = setup();
    const occurredAt = new Date('2026-01-01T00:00:00.000Z');
    const idempotency = { key: 'welcome:u1', occurredAt };

    const first = await handler.execute(new CreateNotificationCommand({ ...input, idempotency }));
    const second = await handler.execute(new CreateNotificationCommand({ ...input, idempotency }));

    expect(first.id).toBe(deriveNotificationId('welcome:u1', occurredAt));
    expect(second.id).toBe(first.id);
    expect(first.createdAt).toEqual(occurredAt);
    expect(uuidV7Timestamp(first.id)).toEqual(occurredAt);
  });

  it('rejects when persistence fails', async () => {
    const { repository, handler } = setup();
    repository.insert.mockRejectedValueOnce(new Error('NoHostAvailable'));

    await expect(handler.execute(new CreateNotificationCommand(input))).rejects.toThrow(
      'NoHostAvailable',
    );
  });

  it('rejects invalid notifications before touching the repository', async () => {
    const { repository, handler } = setup();
    await expect(
      handler.execute(new CreateNotificationCommand({ ...input, title: '' })),
    ).rejects.toBeInstanceOf(InvalidNotificationException);
    expect(repository.insert).not.toHaveBeenCalled();
  });
});
