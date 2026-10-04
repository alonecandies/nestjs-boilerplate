import { AccessTokenDenylist, AuthModule, Role, TokenService } from '@app/auth';
import { AppConfigModule } from '@app/config';
import { Test } from '@nestjs/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedisModule } from '../../../test/support/edge-test-app.js';
import { createFakePort, USER_ID } from '../../../test/support/fixtures.js';
import { NOTIFICATIONS_WS_EVENTS, userRoom } from '../../notifications.constants.js';
import type { NotificationResponse } from '../http/notifications.dto.js';
import {
  NotificationsGateway,
  type NotificationsNamespace,
  type NotificationsSocket,
  WS_REVOCATION_SWEEP_INTERVAL_MS,
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
    emit: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
}

const nowSec = (): number => Math.floor(Date.now() / 1_000);

function authedSocket(user: { jti?: string; exp?: number } = {}) {
  const socket = fakeSocket({});
  socket.data.user = {
    id: USER_ID,
    email: 'a@b.io',
    roles: [],
    permissions: [],
    jti: user.jti ?? 'jti-1',
    exp: user.exp ?? nowSec() + 900,
  };
  return socket;
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

  afterEach(() => {
    gateway.onModuleDestroy();
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
    afterEach(() => {
      vi.useRealTimers();
    });

    it('joins the user room', async () => {
      const socket = authedSocket();
      await gateway.handleConnection(socket);
      expect(socket.join).toHaveBeenCalledWith(userRoom(USER_ID));
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('disconnects the socket when its access token expires (TOKEN_EXPIRED exception first)', async () => {
      vi.useFakeTimers();
      const socket = authedSocket({ exp: nowSec() + 60 });
      await gateway.handleConnection(socket);

      vi.advanceTimersByTime(59_000);
      expect(socket.disconnect).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_000);
      expect(socket.emit).toHaveBeenCalledWith(
        NOTIFICATIONS_WS_EVENTS.EXCEPTION,
        expect.objectContaining({ status: 401, code: 'TOKEN_EXPIRED' }),
      );
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('clears the expiry timer when the socket disconnects first', async () => {
      vi.useFakeTimers();
      const socket = authedSocket({ exp: nowSec() + 60 });
      await gateway.handleConnection(socket);

      gateway.handleDisconnect(socket);
      vi.advanceTimersByTime(120_000);

      expect(vi.getTimerCount()).toBe(0);
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('never keeps an anonymous socket', async () => {
      const socket = fakeSocket({});
      await gateway.handleConnection(socket);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(socket.join).not.toHaveBeenCalled();
    });
  });

  describe('revocation sweep (logout → denylist)', () => {
    const serve = (...sockets: NotificationsSocket[]) =>
      Object.assign(gateway, { server: { sockets: new Map(sockets.map((x, i) => [`s${i}`, x])) } });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('disconnects only the sockets whose token was revoked, with a TOKEN_REVOKED exception', async () => {
      const revokedTab = authedSocket({ jti: 'revoked' });
      const revokedOtherTab = authedSocket({ jti: 'revoked' });
      const live = authedSocket({ jti: 'live' });
      serve(revokedTab, revokedOtherTab, live, fakeSocket({}));
      await denylist.deny('revoked', nowSec() + 900);

      await expect(gateway.disconnectRevokedSockets()).resolves.toBe(2);

      for (const socket of [revokedTab, revokedOtherTab]) {
        expect(socket.emit).toHaveBeenCalledWith(
          NOTIFICATIONS_WS_EVENTS.EXCEPTION,
          expect.objectContaining({ status: 401, code: 'TOKEN_REVOKED' }),
        );
        expect(socket.disconnect).toHaveBeenCalledWith(true);
      }
      expect(live.disconnect).not.toHaveBeenCalled();
    });

    it('keeps every socket when the denylist cannot answer (next sweep retries)', async () => {
      const socket = authedSocket({ jti: 'any' });
      serve(socket);
      vi.spyOn(denylist, 'isDenied').mockRejectedValueOnce(new Error('Redis down'));

      await expect(gateway.disconnectRevokedSockets()).resolves.toBe(0);
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('runs on an interval started by afterInit and stopped on module destroy', async () => {
      vi.useFakeTimers();
      const socket = authedSocket({ jti: 'logged-out' });
      serve(socket);
      gateway.afterInit({ use: vi.fn() } as unknown as NotificationsNamespace);
      await denylist.deny('logged-out', nowSec() + 900);

      await vi.advanceTimersByTimeAsync(WS_REVOCATION_SWEEP_INTERVAL_MS);
      expect(socket.disconnect).toHaveBeenCalledWith(true);

      gateway.onModuleDestroy();
      expect(vi.getTimerCount()).toBe(0);
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
