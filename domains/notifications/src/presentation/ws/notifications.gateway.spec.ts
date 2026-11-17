import { Test } from '@nestjs/testing';
import { AccessTokenDenylist, AuthModule, TokenService } from '@platform/auth';
import { signTestAccessToken } from '@platform/auth/testing';
import { AppConfigModule, type AuthConfig, authConfig } from '@platform/config';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedisModule } from '../../../test/support/edge-test-app.js';
import {
  createFakePort,
  OTHER_TENANT_ID,
  OTHER_USER_ID,
  TENANT_ID,
  USER_ID,
} from '../../../test/support/fixtures.js';
import { NOTIFICATIONS_WS_EVENTS, tenantUserRoom } from '../../notifications.constants.js';
import type { NotificationResponse } from '../http/notifications.dto.js';
import {
  NotificationsGateway,
  type NotificationsNamespace,
  type NotificationsSocket,
} from './notifications.gateway.js';

const NOTIFICATION_ID = '01920000-0000-7000-8000-00000000abcd';

type FakeSocket = NotificationsSocket & {
  join: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

let socketSeq = 0;

function fakeSocket(handshake: {
  auth?: Record<string, unknown>;
  headers?: Record<string, string>;
}): FakeSocket {
  socketSeq += 1;
  return {
    id: `socket-${socketSeq}`,
    data: {},
    handshake: { auth: {}, headers: {}, ...handshake },
    join: vi.fn(async () => undefined),
    emit: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as FakeSocket;
}

const nowSec = (): number => Math.floor(Date.now() / 1_000);

function authedSocket(
  user: { jti?: string; exp?: number; tenantId?: string; userId?: string } = {},
): FakeSocket {
  const socket = fakeSocket({});
  socket.data.user = {
    id: user.userId ?? USER_ID,
    email: 'a@b.io',
    tenantId: user.tenantId ?? TENANT_ID,
    roles: [],
    staff: false,
    permissions: [],
    jti: user.jti ?? 'jti-1',
    exp: user.exp ?? nowSec() + 900,
  };
  return socket;
}

/** `WS_REVOCATION_SWEEP_INTERVAL_MS` as the gateway reads it (`authConfig`). */
const authWithSweepInterval = (intervalMs: number): AuthConfig =>
  authConfig.parse({ ...process.env, WS_REVOCATION_SWEEP_INTERVAL_MS: String(intervalMs) });

/** A namespace whose `to(room).emit` reaches exactly the sockets that joined `room`. */
function serveRooms(gateway: NotificationsGateway, ...sockets: FakeSocket[]) {
  const to = vi.fn((room: string) => ({
    emit: (event: string, data: unknown) => {
      for (const socket of sockets) {
        if (socket.join.mock.calls.some(([joined]) => joined === room)) socket.emit(event, data);
      }
    },
  }));
  Object.assign(gateway, { server: { to } });
  return to;
}

const revokedEmits = (socket: FakeSocket) =>
  socket.emit.mock.calls.filter(
    ([event, problem]) =>
      event === NOTIFICATIONS_WS_EVENTS.EXCEPTION &&
      (problem as { code?: string }).code === 'TOKEN_REVOKED',
  );

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
    gateway = new NotificationsGateway(tokens, denylist, port, authWithSweepInterval(30_000));
  });

  afterEach(() => {
    gateway.onModuleDestroy();
  });

  describe('handshake authentication (namespace middleware)', () => {
    // Signed with the auth namespace of process.env, which AppConfigModule + AuthModule load.
    const accessToken = () =>
      signTestAccessToken({ id: USER_ID, email: 'a@b.io', roles: ['member'] });

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
      expect(socket.data.user).toMatchObject({ id: USER_ID, roles: ['member'] });
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

    it('joins exactly one room, the (tenant, user) room of its token', async () => {
      const socket = authedSocket({ tenantId: TENANT_ID, userId: USER_ID });
      await gateway.handleConnection(socket);
      expect(socket.join).toHaveBeenCalledTimes(1);
      expect(socket.join).toHaveBeenCalledWith(`t:${TENANT_ID}:u:${USER_ID}`);
      expect(tenantUserRoom(TENANT_ID, USER_ID)).toBe(`t:${TENANT_ID}:u:${USER_ID}`);
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

  describe('revocation sweep (logout, tenant switch → denylist)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('disconnects only the sockets whose token was revoked, with a TOKEN_REVOKED exception', async () => {
      const revokedTab = authedSocket({ jti: 'revoked' });
      const revokedOtherTab = authedSocket({ jti: 'revoked' });
      const live = authedSocket({ jti: 'live' });
      for (const socket of [revokedTab, revokedOtherTab, live]) {
        await gateway.handleConnection(socket);
      }
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

    it('tenant switch: the switched-away token closes its socket, the other session stays, the new token joins the new room', async () => {
      const s1 = authedSocket({ jti: 'jti-switch-1', tenantId: TENANT_ID });
      const s2 = authedSocket({ jti: 'jti-switch-2', tenantId: TENANT_ID });
      await gateway.handleConnection(s1);
      await gateway.handleConnection(s2);

      // switch-tenant denylists the access token it was called with.
      await denylist.deny('jti-switch-1', nowSec() + 900);
      await expect(gateway.disconnectRevokedSockets()).resolves.toBe(1);

      expect(revokedEmits(s1)).toHaveLength(1);
      expect(s1.disconnect).toHaveBeenCalledWith(true);
      expect(s2.emit).not.toHaveBeenCalled();
      expect(s2.disconnect).not.toHaveBeenCalled();

      // The token returned by switch-tenant is for B: its socket joins B's room only.
      const issued = await signTestAccessToken({
        id: USER_ID,
        email: 'a@b.io',
        roles: ['member'],
        tenantId: OTHER_TENANT_ID,
      });
      const s3 = fakeSocket({ auth: { token: issued.token } });
      await expect(gateway.authenticate(s3)).resolves.toBeUndefined();
      await gateway.handleConnection(s3);
      expect(s3.join).toHaveBeenCalledTimes(1);
      expect(s3.join).toHaveBeenCalledWith(`t:${OTHER_TENANT_ID}:u:${USER_ID}`);
    });

    it('stops tracking a socket once it disconnects', async () => {
      const socket = authedSocket({ jti: 'gone' });
      await gateway.handleConnection(socket);
      gateway.handleDisconnect(socket);
      await denylist.deny('gone', nowSec() + 900);

      await expect(gateway.disconnectRevokedSockets()).resolves.toBe(0);
      expect(socket.emit).not.toHaveBeenCalled();
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('keeps every socket when the denylist cannot answer (next sweep retries)', async () => {
      const socket = authedSocket({ jti: 'any' });
      await gateway.handleConnection(socket);
      await denylist.deny('any', nowSec() + 900);
      vi.spyOn(denylist, 'isDenied').mockRejectedValueOnce(new Error('Redis down'));

      await expect(gateway.disconnectRevokedSockets()).resolves.toBe(0);
      expect(socket.emit).not.toHaveBeenCalled();
      expect(socket.disconnect).not.toHaveBeenCalled();

      // The next sweep, with the denylist back, closes it.
      await expect(gateway.disconnectRevokedSockets()).resolves.toBe(1);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('sweeps every WS_REVOCATION_SWEEP_INTERVAL_MS (200) from afterInit and stops on module destroy', async () => {
      vi.useFakeTimers();
      gateway = new NotificationsGateway(tokens, denylist, port, authWithSweepInterval(200));
      const first = authedSocket({ jti: 'logged-out-1' });
      const second = authedSocket({ jti: 'logged-out-2' });
      await gateway.handleConnection(first);
      await gateway.handleConnection(second);
      gateway.afterInit({ use: vi.fn() } as unknown as NotificationsNamespace);
      await denylist.deny('logged-out-1', nowSec() + 900);

      await vi.advanceTimersByTimeAsync(199);
      expect(first.disconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(revokedEmits(first)).toHaveLength(1);
      expect(first.disconnect).toHaveBeenCalledWith(true);

      gateway.onModuleDestroy();
      await denylist.deny('logged-out-2', nowSec() + 900);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(second.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('messages', () => {
    it('notifications.markRead marks the caller notification read and acks { ok: true }', async () => {
      port.markRead.mockResolvedValue(undefined);
      const { user } = authedSocket().data;
      if (user === undefined) throw new Error('authedSocket() always sets a user');
      await expect(gateway.markRead({ id: NOTIFICATION_ID }, user)).resolves.toEqual({
        ok: true,
      });
      // The inbox is the caller's (tenant, user) pair, both taken from the authenticated socket.
      expect(port.markRead).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
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

  describe('pushes', () => {
    it('emits notification.created to the (tenant, user) room only', async () => {
      const own = authedSocket({ tenantId: TENANT_ID, userId: USER_ID });
      const ownInOtherTenant = authedSocket({ tenantId: OTHER_TENANT_ID, userId: USER_ID });
      const otherUser = authedSocket({ tenantId: TENANT_ID, userId: OTHER_USER_ID });
      const to = serveRooms(gateway, own, ownInOtherTenant, otherUser);
      for (const socket of [own, ownInOtherTenant, otherUser]) {
        await gateway.handleConnection(socket);
      }
      const notification = { id: NOTIFICATION_ID } as NotificationResponse;

      gateway.pushToUser(TENANT_ID, USER_ID, notification);

      expect(to).toHaveBeenCalledTimes(1);
      expect(to).toHaveBeenCalledWith(`t:${TENANT_ID}:u:${USER_ID}`);
      expect(own.emit).toHaveBeenCalledTimes(1);
      expect(own.emit).toHaveBeenCalledWith(NOTIFICATIONS_WS_EVENTS.CREATED, notification);
      expect(ownInOtherTenant.emit).not.toHaveBeenCalled();
      expect(otherUser.emit).not.toHaveBeenCalled();
    });
  });
});

const capsSocket = () => ({
  data: {} as Record<string, unknown>,
  handshake: { auth: { token: 't' }, headers: {}, address: '1.2.3.4' },
  request: { socket: { remoteAddress: '1.2.3.4' }, headers: {} },
  join: vi.fn(),
});

describe('NotificationsGateway connection caps', () => {
  const tokens = {
    verifyAccessToken: vi.fn(async () => ({ jti: 'j', exp: Math.floor(Date.now() / 1000) + 60 })),
    toAuthUser: vi.fn(() => ({ id: 'u-1', exp: Math.floor(Date.now() / 1000) + 60 })),
  };
  const denylist = { isDenied: vi.fn(async () => false) };
  const gatewayWith = (caps: unknown) =>
    new NotificationsGateway(
      tokens as never,
      denylist as never,
      {} as never,
      authWithSweepInterval(30_000),
      caps as never,
    );

  it('refuses a handshake over the per-IP limit with a 429 problem (connect_error data)', async () => {
    const caps = {
      admitHandshake: vi.fn(async () => ({ ok: false as const, retryAfterSeconds: 7 })),
      acquireSocket: vi.fn(),
      releaseSocket: vi.fn(),
    };
    const error = await gatewayWith(caps).authenticate(capsSocket() as never);
    expect(error?.data).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(caps.admitHandshake).toHaveBeenCalledWith('1.2.3.4');
    expect(caps.acquireSocket).not.toHaveBeenCalled();
  });

  it('refuses the socket past the per-user cap with TOO_MANY_CONNECTIONS', async () => {
    const caps = {
      admitHandshake: vi.fn(async () => ({ ok: true as const })),
      acquireSocket: vi.fn(async () => false),
      releaseSocket: vi.fn(),
    };
    const error = await gatewayWith(caps).authenticate(capsSocket() as never);
    expect(error?.data).toMatchObject({ status: 429, code: 'TOO_MANY_CONNECTIONS' });
  });

  it('accepts under the caps and releases the slot once, on disconnect', async () => {
    const caps = {
      admitHandshake: vi.fn(async () => ({ ok: true as const })),
      acquireSocket: vi.fn(async () => true),
      releaseSocket: vi.fn(async () => undefined),
    };
    const gateway = gatewayWith(caps);
    const socket = capsSocket();
    await expect(gateway.authenticate(socket as never)).resolves.toBeUndefined();
    expect(caps.acquireSocket).toHaveBeenCalledWith('u-1');
    gateway.handleDisconnect(socket as never);
    expect(caps.releaseSocket).toHaveBeenCalledWith('u-1');
  });

  it('does not release a slot for a socket that never acquired one', () => {
    const caps = { admitHandshake: vi.fn(), acquireSocket: vi.fn(), releaseSocket: vi.fn() };
    const socket = capsSocket();
    socket.data.user = { id: 'u-1' };
    gatewayWith(caps).handleDisconnect(socket as never);
    expect(caps.releaseSocket).not.toHaveBeenCalled();
  });
});
