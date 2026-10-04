import { EntityNotFoundException, ServiceUnavailableException, uuidV7Timestamp } from '@app/common';
import { grpcConfig } from '@app/config';
import type { NotificationsServiceClient } from '@app/contracts';
import { createMock } from '@app/testing';
import { createErrorTrailers, GRPC_METADATA_KEYS, type GrpcCircuitBreakers } from '@app/transport';
import type { Metadata } from '@grpc/grpc-js';
import type { ClientGrpc } from '@nestjs/microservices';
import { type Observable, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { asClass, CREATED_AT, USER_ID } from '../../../../test/support/fixtures.js';
import { NotificationsGrpcAdapter } from './notifications-grpc.adapter.js';

const NOTIFICATION_ID = '01920000-0000-7000-8000-00000000abcd';

function setup(
  service: Partial<
    Record<keyof NotificationsServiceClient, (...args: never[]) => Observable<unknown>>
  >,
) {
  const client = createMock<NotificationsServiceClient>(service);
  const grpc = createMock<ClientGrpc>({ getService: () => client });
  const breakers = createMock<GrpcCircuitBreakers>({ get: () => undefined });
  const adapter = new NotificationsGrpcAdapter(
    asClass(grpc),
    grpcConfig.parse({}),
    asClass(breakers),
  );
  adapter.onModuleInit();
  return { adapter, client, grpc };
}

describe('NotificationsGrpcAdapter', () => {
  it('normalises proto-loader nulls to the local adapter shape', async () => {
    const { adapter, client, grpc } = setup({
      listNotifications: () =>
        of({
          items: [
            {
              id: NOTIFICATION_ID,
              userId: USER_ID,
              type: 'welcome',
              title: 'Hi',
              body: '',
              read: false,
              data: null,
              createdAt: CREATED_AT,
            },
            { id: NOTIFICATION_ID, userId: USER_ID, type: null, title: null, createdAt: null },
          ],
          nextPageState: null,
        }),
    });

    const page = await adapter.list({ userId: USER_ID, limit: 2 });

    expect(grpc.getService).toHaveBeenCalledWith('NotificationsService');
    expect(page).toEqual({
      items: [
        {
          id: NOTIFICATION_ID,
          userId: USER_ID,
          type: 'welcome',
          title: 'Hi',
          body: '',
          read: false,
          data: {},
          createdAt: CREATED_AT,
        },
        {
          id: NOTIFICATION_ID,
          userId: USER_ID,
          type: 'system',
          title: '',
          body: '',
          read: false,
          data: {},
          createdAt: uuidV7Timestamp(NOTIFICATION_ID),
        },
      ],
    });
    expect(page).not.toHaveProperty('nextPageState');
    // The caller's user id travels as metadata (the service trusts the edge).
    const metadata = client.listNotifications.mock.calls[0]?.[1] as Metadata;
    expect(metadata.get(GRPC_METADATA_KEYS.USER_ID)).toEqual([USER_ID]);
  });

  it('keeps a non-empty next page state', async () => {
    const { adapter } = setup({
      listNotifications: () => of({ items: null, nextPageState: 'abcd' }),
    });
    await expect(adapter.list({ userId: USER_ID, limit: 2 })).resolves.toEqual({
      items: [],
      nextPageState: 'abcd',
    });
  });

  it('maps NOT_FOUND (with the domain code from the error trailers) to EntityNotFoundException', async () => {
    const trailers = createErrorTrailers({
      code: 'NOTIFICATION_NOT_FOUND',
      details: { entity: 'Notification', id: NOTIFICATION_ID },
    });
    const { adapter } = setup({
      markNotificationRead: () =>
        throwError(() =>
          Object.assign(new Error('5 NOT_FOUND: Notification not found'), {
            code: 5,
            details: 'Notification not found',
            metadata: trailers,
          }),
        ),
    });

    const promise = adapter.markRead({ userId: USER_ID, notificationId: NOTIFICATION_ID });
    await expect(promise).rejects.toBeInstanceOf(EntityNotFoundException);
    await expect(promise).rejects.toMatchObject({
      code: 'NOTIFICATION_NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('maps an unreachable service to 503 without leaking details', async () => {
    const { adapter } = setup({
      listNotifications: () =>
        throwError(() =>
          Object.assign(new Error('14 UNAVAILABLE: connect ECONNREFUSED 10.0.0.7:50052'), {
            code: 14,
            details: 'connect ECONNREFUSED 10.0.0.7:50052',
          }),
        ),
    });
    const promise = adapter.list({ userId: USER_ID, limit: 2 });
    await expect(promise).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(promise).rejects.not.toMatchObject({
      message: expect.stringContaining('10.0.0.7'),
    });
  });
});
