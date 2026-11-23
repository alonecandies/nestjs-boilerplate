/*
 * The graphql-ws transport over REAL connections (monolith, E-2, AUDIT-F11): `createClient` from
 * graphql-ws against the listening monolith app, whose notifications core is real (in-memory
 * repositories). Covers `connection_init` authentication, delivery, the 4401 and 4403 closes, the
 * tenant and user filters, the jti sweep including a real tenant switch, and the complexity check
 * on the WebSocket path. No Kafka and no Redis are connected (one process): a push is driven by
 * calling the push consumer with an envelope from `createEventEnvelope`, as the Kafka server
 * would. Not covered: the 10 s `connection_init` timeout (4408) and C11's caps (their limits are
 * set high here; C12 owns C's e2e).
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV, {
    WS_REVOCATION_SWEEP_INTERVAL_MS: '200',
    // One notifications query costs about 7 (5 + items + id); four aliased copies exceed 20.
    GRAPHQL_MAX_COMPLEXITY: '20',
    // C11's caps stay out of the way.
    THROTTLE_WS_HANDSHAKE_LIMIT: '100000',
    THROTTLE_WS_SOCKETS_PER_USER: '1000',
  });
});

import type { EventEmitter } from 'node:events';
import { refreshTokenConfig } from '@domain/identity';
import { TokenIssuer } from '@domain/identity/testing';
import {
  CreateNotificationCommand,
  PublishNotificationCreatedCommand,
  toNotificationProps,
} from '@domain/notifications';
import { NotificationPushConsumer, notificationCreatedTrigger } from '@domain/notifications/api';
import { NOTIFICATION_CREATED_EVENT } from '@domain/notifications-contracts';
import { CommandBus } from '@nestjs/cqrs';
import { JwtService } from '@nestjs/jwt';
import { generateId, type TenantRole } from '@platform/common';
import { authConfig } from '@platform/config';
import { createEventEnvelope } from '@platform/contracts';
import { GRAPHQL_PUB_SUB } from '@platform/graphql';
import {
  GraphqlWsClients,
  type GraphqlWsClose,
  type GraphqlWsConnection,
  listenOnLoopback,
  waitUntil,
} from '@platform/testing/realtime';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  tenantRoles: string[];
  user: { id: string; email: string };
}
interface Created {
  notificationCreated: { id: string; title: string };
}
interface Inbox {
  notifications: { items: { id: string }[] };
}

const PASSWORD = 'correct horse battery staple';
/**
 * Revocation is awaited as an event, not raced against a window: this only keeps the helper's
 * own timer below the e2e project's 30 s test timeout so a miss reports that the socket stayed open.
 */
const CLOSE_WAIT_MS = 20_000;
const SUBSCRIBE = 'subscription { notificationCreated { id title } }';
const INBOX = '{ notifications { items { id } } }';
const U_EMAIL = 'ursula.graphql@example.com';
const V_EMAIL = 'victor.graphql@example.com';
const W_EMAIL = 'wendy.graphql@example.com';

const bearerParams = (token: string) => ({
  connectionParams: { authorization: `Bearer ${token}` },
});

