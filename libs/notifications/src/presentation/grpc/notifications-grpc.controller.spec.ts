import { NOTIFICATIONS_SERVICE_NAME } from '@app/contracts';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { GrpcStatus } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeNotificationPage, USER_ID } from '../../../test/support/fixtures.js';
import { InMemoryGrpcServer } from '../../../test/support/in-memory-grpc.server.js';
import { MarkNotificationReadCommand } from '../../application/commands/mark-notification-read/mark-notification-read.command.js';
import { ListNotificationsQuery } from '../../application/queries/list-notifications/list-notifications.query.js';
import { NotificationNotFoundException } from '../../domain/notification.errors.js';
import { NotificationsGrpcController } from './notifications-grpc.controller.js';

const NOTIFICATION_ID = '01920000-0000-7000-8000-00000000abcd';

describe('NotificationsGrpcController (Nest RPC pipeline)', () => {
  const queryBus = { execute: vi.fn() };
  const commandBus = { execute: vi.fn() };
  const server = new InMemoryGrpcServer();
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsGrpcController],
      providers: [
        { provide: QueryBus, useValue: queryBus },
        { provide: CommandBus, useValue: commandBus },
      ],
    }).compile();
    const microservice = moduleRef.createNestMicroservice({ strategy: server, logger: false });
    await microservice.init();
    close = () => microservice.close();
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(() => {
    queryBus.execute.mockReset();
    commandBus.execute.mockReset();
  });

  // ts-proto's generated decorator registers the camelCase method names (keepCase: false).
  const call = (rpc: string, request: unknown) =>
    server.call(NOTIFICATIONS_SERVICE_NAME, rpc, request);

  it('ListNotifications → ListNotificationsQuery (proto defaults normalised)', async () => {
    const page = makeNotificationPage();
    queryBus.execute.mockResolvedValue(page);

    await expect(
      call('listNotifications', { userId: USER_ID, limit: 0, pageState: '' }),
    ).resolves.toBe(page);

    const [query] = queryBus.execute.mock.calls[0] ?? [];
    expect(query).toBeInstanceOf(ListNotificationsQuery);
    expect(query).toEqual(new ListNotificationsQuery(USER_ID, 0, undefined));
  });

  it('passes a real page state through', async () => {
    queryBus.execute.mockResolvedValue(makeNotificationPage([]));
    await call('listNotifications', { userId: USER_ID, limit: 10, pageState: 'cafe' });
    expect(queryBus.execute.mock.calls[0]?.[0]).toEqual(
      new ListNotificationsQuery(USER_ID, 10, 'cafe'),
    );
  });

  it('INVALID_ARGUMENT (with issues) for a malformed payload; the bus is never called', async () => {
    await expect(
      call('listNotifications', { userId: 'nope', limit: 1000, pageState: null }),
    ).rejects.toMatchObject({ code: GrpcStatus.INVALID_ARGUMENT });
    expect(queryBus.execute).not.toHaveBeenCalled();
  });

  it('MarkNotificationRead → MarkNotificationReadCommand', async () => {
    commandBus.execute.mockResolvedValue(undefined);
    await call('markNotificationRead', { userId: USER_ID, notificationId: NOTIFICATION_ID });
    const [command] = commandBus.execute.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(MarkNotificationReadCommand);
    expect(command).toEqual(new MarkNotificationReadCommand(USER_ID, NOTIFICATION_ID));
  });

  it('maps NotificationNotFoundException to NOT_FOUND with the domain code in the trailers', async () => {
    commandBus.execute.mockRejectedValue(new NotificationNotFoundException(NOTIFICATION_ID));
    const error: unknown = await call('markNotificationRead', {
      userId: USER_ID,
      notificationId: NOTIFICATION_ID,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: GrpcStatus.NOT_FOUND });
    const trailers = (error as { metadata?: { get(key: string): unknown[] } }).metadata;
    expect(trailers?.get('x-error-code')).toEqual(['NOTIFICATION_NOT_FOUND']);
  });
});
