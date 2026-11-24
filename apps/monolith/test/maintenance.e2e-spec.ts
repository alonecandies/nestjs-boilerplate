/*
 * Maintenance mode over the WebSocket transports (monolith, ARCH-2, B2-18, B2-19).
 *
 * The boot boolean: with `MAINTENANCE_MODE=true` a graphql-ws connection is refused, a Socket.IO
 * handshake gets `connect_error` carrying the 503 problem, and the probes still answer. The
 * sockets carry a VALID access token: only the switch can be the reason they are refused. The
 * rest of the REST surface is covered by the middleware spec in `@platform/common`.
 *
 * The run-time switch: the real `AppModule` with `MAINTENANCE_MODE` replaced by a function the
 * spec flips while the app runs (the boot env says off). With the switch off, a Socket.IO socket
 * and a graphql-ws subscription connect and receive a push. Once it turns on, with no restart:
 * `markRead` is answered with the 503 problem and marks nothing, a push reaches no socket while
 * the Kafka push consumer's handler still resolves (through the real RPC pipeline, no dead
 * letter), the open subscription is closed (4403) at its next event, and new connections are
 * refused.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV, {
    MAINTENANCE_MODE: 'true',
    // The per-IP handshake cap stays out of the way.
    THROTTLE_WS_HANDSHAKE_LIMIT: '100000',
    THROTTLE_WS_SOCKETS_PER_USER: '1000',
  });
});

import type { EventEmitter } from 'node:events';
import { refreshTokenConfig } from '@domain/identity';
import { TokenIssuer } from '@domain/identity/testing';
import { notificationCreatedTrigger } from '@domain/notifications/api';
import { NOTIFICATION_CREATED_EVENT } from '@domain/notifications-contracts';
import { JwtService } from '@nestjs/jwt';
import { generateId } from '@platform/common';
import { authConfig } from '@platform/config';
import { createEventEnvelope } from '@platform/contracts';
import { GRAPHQL_PUB_SUB } from '@platform/graphql';
import {
  collectEvents,
  GraphqlWsClients,
  type GraphqlWsCollector,
  type GraphqlWsConnection,
  listenOnLoopback,
  refused,
  SocketClients,
  waitUntil,
} from '@platform/testing/realtime';
import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

describe('maintenance mode on the WebSocket transports (monolith, ARCH-2)', () => {
  let e2e: MonolithE2e;
  let wsUrl = '';
  let token = '';
  const sockets = new SocketClients('/notifications');
  const graphqlWs = new GraphqlWsClients();

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
    ({ wsUrl } = await listenOnLoopback(e2e.app));
    const issuer = new TokenIssuer(
      new JwtService(),
      authConfig.parse(),
      refreshTokenConfig.parse(),
    );
    ({ token } = await issuer.issueAccessToken({
      id: generateId(),
      email: 'maintenance@example.com',
      tenantId: generateId(),
      roles: ['member'],
    }));
  });

  afterAll(async () => {
    sockets.closeAll();
    await graphqlWs.disposeAll();
    await e2e?.app.close();
  });

  it('refuses a graphql-ws connection that carries a valid token', async () => {
    const connection = graphqlWs.open(wsUrl, {
      connectionParams: { authorization: `Bearer ${token}` },
    });

    await expect(connection.acknowledgement()).rejects.toThrow(/closed before the acknowledgement/);
    expect(connection.open).toBe(false);
  });

  it('fails a Socket.IO handshake with connect_error carrying status 503', async () => {
    const refusal = await refused(sockets.open(wsUrl, { token }));

    expect(refusal.data).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
  });

  it('keeps /health/live answering', async () => {
    const response = await e2e.app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
  });

  it('still answers REST with 503, so the switch is on for every transport', async () => {
    const response = await e2e.app.inject({ method: 'GET', url: '/v1/notifications' });

    expect(response.statusCode).toBe(503);
  });
});

interface Tokens {
  accessToken: string;
  tenantId: string;
  user: { id: string };
}
interface Problem {
  status: number;
  code: string;
}
type Ack = { ok: true } | { ok: false; error: Problem };
interface Created {
  notificationCreated: { id: string; title: string };
}

const SUBSCRIBE = 'subscription { notificationCreated { id title } }';

describe('maintenance switched at run time on the WebSocket transports (monolith)', () => {
  const maintenance = { on: false };
  let e2e: MonolithE2e;
  let wsUrl = '';
  let session: Tokens;
  const sockets = new SocketClients('/notifications');
  const graphqlWs = new GraphqlWsClients();
  // Opened while the switch is off, kept across the cases below.
  let socket: Socket;
  let pushes: { readonly received: unknown[] };
  let connection: GraphqlWsConnection;
  let subscription: GraphqlWsCollector<Created>;

  const bearerParams = () => ({
    connectionParams: { authorization: `Bearer ${session.accessToken}` },
  });
  const ack = (event: string, body: unknown): Promise<Ack> =>
    socket.timeout(3_000).emitWithAck(event, body) as Promise<Ack>;
  /**
   * A fence for "nothing arrives": a ping, answered with `pong` (off) or the 503 `exception` (on).
   * The server writes to one websocket in order, so a push sent before the reply has arrived
   * when the reply does. Resolves with the reply's event name and payload.
   */
  const fence = (): Promise<{ event: string; payload: unknown }> =>
    new Promise((resolve) => {
      const reply =
        (event: string) =>
        (payload: unknown): void => {
          socket.off('pong', onPong);
          socket.off('exception', onException);
          resolve({ event, payload });
        };
      const onPong = reply('pong');
      const onException = reply('exception');
      socket.once('pong', onPong);
      socket.once('exception', onException);
      socket.emit('ping');
    });
  const listeners = (trigger: string): number =>
    (e2e.app.get<unknown>(GRAPHQL_PUB_SUB) as { ee: EventEmitter }).ee.listenerCount(trigger);
  /** A notification-created envelope as the broker hands it over (JSON), with a fresh id (dedupe). */
  const envelope = () => {
    const id = generateId();
    const event = createEventEnvelope(
      NOTIFICATION_CREATED_EVENT,
      {
        notificationId: id,
        userId: session.user.id,
        type: 'system',
        title: 'Hello',
        body: 'Hello from the push',
        data: { source: 'e2e' },
        createdAt: '2026-09-01T10:00:00.000Z',
      },
      { id, source: 'notifications-service', tenantId: session.tenantId },
    );
    return JSON.parse(JSON.stringify(event)) as typeof event;
  };
  /** Through the Kafka consumer's full RPC pipeline (global enhancers, dead-letter filter). */
  const deliver = (event: ReturnType<typeof envelope>) =>
    e2e.consumers.deliver(NOTIFICATION_CREATED_EVENT.topic, event);

  beforeAll(async () => {
    // The boot boolean says off: only the function can switch maintenance on.
    vi.stubEnv('MAINTENANCE_MODE', 'false');
    e2e = await createMonolithE2eApp({
      kafkaConsumers: true,
      maintenanceMode: () => maintenance.on,
    });
    ({ wsUrl } = await listenOnLoopback(e2e.app));
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'maintenance.runtime@example.com',
        password: 'correct horse battery staple',
        displayName: 'maintenance',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    session = res.json<Tokens>();
  });

  afterAll(async () => {
    sockets.closeAll();
    await graphqlWs.disposeAll();
    await e2e?.app.close();
    vi.unstubAllEnvs();
  });

  it('with the switch off: a socket and a subscription connect, and a push reaches both', async () => {
    socket = await sockets.connect(wsUrl, { token: session.accessToken });
    pushes = collectEvents(socket, 'notification.created');
    connection = await graphqlWs.connect(wsUrl, bearerParams());
    const trigger = notificationCreatedTrigger(session.tenantId, session.user.id);
    const before = listeners(trigger);
    subscription = connection.subscribe<Created>({ query: SUBSCRIBE });
    await waitUntil(() => listeners(trigger) > before);

    const first = envelope();
    await deliver(first);
    await waitUntil(() => pushes.received.length > 0 && subscription.received.length > 0);

    expect(pushes.received).toHaveLength(1);
    expect(subscription.received).toEqual([
      { notificationCreated: { id: first.id, title: 'Hello' } },
    ]);
    expect((await fence()).event).toBe('pong');
  });

  describe('after the switch turns on, with no restart', () => {
    beforeAll(() => {
      maintenance.on = true;
    });

    it('answers markRead with the 503 problem and marks nothing read', async () => {
      const id = generateId();
      await e2e.notifications.insert({
        id,
        tenantId: session.tenantId,
        userId: session.user.id,
        type: 'system',
        title: 'unread',
        body: 'unread',
        data: {},
        read: false,
        createdAt: new Date(),
      });

      const refusal = await ack('notifications.markRead', { id });

      expect(refusal).toMatchObject({
        ok: false,
        error: { status: 503, code: 'SERVICE_UNAVAILABLE' },
      });
      expect(e2e.notifications.all().find((n) => n.id === id)?.read).toBe(false);
      expect(socket.connected).toBe(true);
    });

    it('answers ping with the 503 problem instead of pong', async () => {
      const reply = await fence();

      expect(reply.event).toBe('exception');
      expect(reply.payload).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    });

    it("pushes to no socket, and the Kafka push consumer's handler still resolves", async () => {
      await expect(deliver(envelope())).resolves.toBeUndefined();
      await fence();

      expect(pushes.received).toHaveLength(1); // only the push from before the switch
      expect(e2e.consumers.deadLetters()).toEqual([]);
    });

    it('closes the open subscription (4403) at its next event and delivers nothing', async () => {
      await deliver(envelope());

      expect(await connection.closedWithin()).toEqual({ code: 4403, reason: 'Forbidden' });
      expect(subscription.received).toHaveLength(1); // only the push from before the switch
    });

    it('refuses new Socket.IO and graphql-ws connections', async () => {
      const refusal = await refused(sockets.open(wsUrl, { token: session.accessToken }));
      const fresh = graphqlWs.open(wsUrl, bearerParams());

      expect(refusal.data).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
      expect(await fresh.closedWithin()).toMatchObject({ code: 4403 });
    });

    it('answers REST with 503 too: one switch for every transport', async () => {
      const response = await e2e.app.inject({ method: 'GET', url: '/v1/notifications' });

      expect(response.statusCode).toBe(503);
    });
  });
});
