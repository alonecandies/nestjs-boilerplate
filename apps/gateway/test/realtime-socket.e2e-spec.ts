/*
 * The Socket.IO gateway over REAL connections (gateway, E-1, AUDIT-F10): the reduced suite (the
 * cases the plan marks G) against the Socket.IO host of the microservices topology. The inbox is
 * the fake notifications-service, so the per-message cases (acks, the mark-read policy) live in the
 * monolith suite, where the notifications core is real; the one message sent here is refused by the
 * session guard before the inbox is reached. No Kafka and no Redis adapter are connected
 * (one process): a push is driven by calling the push consumer with an envelope from
 * `createEventEnvelope`, as the Kafka server would.
 */
await vi.hoisted(async () => {
  const { GATEWAY_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, GATEWAY_E2E_ENV, {
    WS_REVOCATION_SWEEP_INTERVAL_MS: '200',
    // C11's caps stay out of the way.
    THROTTLE_WS_HANDSHAKE_LIMIT: '100000',
    THROTTLE_WS_SOCKETS_PER_USER: '1000',
  });
});

import { refreshTokenConfig } from '@domain/identity';
import { TokenIssuer } from '@domain/identity/testing';
import { NotificationPushConsumer, NotificationsGateway } from '@domain/notifications/api';
import { NOTIFICATION_CREATED_EVENT } from '@domain/notifications-contracts';
import { JwtService } from '@nestjs/jwt';
import type { RevocationSweeper } from '@platform/auth';
import { generateId, type TenantRole } from '@platform/common';
import { authConfig } from '@platform/config';
import { createEventEnvelope } from '@platform/contracts';
import {
  collectEvents,
  connected,
  disconnected,
  listenOnLoopback,
  nextEvent,
  refused,
  SocketClients,
} from '@platform/testing/realtime';
import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGatewayE2eApp, type GatewayE2e } from './support/gateway-e2e-app.js';
import { bearer } from './support/http.js';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  tenantRoles: string[];
  user: { id: string; email: string };
}
interface Problem {
  status: number;
  code: string;
}
type Ack = { ok: true } | { ok: false; error: Problem };

const PASSWORD = 'correct horse battery staple';
/**
 * Revocation is awaited as an event, not raced against a window: this only keeps the helpers'
 * own timer below the e2e project's 30 s test timeout so a miss reports which event never came.
 */
const CLOSE_WAIT_MS = 20_000;
const U_EMAIL = 'ursula.socket@example.com';
const V_EMAIL = 'victor.socket@example.com';
const W_EMAIL = 'wendy.socket@example.com';

