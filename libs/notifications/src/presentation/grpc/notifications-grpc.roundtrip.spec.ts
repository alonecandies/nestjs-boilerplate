import { createServer } from 'node:net';
import { DomainValidationException, generateId } from '@app/common';
import { AppConfigModule, grpcConfig } from '@app/config';
import { createGrpcServerStrategy, GrpcClientsModule } from '@app/transport';
import { type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeNotificationProps, USER_ID } from '../../../test/support/fixtures.js';
import { MarkNotificationReadCommand } from '../../application/commands/mark-notification-read/mark-notification-read.command.js';
import { toNotificationPage } from '../../application/mappers/notification.mapper.js';
import { ListNotificationsQuery } from '../../application/queries/list-notifications/list-notifications.query.js';
import { NotificationNotFoundException } from '../../domain/notification.errors.js';
import { NotificationsGrpcAdapter } from '../../infrastructure/adapters/grpc/notifications-grpc.adapter.js';
import { NotificationsGrpcController } from './notifications-grpc.controller.js';

/*
 * The microservice topology in-process, over REAL gRPC (notifications.v1 protos, loopback):
 *   gateway: NotificationsGrpcAdapter (GrpcClientsModule client, deadline, breaker)
 *     → grpc-js + proto-loader (defaults: true) →
 *   notifications-service: NotificationsGrpcController → (fake) QueryBus / CommandBus.
 * The query bus answers with what the LOCAL path returns (the real `toNotificationPage` mapper),
 * so each test proves the remote adapter returns the local adapter's exact shape: map<string,
 * string> data, Timestamp → Date, bool defaults, `nextPageState` absent on the last page.
 */

const commandBus = { execute: vi.fn() };
const queryBus = { execute: vi.fn() };

@Module({
  imports: [ClsModule.forRoot({ global: true })],
  controllers: [NotificationsGrpcController],
  providers: [
    { provide: CommandBus, useValue: commandBus },
    { provide: QueryBus, useValue: queryBus },
  ],
})
class NotificationsServiceTestModule {}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('No free port');
  return address.port;
}

describe('notifications over gRPC (NotificationsGrpcAdapter ↔ NotificationsGrpcController)', () => {
  let server: INestMicroservice;
  let gateway: TestingModule;
  let adapter: NotificationsGrpcAdapter;

  beforeAll(async () => {
    const port = await freePort();
    vi.stubEnv('NOTIFICATIONS_GRPC_URL', `127.0.0.1:${port}`);
    vi.stubEnv('GRPC_DEADLINE_MS', '3000');
    server = await NestFactory.createMicroservice(NotificationsServiceTestModule, {
      ...createGrpcServerStrategy(grpcConfig.parse({ GRPC_URL: `127.0.0.1:${port}` }), [
        'notifications',
      ]),
      logger: false,
    });
    await server.listen();

    gateway = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(), GrpcClientsModule.register(['notifications'])],
      providers: [NotificationsGrpcAdapter],
    }).compile();
    gateway.useLogger(false);
    await gateway.init();
    adapter = gateway.get(NotificationsGrpcAdapter);
  });

  afterAll(async () => {
    await gateway?.close();
    await server?.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    commandBus.execute.mockReset();
    queryBus.execute.mockReset();
  });

  it('ListNotifications: same shape as the local path, next page state carried', async () => {
    const local = toNotificationPage({
      items: [
        makeNotificationProps({ type: 'welcome', data: {} }),
        makeNotificationProps({ read: true, data: { paymentId: generateId(), amount: '25.00' } }),
      ],
      pageState: 'c0ffee',
    });
    queryBus.execute.mockResolvedValue(local);

    const remote = await adapter.list({ userId: USER_ID, limit: 2 });

    expect(remote).toEqual(local);
    expect(remote.items[0]?.createdAt).toBeInstanceOf(Date);
    expect(remote.items[0]?.read).toBe(false);
    expect(queryBus.execute).toHaveBeenCalledWith(new ListNotificationsQuery(USER_ID, 2));
    // proto-loader's null for the absent page_state must reach the query as undefined.
    const [query] = queryBus.execute.mock.calls[0] as [ListNotificationsQuery];
    expect(query.pageState).toBeUndefined();
  });

  it('ListNotifications: the last page has no nextPageState key (like the local adapter)', async () => {
    const local = toNotificationPage({ items: [], pageState: null });
    queryBus.execute.mockResolvedValue(local);

    const remote = await adapter.list({ userId: USER_ID, limit: 0, pageState: 'c0ffee' });

    expect(remote).toEqual({ items: [] });
    expect(Object.keys(remote)).toEqual(Object.keys(local));
    expect(queryBus.execute).toHaveBeenCalledWith(new ListNotificationsQuery(USER_ID, 0, 'c0ffee'));
  });

  it('MarkNotificationRead: dispatches the command; NOT_FOUND keeps its domain code', async () => {
    const notificationId = generateId();
    commandBus.execute.mockResolvedValueOnce(undefined);
    await expect(adapter.markRead({ userId: USER_ID, notificationId })).resolves.toBeUndefined();
    expect(commandBus.execute).toHaveBeenCalledWith(
      new MarkNotificationReadCommand(USER_ID, notificationId),
    );

    commandBus.execute.mockRejectedValueOnce(new NotificationNotFoundException(notificationId));
    await expect(adapter.markRead({ userId: USER_ID, notificationId })).rejects.toMatchObject({
      httpStatus: 404,
      code: 'NOTIFICATION_NOT_FOUND',
    });
  });

  it('a malformed page state is rejected by the zod pipe (INVALID_ARGUMENT) before the bus', async () => {
    const error = await adapter
      .list({ userId: USER_ID, limit: 5, pageState: 'not hex!' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainValidationException);
    expect(queryBus.execute).not.toHaveBeenCalled();
  });
});
