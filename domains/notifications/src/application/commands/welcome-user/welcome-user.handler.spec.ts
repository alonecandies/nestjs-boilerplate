import type { CommandBus } from '@nestjs/cqrs';
import type { MailService } from '@platform/mailer';
import { createMock } from '@platform/testing';
import { describe, expect, it } from 'vitest';
import { asClass, makeContractNotification, USER_ID } from '../../../../test/support/fixtures.js';
import { CreateNotificationCommand } from '../create-notification/create-notification.command.js';
import { WelcomeUserCommand } from './welcome-user.command.js';
import { WELCOME_NOTIFICATION_TITLE, WelcomeUserHandler } from './welcome-user.handler.js';

const registeredAt = new Date('2026-09-29T07:00:00.000Z');

function setup() {
  const notification = makeContractNotification();
  const commandBus = createMock<CommandBus>({ execute: async () => notification });
  const mail = createMock<MailService>({ enqueue: async () => ({ jobId: 'welcome-x' }) });
  const handler = new WelcomeUserHandler(asClass(commandBus), asClass(mail));
  return { notification, commandBus, mail, handler };
}

describe('WelcomeUserHandler', () => {
  it('creates the welcome notification and queues the welcome mail (recipients follow memberships)', async () => {
    const { notification, commandBus, mail, handler } = setup();

    const result = await handler.execute(
      new WelcomeUserCommand({
        userId: USER_ID,
        email: 'ada@example.com',
        displayName: '  Ada  ',
        registeredAt,
      }),
    );

    expect(result).toBe(notification);
    // The welcome writes no recipient row: membership-created does (UpsertRecipientCommand).
    expect(commandBus.execute).toHaveBeenCalledTimes(1);
    const [command] = commandBus.execute.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(CreateNotificationCommand);
    expect((command as CreateNotificationCommand).input).toEqual({
      userId: USER_ID,
      type: 'welcome',
      title: WELCOME_NOTIFICATION_TITLE,
      body: 'Hi Ada, your account is ready. Enjoy!',
      idempotency: { key: `welcome:${USER_ID}`, occurredAt: registeredAt },
    });
    expect(mail.enqueue).toHaveBeenCalledWith({
      to: 'ada@example.com',
      subject: expect.any(String),
      template: 'welcome',
      context: { displayName: 'Ada' },
      idempotencyKey: `welcome-${USER_ID}`,
    });
  });

  it('falls back to a neutral greeting without a display name', async () => {
    const { commandBus, mail, handler } = setup();
    await handler.execute(
      new WelcomeUserCommand({ userId: USER_ID, email: 'a@b.io', displayName: '', registeredAt }),
    );
    const [command] = commandBus.execute.mock.calls[0] ?? [];
    expect((command as CreateNotificationCommand).input.body).toBe(
      'Hi there, your account is ready. Enjoy!',
    );
    expect(mail.enqueue.mock.calls[0]?.[0].context).toEqual({ displayName: 'a@b.io' });
  });

  it('propagates a mail queue failure (the consumer dead-letters it; replay is idempotent)', async () => {
    const { mail, handler } = setup();
    mail.enqueue.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      handler.execute(
        new WelcomeUserCommand({
          userId: USER_ID,
          email: 'a@b.io',
          displayName: 'A',
          registeredAt,
        }),
      ),
    ).rejects.toThrow('redis down');
  });
});
