import type { MailMessage, MailService } from '@app/mailer';
import { createMock } from '@app/testing';
import { describe, expect, it } from 'vitest';
import { asClass, makeNotificationProps } from '../../../../test/support/fixtures.js';
import { DIGEST_ITEMS_PER_MAIL, DIGEST_SCAN_PER_USER } from '../../../notifications.constants.js';
import type {
  NotificationRecipient,
  NotificationRecipientsRepository,
  NotificationRecipientsSlice,
} from '../../ports/notification-recipients.repository.js';
import type { NotificationsRepository } from '../../ports/notifications.repository.js';
import { SendDailyDigestCommand } from './send-daily-digest.command.js';
import { SendDailyDigestHandler } from './send-daily-digest.handler.js';

const NOW = new Date('2026-09-29T09:00:00.000Z');
const recipient = (n: number): NotificationRecipient => ({
  userId: `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  email: `user${n}@example.com`,
  displayName: n === 1 ? '' : `User ${n}`,
  updatedAt: NOW,
});

function setup(pages: NotificationRecipientsSlice[], unreadByUser: Record<string, number>) {
  const recipients = createMock<NotificationRecipientsRepository>();
  for (const page of pages) recipients.scan.mockResolvedValueOnce(page);
  recipients.scan.mockResolvedValue({ items: [], pageState: null });
  const notifications = createMock<NotificationsRepository>({
    findRecentByUser: async (userId: string) => [
      ...Array.from({ length: unreadByUser[userId] ?? 0 }, (_, i) =>
        makeNotificationProps({ userId, title: `n${i}` }),
      ),
      makeNotificationProps({ userId, read: true }),
    ],
  });
  const mail = createMock<MailService>({ enqueue: async () => ({ jobId: 'x' }) });
  return {
    recipients,
    notifications,
    mail,
    handler: new SendDailyDigestHandler(recipients, notifications, asClass(mail)),
  };
}

describe('SendDailyDigestHandler', () => {
  it('pages through recipients and queues one digest per recipient with unread items', async () => {
    const [r1, r2, r3] = [recipient(1), recipient(2), recipient(3)];
    const { recipients, notifications, mail, handler } = setup(
      [
        { items: [r1, r2], pageState: 'aa01' },
        { items: [r3], pageState: null },
      ],
      { [r1.userId]: 12, [r3.userId]: 1 },
    );

    const result = await handler.execute(new SendDailyDigestCommand({ now: NOW }));

    expect(result).toEqual({ scanned: 3, enqueued: 2, failed: 0 });
    expect(recipients.scan.mock.calls.map(([, state]) => state)).toEqual([undefined, 'aa01']);
    expect(notifications.findRecentByUser).toHaveBeenCalledWith(r2.userId, DIGEST_SCAN_PER_USER);

    const mails: MailMessage[] = mail.enqueue.mock.calls.map(([m]) => m);
    const first = mails.find((m) => m.to === r1.email);
    expect(first).toMatchObject({
      template: 'daily-digest',
      subject: 'You have 12 unread notifications',
      idempotencyKey: `digest-${r1.userId}-2026-09-29`,
      context: { displayName: undefined, unreadCount: 12 },
    });
    expect(first?.context.items).toHaveLength(DIGEST_ITEMS_PER_MAIL);
    expect(mails.find((m) => m.to === r3.email)?.subject).toBe('You have 1 unread notification');
  });

  it('honours maxRecipients (bounded run) and never asks for more than the remaining budget', async () => {
    const { recipients, handler } = setup(
      [{ items: [recipient(1), recipient(2)], pageState: 'aa01' }],
      {},
    );
    const result = await handler.execute(
      new SendDailyDigestCommand({ maxRecipients: 2, now: NOW }),
    );
    expect(result.scanned).toBe(2);
    expect(recipients.scan).toHaveBeenCalledTimes(1);
    expect(recipients.scan).toHaveBeenCalledWith(2, undefined);
  });

  it('counts a failing recipient and carries on with the others', async () => {
    const [r1, r2] = [recipient(1), recipient(2)];
    const { notifications, handler } = setup([{ items: [r1, r2], pageState: null }], {
      [r2.userId]: 1,
    });
    notifications.findRecentByUser.mockRejectedValueOnce(new Error('timeout'));

    await expect(handler.execute(new SendDailyDigestCommand({ now: NOW }))).resolves.toEqual({
      scanned: 2,
      enqueued: 1,
      failed: 1,
    });
  });

  it('stops on an empty page even if the driver returned a state', async () => {
    const { recipients, handler } = setup([{ items: [], pageState: 'ff' }], {});
    await expect(handler.execute(new SendDailyDigestCommand({ now: NOW }))).resolves.toEqual({
      scanned: 0,
      enqueued: 0,
      failed: 0,
    });
    expect(recipients.scan).toHaveBeenCalledTimes(1);
  });
});