describe('graphql-ws over real connections (monolith, E-2)', () => {
  let e2e: MonolithE2e;
  let wsUrl = '';
  const clients = new GraphqlWsClients();
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
  /** The raw token of the last invitation mail queued for `email`. */
  const mailedToken = (email: string): string => {
    type InvitationJob = { to?: string; context?: { token?: unknown } };
    const job = [...e2e.mailQueue.jobs]
      .reverse()
      .find((j) => j.name === 'tenant-invitation' && (j.data as InvitationJob).to === email);
    return String((job?.data as InvitationJob | undefined)?.context?.token);
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
      { token: mailedToken(invitee.user.email) },
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

  const connect = (token: string): Promise<GraphqlWsConnection> =>
    clients.connect(wsUrl, bearerParams(token));
  /** The close of a connection the server must refuse at `connection_init`. */
  const refusedWith = (options: Parameters<typeof clients.open>[1]): Promise<GraphqlWsClose> =>
    clients.open(wsUrl, options).closedWithin();

  const pubSub = () => e2e.app.get<unknown>(GRAPHQL_PUB_SUB) as { ee: EventEmitter };
  const listeners = (trigger: string): number => pubSub().ee.listenerCount(trigger);
  /**
   * Starts `SUBSCRIBE` on `connection` and waits until the server's iterator listens on `trigger`
   * (a push before that would be lost), so the delivery tests never race the subscription.
   */
  const subscribeAndWait = async (connection: GraphqlWsConnection, trigger: string) => {
    const before = listeners(trigger);
    const collector = connection.subscribe<Created>({ query: SUBSCRIBE });
    await waitUntil(() => listeners(trigger) > before);
    return collector;
  };

  /** Creates a notification and publishes its push, as the welcome and receipt handlers do. */
  const createNotification = async (tenantId: string, userId: string, title: string) => {
    const commandBus = e2e.app.get(CommandBus);
    const notification = await commandBus.execute(
      new CreateNotificationCommand({ tenantId, userId, type: 'system', title, body: title }),
    );
    await commandBus.execute(
      new PublishNotificationCreatedCommand(toNotificationProps(notification)),
    );
    return notification;
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

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
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
    await clients.disposeAll();
    await e2e?.app.close();
  });

  describe('connection', () => {
    it('closes 4403 when connection_init carries no token', async () => {
      expect((await refusedWith(undefined)).code).toBe(4403);
      expect((await refusedWith({ connectionParams: {} })).code).toBe(4403);
    });

    it('closes 4403 for an invalid, an expired and a denylisted token', async () => {
      const invalid = await refusedWith(bearerParams('not.a.jwt'));
      const expired = await refusedWith(bearerParams(await tokenLiving(uA, -60)));
      const session = await register('revoked.graphql@example.com');
      await logout(session);
      const denylisted = await refusedWith(bearerParams(session.accessToken));

      expect(invalid.code).toBe(4403);
      expect(expired.code).toBe(4403);
      expect(denylisted.code).toBe(4403);
    });

    it('acknowledges `{ authorization: "Bearer …" }` and `{ token }`', async () => {
      const viaHeader = await connect(uA.accessToken);
      const viaToken = await clients.connect(wsUrl, {
        connectionParams: { token: uA.accessToken },
      });
      expect(viaHeader.open).toBe(true);
      expect(viaToken.open).toBe(true);
    });
  });

  describe('delivery and filters', () => {
    it('delivers an (A,U) envelope to the subscription as exactly one `next`', async () => {
      const connection = await connect(uA.accessToken);
      const subscription = await subscribeAndWait(
        connection,
        notificationCreatedTrigger(tenantA, u.user.id),
      );

      // A second push after the first: a subscription delivers in order, so once the second is
      // in, a duplicate of the first would already have shown (no fixed wait for "nothing more").
      const envelope = envelopeFor(tenantA, u.user.id);
      const next = envelopeFor(tenantA, u.user.id);
      await deliver(envelope);
      await deliver(next);
      await waitUntil(() => subscription.received.length > 1);

      expect(subscription.received).toEqual([
        { notificationCreated: { id: envelope.id, title: 'Hello' } },
        { notificationCreated: { id: next.id, title: 'Hello' } },
      ]);
      expect(subscription.errors).toEqual([]);
    });

    it('yields nothing for (B,U) and (A,V) pushes, and the (A,V) push reaches only V', async () => {
      const u1 = await connect(uA.accessToken);
      const v1 = await connect(vA.accessToken);
      const onU = await subscribeAndWait(u1, notificationCreatedTrigger(tenantA, u.user.id));
      const onV = await subscribeAndWait(v1, notificationCreatedTrigger(tenantA, v.user.id));

      await deliver(envelopeFor(tenantB, u.user.id));
      const forV = envelopeFor(tenantA, v.user.id);
      await deliver(forV);
      // A legitimate push after the ones that must not arrive, per subscriber: its arrival
      // proves the earlier pushes were already filtered out (in-order delivery per subscription).
      const lastU = envelopeFor(tenantA, u.user.id);
      const lastV = envelopeFor(tenantA, v.user.id);
      await deliver(lastU);
      await deliver(lastV);
      await waitUntil(() => onU.received.length > 0 && onV.received.length > 1);

      expect(onU.received).toEqual([{ notificationCreated: { id: lastU.id, title: 'Hello' } }]);
      expect(onV.received).toEqual([
        { notificationCreated: { id: forV.id, title: 'Hello' } },
        { notificationCreated: { id: lastV.id, title: 'Hello' } },
      ]);
    });

    it('yields nothing for a (B,U) payload published straight onto the (A,U) trigger', async () => {
      const connection = await connect(uA.accessToken);
      const trigger = notificationCreatedTrigger(tenantA, u.user.id);
      const subscription = await subscribeAndWait(connection, trigger);
      const { payload } = envelopeFor(tenantB, u.user.id);

      // The trigger is right, the payload is B's: the filter is the second line of defence.
      await e2e.app
        .get<{ publish(trigger: string, payload: unknown): Promise<void> }>(GRAPHQL_PUB_SUB)
        .publish(trigger, { ...payload, tenantId: tenantB });
      // The legitimate push right behind it proves the foreign one was filtered, not just slow.
      const legitimate = envelopeFor(tenantA, u.user.id);
      await deliver(legitimate);
      await waitUntil(() => subscription.received.length > 0);

      expect(subscription.received).toEqual([
        { notificationCreated: { id: legitimate.id, title: 'Hello' } },
      ]);
    });

    it('answers a query sent over the socket from tenant A’s inbox only', async () => {
      const inA = await createNotification(tenantA, u.user.id, 'in A');
      const inB = await createNotification(tenantB, u.user.id, 'in B');
      const ofV = await createNotification(tenantA, v.user.id, 'of V in A');
      const connection = await connect(uA.accessToken);

      const result = await connection.execute<Inbox>({ query: INBOX });

      expect(result.errors).toBeUndefined();
      const ids = result.data?.notifications.items.map((item) => item.id);
      expect(ids).toContain(inA.id);
      expect(ids).not.toContain(inB.id);
      expect(ids).not.toContain(ofV.id);
    });
  });

  describe('expiry', () => {
    it('closes 4401 `Access token expired` once a 2 s token expires', async () => {
      const connection = await connect(await tokenLiving(uA, 2));
      const close = await connection.closedWithin(6_000);
      expect(close).toEqual({ code: 4401, reason: 'Access token expired' });
    });
  });

  describe('sweep', () => {
    it('closes 4401 `Access token revoked` on revocation, once a logout revokes the token', async () => {
      const session = await sessionIn(U_EMAIL, tenantA);
      const connection = await connect(session.accessToken);

      await logout(session);

      expect(await connection.closedWithin(CLOSE_WAIT_MS)).toEqual({
        code: 4401,
        reason: 'Access token revoked',
      });
    });

    it('closes the switched-away token, keeps the user’s other session, and moves pushes to the new tenant', async () => {
      const switching = await sessionIn(U_EMAIL, tenantA);
      const other = await sessionIn(U_EMAIL, tenantA); // a second login in A: another jti
      const oldConnection = await connect(switching.accessToken);
      const otherConnection = await connect(other.accessToken);
      const onOther = await subscribeAndWait(
        otherConnection,
        notificationCreatedTrigger(tenantA, u.user.id),
      );

      const inB = await switchTo(switching, tenantB);

      expect(await oldConnection.closedWithin(CLOSE_WAIT_MS)).toEqual({
        code: 4401,
        reason: 'Access token revoked',
      });

      const newConnection = await connect(inB.accessToken);
      const onNew = await subscribeAndWait(
        newConnection,
        notificationCreatedTrigger(tenantB, u.user.id),
      );
      const forB = envelopeFor(tenantB, u.user.id);
      const forA = envelopeFor(tenantA, u.user.id);
      await deliver(forB);
      await deliver(forA);
      // One more per connection behind them: in-order delivery proves nothing else came first.
      const lastB = envelopeFor(tenantB, u.user.id);
      const lastA = envelopeFor(tenantA, u.user.id);
      await deliver(lastB);
      await deliver(lastA);
      await waitUntil(() => onNew.received.length > 1 && onOther.received.length > 1);

      expect(onNew.received).toEqual([
        { notificationCreated: { id: forB.id, title: 'Hello' } },
        { notificationCreated: { id: lastB.id, title: 'Hello' } },
      ]);
      expect(onOther.received).toEqual([
        { notificationCreated: { id: forA.id, title: 'Hello' } },
        { notificationCreated: { id: lastA.id, title: 'Hello' } },
      ]);
      expect(otherConnection.open).toBe(true);
    });
  });

  describe('complexity', () => {
    it('rejects an operation above GRAPHQL_MAX_COMPLEXITY with QUERY_TOO_COMPLEX and serves the next one', async () => {
      const connection = await connect(uA.accessToken);
      const heavy = [1, 2, 3, 4].map((n) => `a${n}: notifications { items { id } }`).join(' ');

      const rejected = await connection.execute({ query: `{ ${heavy} }` });

      expect(rejected.data).toBeUndefined();
      expect(rejected.errors?.[0]).toMatchObject({ extensions: { code: 'QUERY_TOO_COMPLEX' } });

      const next = await connection.execute<Inbox>({ query: INBOX });
      expect(next.errors).toBeUndefined();
      expect(next.data?.notifications.items).toBeInstanceOf(Array);
      expect(connection.open).toBe(true);
    });
  });
});