describe('Socket.IO gateway over real connections (gateway, E-1)', () => {
  let e2e: GatewayE2e;
  let wsUrl = '';
  const clients = new SocketClients('/notifications');
  let closed = false;
  let tenantA = '';
  let tenantB = '';
  let u: Tokens; // U's registration: personal workspace A
  let v: Tokens;
  let w: Tokens; // W's registration: personal workspace B
  let uA: Tokens; // U acting in A
  let vA: Tokens; // V acting in A
  const issuer = new TokenIssuer(new JwtService(), authConfig.parse(), refreshTokenConfig.parse());

  const post = async (url: string, payload: unknown, token?: string): Promise<Tokens> => {
    const res = await e2e.app.inject({
      method: 'POST',
      url,
      payload: payload as Record<string, unknown>,
      ...(token === undefined ? {} : { headers: bearer(token) }),
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json<Tokens>();
  };
  const register = (email: string) =>
    post('/v1/auth/register', { email, password: PASSWORD, displayName: email.split('@')[0] });
  /** Spends `session`'s access token (denylisted) and returns the tokens of `tenantId`. */
  const switchTo = (session: Tokens, tenantId: string) =>
    post(
      '/v1/auth/switch-tenant',
      { tenantId, refreshToken: session.refreshToken },
      session.accessToken,
    );
  /** A fresh session (its own refresh token) acting in `tenantId`: login lands in the last active one. */
  const sessionIn = async (email: string, tenantId: string): Promise<Tokens> => {
    const session = await post('/v1/auth/login', { email, password: PASSWORD });
    return session.tenantId === tenantId ? session : switchTo(session, tenantId);
  };
  const logout = async (session: Tokens): Promise<void> => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: bearer(session.accessToken),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(204);
  };
  /** `inviter` invites `invitee` (registered as `invitee`) as an admin and the invitee accepts. */
  const makeAdmin = async (inviter: Tokens, invitee: Tokens): Promise<void> => {
    await post(
      '/v1/tenant/invitations',
      { email: invitee.user.email, roles: ['admin'] },
      inviter.accessToken,
    );
    await post(
      '/v1/invitations/accept',
      { token: String(e2e.tenancy.lastTokenFor(invitee.user.email)) },
      invitee.accessToken,
    );
  };
  /** A signed access token of `session`'s user and tenant that lives `ttlSec` seconds (negative: already expired). */
  const tokenLiving = async (session: Tokens, ttlSec: number): Promise<string> =>
    (
      await issuer.issueAccessToken(
        {
          id: session.user.id,
          email: session.user.email,
          tenantId: session.tenantId,
          roles: session.tenantRoles as TenantRole[],
        },
        { ttlSec },
      )
    ).token;

  const connect = (token: string): Promise<Socket> => clients.connect(wsUrl, { token });
  const ack = (socket: Socket, event: string, body: unknown): Promise<Ack> =>
    socket.timeout(3_000).emitWithAck(event, body) as Promise<Ack>;
  /**
   * A barrier for "nothing arrives": a ping answered with a pong. The server emits on one
   * websocket in order, so every push it sent a socket before the pong has been received when
   * the pong is. No fixed wait, and it cannot pass before a late push would have been seen.
   */
  const settle = async (...sockets: Socket[]): Promise<void> => {
    await Promise.all(
      sockets.map((socket) => {
        const pong = nextEvent(socket, 'pong');
        socket.emit('ping');
        return pong;
      }),
    );
  };

  /** What the Kafka server hands the push consumer. */
  const envelopeFor = (tenantId: string, userId: string, id = generateId()) =>
    createEventEnvelope(
      NOTIFICATION_CREATED_EVENT,
      {
        notificationId: id,
        userId,
        type: 'system',
        title: 'Hello',
        body: 'Hello from the push',
        data: { source: 'e2e' },
        createdAt: '2026-09-01T10:00:00.000Z',
      },
      { id, source: 'notifications-service', tenantId },
    );
  const deliver = (envelope: ReturnType<typeof envelopeFor>) =>
    e2e.app.get(NotificationPushConsumer).onNotificationCreated(envelope);
  const restShape = (envelope: ReturnType<typeof envelopeFor>) => ({
    id: envelope.id,
    type: 'system',
    title: 'Hello',
    body: 'Hello from the push',
    read: false,
    data: { source: 'e2e' },
    createdAt: '2026-09-01T10:00:00.000Z',
  });

  beforeAll(async () => {
    e2e = await createGatewayE2eApp();
    ({ wsUrl } = await listenOnLoopback(e2e.app));
    u = await register(U_EMAIL);
    v = await register(V_EMAIL);
    w = await register(W_EMAIL);
    tenantA = u.tenantId;
    tenantB = w.tenantId;
    await makeAdmin(u, v); // V: admin of A
    await makeAdmin(w, u); // U: admin of B
    uA = await sessionIn(U_EMAIL, tenantA);
    vA = await sessionIn(V_EMAIL, tenantA);
  });

  afterAll(async () => {
    clients.closeAll();
    if (!closed) await e2e?.app.close();
  });

  describe('handshake', () => {
    it('refuses a missing token with MISSING_TOKEN', async () => {
      const refusal = await refused(clients.open(wsUrl));
      expect(refusal.data).toMatchObject({ status: 401, code: 'MISSING_TOKEN' });
    });

    it('refuses an expired token with TOKEN_EXPIRED', async () => {
      const expired = await tokenLiving(uA, -60);
      const refusal = await refused(clients.open(wsUrl, { token: expired }));
      expect(refusal.data).toMatchObject({ status: 401, code: 'TOKEN_EXPIRED' });
    });

    it('refuses a denylisted token with TOKEN_REVOKED', async () => {
      const session = await register('revoked.socket@example.com');
      await logout(session);
      const refusal = await refused(clients.open(wsUrl, { token: session.accessToken }));
      expect(refusal.data).toMatchObject({ status: 401, code: 'TOKEN_REVOKED' });
    });

    it('refuses a garbage token with INVALID_TOKEN', async () => {
      const refusal = await refused(clients.open(wsUrl, { token: 'not.a.jwt' }));
      expect(refusal.data).toMatchObject({ status: 401, code: 'INVALID_TOKEN' });
    });

    it('connects with `auth.token` and with the Authorization header, and not with a query token', async () => {
      const viaAuth = await connected(clients.open(wsUrl, { token: uA.accessToken }));
      const viaHeader = await connected(
        clients.open(wsUrl, { headers: { authorization: `Bearer ${uA.accessToken}` } }),
      );
      expect(viaAuth.connected).toBe(true);
      expect(viaHeader.connected).toBe(true);
      const viaQuery = await refused(clients.open(wsUrl, { query: { token: uA.accessToken } }));
      expect(viaQuery.data).toMatchObject({ status: 401, code: 'MISSING_TOKEN' });
    });
  });

  describe('push and rooms', () => {
    it('pushes an (A,U) envelope once to the socket of A, and nothing to U in B or to V in A', async () => {
      const uInA = await connect(uA.accessToken);
      const uInB = await connect((await sessionIn(U_EMAIL, tenantB)).accessToken);
      const vInA = await connect(vA.accessToken);
      const toUA = collectEvents(uInA, 'notification.created');
      const toUB = collectEvents(uInB, 'notification.created');
      const toVA = collectEvents(vInA, 'notification.created');

      const envelope = envelopeFor(tenantA, u.user.id);
      await deliver(envelope);
      await settle(uInA, uInB, vInA);

      expect(toUA.received).toEqual([restShape(envelope)]);
      expect(toUB.received).toEqual([]);
      expect(toVA.received).toEqual([]);

      // The same envelope id again (a Kafka redelivery) pushes nothing.
      await deliver(envelope);
      await settle(uInA);
      expect(toUA.received).toHaveLength(1);
    });

    it('rejects an envelope without tenantId and pushes nothing', async () => {
      const socket = await connect(uA.accessToken);
      const received = collectEvents(socket, 'notification.created');
      const { tenantId: _tenantId, ...withoutTenant } = envelopeFor(tenantA, u.user.id);

      await expect(deliver(withoutTenant as ReturnType<typeof envelopeFor>)).rejects.toThrow();
      await settle(socket);
      expect(received.received).toEqual([]);
    });
  });

  describe('revocation', () => {
    it('closes the socket of a logged-out token within two sweep intervals', async () => {
      const session = await sessionIn(U_EMAIL, tenantA);
      const socket = await connect(session.accessToken);
      const exception = nextEvent<Problem>(socket, 'exception', CLOSE_WAIT_MS);
      const reason = disconnected(socket, CLOSE_WAIT_MS);

      await logout(session);

      expect(await exception).toMatchObject({ status: 401, code: 'TOKEN_REVOKED' });
      expect(await reason).toBe('io server disconnect');
    });

    it('refuses a message sent after the logout and before the sweep with 401 TOKEN_REVOKED', async () => {
      // The sweep is paused, so "before the sweep" is not a race; it resumes and closes the socket.
      // The guard answers before the (fake) inbox is reached.
      const gateway: unknown = e2e.app.get(NotificationsGateway);
      const { sweeper } = gateway as { sweeper: RevocationSweeper };
      const session = await sessionIn(U_EMAIL, tenantA);
      const socket = await connect(session.accessToken);
      sweeper.stop();
      try {
        await logout(session);
        const refusal = await ack(socket, 'notifications.markRead', { id: generateId() });
        expect(refusal).toMatchObject({ ok: false, error: { status: 401, code: 'TOKEN_REVOKED' } });
        expect(socket.connected).toBe(true);
      } finally {
        sweeper.start();
      }
      expect(await disconnected(socket, CLOSE_WAIT_MS)).toBe('io server disconnect');
    });
  });

  describe('tenant switch', () => {
    it('closes the switched-away token, keeps the user’s other session, and moves pushes to the new tenant', async () => {
      const switching = await sessionIn(U_EMAIL, tenantA);
      const other = await sessionIn(U_EMAIL, tenantA); // a second login in A: another jti
      const oldSocket = await connect(switching.accessToken);
      const otherSocket = await connect(other.accessToken);
      const exception = nextEvent<Problem>(oldSocket, 'exception', CLOSE_WAIT_MS);
      const reason = disconnected(oldSocket, CLOSE_WAIT_MS);

      const inB = await switchTo(switching, tenantB);

      expect(await exception).toMatchObject({ status: 401, code: 'TOKEN_REVOKED' });
      expect(await reason).toBe('io server disconnect');

      const newSocket = await connect(inB.accessToken);
      const toNew = collectEvents(newSocket, 'notification.created');
      const toOther = collectEvents(otherSocket, 'notification.created');
      const forB = envelopeFor(tenantB, u.user.id);
      const forA = envelopeFor(tenantA, u.user.id);
      await deliver(forB);
      await deliver(forA);
      await settle(newSocket, otherSocket);

      expect(toNew.received).toEqual([restShape(forB)]);
      expect(toOther.received).toEqual([restShape(forA)]);
      expect(otherSocket.connected).toBe(true);
    });
  });

  describe('teardown', () => {
    it('closes every client and app.close() resolves with the port released', async () => {
      clients.closeAll();
      const server = e2e.app.getHttpServer();
      expect(server.listening).toBe(true);
      closed = true;
      await e2e.app.close();
      expect(server.listening).toBe(false);
    });
  });
});
