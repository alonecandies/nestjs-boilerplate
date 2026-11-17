import { NOTIFICATIONS_SERVICE_NAME, type Notification } from '@domain/notifications-contracts';
import { CommandBus, CqrsModule, QueryBus } from '@nestjs/cqrs';
import { GrpcStatus } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { createOutgoingMetadata } from '@platform/transport';
import { ClsModule } from 'nestjs-cls';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeNotificationPage,
  makeNotificationProps,
  OTHER_TENANT_ID,
  OTHER_USER_ID,
  TENANT_ID,
  USER_ID,
} from '../../../test/support/fixtures.js';
import { InMemoryGrpcServer } from '../../../test/support/in-memory-grpc.server.js';
import { MarkNotificationReadCommand } from '../../application/commands/mark-notification-read/mark-notification-read.command.js';
import { MarkNotificationReadHandler } from '../../application/commands/mark-notification-read/mark-notification-read.handler.js';
import { NotificationsRepository } from '../../application/ports/notifications.repository.js';
import { ListNotificationsHandler } from '../../application/queries/list-notifications/list-notifications.handler.js';
import { ListNotificationsQuery } from '../../application/queries/list-notifications/list-notifications.query.js';
import { NotificationNotFoundException } from '../../domain/notification.errors.js';
import { InMemoryNotificationsRepository } from '../../testing/in-memory-notifications.repository.js';
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
      call('listNotifications', { tenantId: TENANT_ID, userId: USER_ID, limit: 0, pageState: '' }),
    ).resolves.toBe(page);

    const [query] = queryBus.execute.mock.calls[0] ?? [];
    expect(query).toBeInstanceOf(ListNotificationsQuery);
    expect(query).toEqual(new ListNotificationsQuery(TENANT_ID, USER_ID, 0, undefined));
  });

  it('passes a real page state through', async () => {
    queryBus.execute.mockResolvedValue(makeNotificationPage([]));
    await call('listNotifications', {
      tenantId: TENANT_ID,
      userId: USER_ID,
      limit: 10,
      pageState: 'cafe',
    });
    expect(queryBus.execute.mock.calls[0]?.[0]).toEqual(
      new ListNotificationsQuery(TENANT_ID, USER_ID, 10, 'cafe'),
    );
  });

  it('INVALID_ARGUMENT (with issues) for a malformed payload; the bus is never called', async () => {
    await expect(
      call('listNotifications', {
        tenantId: TENANT_ID,
        userId: 'nope',
        limit: 1000,
        pageState: null,
      }),
    ).rejects.toMatchObject({ code: GrpcStatus.INVALID_ARGUMENT });
    expect(queryBus.execute).not.toHaveBeenCalled();
  });

  // proto-loader hands an absent proto3 `optional` over as null; a hand-built request may omit it.
  it.each([
    ['missing', {}],
    ['null', { tenantId: null }],
    ['empty', { tenantId: '' }],
    ['malformed', { tenantId: 'acme' }],
  ])('INVALID_ARGUMENT for a %s tenant_id on both requests; no bus call', async (_, tenant) => {
    await expect(
      call('listNotifications', { ...tenant, userId: USER_ID, limit: 5 }),
    ).rejects.toMatchObject({ code: GrpcStatus.INVALID_ARGUMENT });
    await expect(
      call('markNotificationRead', { ...tenant, userId: USER_ID, notificationId: NOTIFICATION_ID }),
    ).rejects.toMatchObject({ code: GrpcStatus.INVALID_ARGUMENT });
    expect(queryBus.execute).not.toHaveBeenCalled();
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it('MarkNotificationRead → MarkNotificationReadCommand', async () => {
    commandBus.execute.mockResolvedValue(undefined);
    await call('markNotificationRead', {
      tenantId: TENANT_ID,
      userId: USER_ID,
      notificationId: NOTIFICATION_ID,
    });
    const [command] = commandBus.execute.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(MarkNotificationReadCommand);
    expect(command).toEqual(new MarkNotificationReadCommand(TENANT_ID, USER_ID, NOTIFICATION_ID));
  });

  it('maps NotificationNotFoundException to NOT_FOUND with the domain code in the trailers', async () => {
    commandBus.execute.mockRejectedValue(new NotificationNotFoundException(NOTIFICATION_ID));
    const error: unknown = await call('markNotificationRead', {
      tenantId: TENANT_ID,
      userId: USER_ID,
      notificationId: NOTIFICATION_ID,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: GrpcStatus.NOT_FOUND });
    const trailers = (error as { metadata?: { get(key: string): unknown[] } }).metadata;
    expect(trailers?.get('x-error-code')).toEqual(['NOTIFICATION_NOT_FOUND']);
  });
});

describe('NotificationsGrpcController with the real handlers (principal from metadata)', () => {
  const server = new InMemoryGrpcServer();
  const repository = new InMemoryNotificationsRepository();
  let close: () => Promise<void>;
  // U has n1 in tenant A; the same id space holds V's and B's inboxes, which A/U must never reach.
  const n1 = makeNotificationProps({ tenantId: TENANT_ID, userId: USER_ID, createdAt: new Date() });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot(), ClsModule.forRoot({ global: true })],
      controllers: [NotificationsGrpcController],
      providers: [
        { provide: NotificationsRepository, useValue: repository },
        ListNotificationsHandler,
        MarkNotificationReadHandler,
      ],
    }).compile();
    const microservice = moduleRef.createNestMicroservice({ strategy: server, logger: false });
    await microservice.init();
    close = () => microservice.close();
    await repository.insert(n1);
    await repository.insert(makeNotificationProps({ tenantId: OTHER_TENANT_ID, userId: USER_ID }));
    await repository.insert(makeNotificationProps({ tenantId: TENANT_ID, userId: OTHER_USER_ID }));
  });

  afterAll(async () => {
    await close();
  });

  /** Caller metadata for the principal (A, U), as the gateway adapter sends it. */
  const asAU = () =>
    createOutgoingMetadata({ userId: USER_ID, tenantId: TENANT_ID, roles: ['member'] });
  const call = (rpc: string, request: unknown) =>
    server.call(NOTIFICATIONS_SERVICE_NAME, rpc, request, asAU());

  it('lists the (A, U) inbox only; every item carries its tenant_id', async () => {
    const page = (await call('listNotifications', {
      tenantId: TENANT_ID,
      userId: USER_ID,
      limit: 10,
    })) as { items: Notification[] };
    expect(page.items.map((item) => item.id)).toEqual([n1.id]);
    for (const item of page.items) expect(item.tenantId).toBe(TENANT_ID);
  });

  it.each([
    ['(B, U)', OTHER_TENANT_ID, USER_ID],
    ['(A, V)', TENANT_ID, OTHER_USER_ID],
  ])('PERMISSION_DENIED TENANT_MISMATCH when (A, U) asks for %s', async (_, tenantId, userId) => {
    for (const [rpc, request] of [
      ['listNotifications', { tenantId, userId, limit: 10 }],
      ['markNotificationRead', { tenantId, userId, notificationId: n1.id }],
    ] as const) {
      const error: unknown = await call(rpc, request).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: GrpcStatus.PERMISSION_DENIED });
      const trailers = (error as { metadata?: { get(key: string): unknown[] } }).metadata;
      expect(trailers?.get('x-error-code')).toEqual(['TENANT_MISMATCH']);
    }
    await expect(repository.findRecentByUser(TENANT_ID, USER_ID, 10)).resolves.toEqual([
      expect.objectContaining({ id: n1.id, read: false }),
    ]);
  });
});
