import { AccessTokenDenylist, AuthModule, Role, TokenService } from '@app/auth';
import { AppConfigModule } from '@app/config';
import { Test } from '@nestjs/testing';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedisModule } from '../../../test/support/edge-test-app.js';
import { createFakePort, USER_ID } from '../../../test/support/fixtures.js';
import { NOTIFICATIONS_WS_EVENTS, userRoom } from '../../notifications.constants.js';
import type { NotificationResponse } from '../http/notifications.dto.js';
import {
  NotificationsGateway,
  type NotificationsNamespace,
  type NotificationsSocket,
} from './notifications.gateway.js';

const NOTIFICATION_ID = '01920000-0000-7000-8000-00000000abcd';

function fakeSocket(handshake: {
  auth?: Record<string, unknown>;
  headers?: Record<string, string>;
}) {
  return {
    id: 'socket-1',
    data: {},
    handshake: { auth: {}, headers: {}, ...handshake },
    join: vi.fn(async () => undefined),
    emit: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as NotificationsSocket & {
    join: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
}

describe('NotificationsGateway', () => {
  const port = createFakePort();
  // Real TokenService + denylist (in-memory Redis): real signatures and revocation checks.
  let tokens: TokenService;
  let denylist: AccessTokenDenylist;
  let gateway: NotificationsGateway;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        FakeRedisModule,
        AuthModule.forRootAsync({ globalGuards: false }),
      ],
    }).compile();
    tokens = moduleRef.get(TokenService);
    denylist = moduleRef.get(AccessTokenDenylist);
  });

  beforeEach(() => {
    gateway = new NotificationsGateway(tokens, denylist, port);
  });

  describe('handshake authentication (namespace middleware)', () => {
    const accessToken = () =>
      tokens.issueAccessToken({ id: USER_ID, email: 'a@b.io', roles: [Role.User] });

    it('installs itself as namespace middleware and accepts a valid token (auth.token)', async () => {
      const use = vi.fn();
      gateway.afterInit({ use } as unknown as NotificationsNamespace);
      const middleware = use.mock.calls[0]?.[0] as (
        s: unknown,
        next: (e?: unknown) => void,
      ) => void;

      const socket = fakeSocket({ auth: { token: (await accessToken()).token } });
      const next = vi.fn();
      middleware(socket, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalled());

      expect(next).toHaveBeenCalledWith(undefined);
      expect(socket.data.user).toMatchObject({ id: USER_ID, roles: [Role.User] });
    });

    it('accepts a Bearer Authorization header too', async () => {
      const socket = fakeSocket({
        headers: { authorization: `Bearer ${(await accessToken()).token}` },
      });
      await expect(gateway.authenticate(socket)).resolves.toBeUndefined();
      expect(socket.data.user?.id).toBe(USER_ID);
    });

    it('refuses a missing token with problem details in connect_error.data', async () => {
      const socket = fakeSocket({});
      const error = await gateway.authenticate(socket);
      expect(error).toBeInstanceOf(Error);
      expect(error?.data).toMatchObject({ status: 401, code: 'MISSING_TOKEN' });
      expect(socket.data.user).toBeUndefined();
    });

    it('refuses a revoked token', async () => {
      const issued = await accessToken();
      await denylist.deny(issued.jti, issued.exp);
      const error = await gateway.authenticate(fakeSocket({ auth: { token: issued.token } }));
      expect(error?.data).toMatchObject({ status: 401, code: 'TOKEN_REVOKED' });
    });

    it('refuses a forged token', async () => {
      const error = await gateway.authenticate(fakeSocket({ auth: { token: 'a.b.c' } }));
      expect(error?.data).toMatchObject({ status: 401 });
    });
  });

  describe('connection', () => {
    it('joins the user room', async () => {
      const socket = fakeSocket({});
      socket.data.user = {
        id: USER_ID,
        email: 'a@b.io',
        roles: [],
        permissions: [],
        jti: 'j',
        exp: 0,
      };
      await gateway.handleConnection(socket);
      expect(socket.join).toHaveBeenCalledWith(userRoom(USER_ID));
    });

    it('never keeps an anonymous socket', async () => {
      const socket = fakeSocket({});
      await gateway.handleConnection(socket);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(socket.join).not.toHaveBeenCalled();
    });
  });

  describe('messages', () => {
    it('notifications.markRead marks the caller notification read and acks { ok: true }', async () => {
      port.markRead.mockResolvedValue(undefined);
      await expect(gateway.markRead({ id: NOTIFICATION_ID }, USER_ID)).resolves.toEqual({
        ok: true,
      });
      expect(port.markRead).toHaveBeenCalledWith({
        userId: USER_ID,
        notificationId: NOTIFICATION_ID,
      });
    });

    it('ping answers with a pong event', () => {
      expect(gateway.ping()).toEqual({
        event: NOTIFICATIONS_WS_EVENTS.PONG,
        data: { ts: expect.any(String) },
      });
    });
  });

  it('pushes notification.created to the user room', () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    Object.assign(gateway, { server: { to } });
    const notification = { id: NOTIFICATION_ID } as NotificationResponse;

    gateway.pushToUser(USER_ID, notification);

    expect(to).toHaveBeenCalledWith(userRoom(USER_ID));
    expect(emit).toHaveBeenCalledWith(NOTIFICATIONS_WS_EVENTS.CREATED, notification);
  });
});
