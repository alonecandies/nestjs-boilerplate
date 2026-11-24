/*
 * Maintenance mode switched at run time over the WebSocket transports (gateway, B2-18, B2-19): the
 * real `AppModule` with `MAINTENANCE_MODE` replaced by a function the spec flips while the app
 * runs (the boot env says off). With the switch off, a Socket.IO socket and a graphql-ws
 * subscription connect and receive a push. Once it turns on, with no restart: `markRead` is
 * answered with the 503 problem and marks nothing, a push reaches no socket while the push
 * consumer's handler still resolves, the open subscription is closed (4403) at its next event,
 * and new connections are refused. No Kafka is connected: a push is driven by calling the push
 * consumer, as the Kafka server would.
 */
await vi.hoisted(async () => {
  const { GATEWAY_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, GATEWAY_E2E_ENV, {
    // C11's caps stay out of the way.
    THROTTLE_WS_HANDSHAKE_LIMIT: '100000',
    THROTTLE_WS_SOCKETS_PER_USER: '1000',
  });
});

import type { EventEmitter } from 'node:events';
import { NotificationPushConsumer, notificationCreatedTrigger } from '@domain/notifications/api';
import { NOTIFICATION_CREATED_EVENT } from '@domain/notifications-contracts';
import { generateId } from '@platform/common';
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
import { createGatewayE2eApp, type GatewayE2e } from './support/gateway-e2e-app.js';

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

describe('maintenance switched at run time on the WebSocket transports (gateway)', () => {
  const maintenance = { on: false };
  let e2e: GatewayE2e;
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
  /** What the Kafka server hands the push consumer: a fresh event id each time (dedupe). */
  const envelope = () => {
    const id = generateId();
    return createEventEnvelope(
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
  };
  const deliver = (event: ReturnType<typeof envelope>) =>
    e2e.app.get(NotificationPushConsumer).onNotificationCreated(event);

  beforeAll(async () => {
    e2e = await createGatewayE2eApp({ maintenanceMode: () => maintenance.on });
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
      const unread = e2e.notifications.add({
        tenantId: session.tenantId,
        userId: session.user.id,
        type: 'system',
        title: 'unread',
        body: 'unread',
        data: {},
      });

      const refusal = await ack('notifications.markRead', { id: unread.id });

      expect(refusal).toMatchObject({
        ok: false,
        error: { status: 503, code: 'SERVICE_UNAVAILABLE' },
      });
      expect(unread.read).toBe(false);
      expect(socket.connected).toBe(true);
    });

    it('answers ping with the 503 problem instead of pong', async () => {
      const reply = await fence();

      expect(reply.event).toBe('exception');
      expect(reply.payload).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    });

    it("pushes to no socket, and the push consumer's handler still resolves", async () => {
      await expect(deliver(envelope())).resolves.toBeUndefined();
      await fence();

      expect(pushes.received).toHaveLength(1); // only the push from before the switch
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
