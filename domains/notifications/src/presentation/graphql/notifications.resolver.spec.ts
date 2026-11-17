import { GraphQLSchemaHost } from '@nestjs/graphql';
import { makeAuthUser, TEST_TENANT_ID } from '@platform/auth/testing';
import { type GqlContext, GRAPHQL_PUB_SUB, type GraphqlPubSub } from '@platform/graphql';
import { type ExecutionResult, parse, printSchema, subscribe } from 'graphql';
import { PubSub } from 'graphql-subscriptions';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bearer,
  createEdgeTestApp,
  type EdgeTestApp,
} from '../../../test/support/edge-test-app.js';
import {
  CREATED_AT,
  createFakePort,
  makeContractNotification,
  makeNotificationPage,
  OTHER_TENANT_ID,
  OTHER_USER_ID,
  TENANT_ID,
  USER_ID,
} from '../../../test/support/fixtures.js';
import { NotificationNotFoundException } from '../../domain/notification.errors.js';
import {
  type NotificationCreatedPush,
  notificationCreatedTrigger,
} from '../../notifications.constants.js';
import {
  isOwnNotification,
  NotificationsResolver,
  toCreatedNotificationModel,
} from './notifications.resolver.js';

const NOTIFICATION_ID = '01920000-0000-7000-8000-00000000abcd';

const subscriptionPayload: NotificationCreatedPush = {
  notificationId: NOTIFICATION_ID,
  userId: USER_ID,
  tenantId: TEST_TENANT_ID,
  type: 'welcome',
  title: 'Welcome aboard!',
  body: 'Hi',
  data: {},
  createdAt: CREATED_AT.toISOString(),
};

const LIST = /* GraphQL */ `
  query List($limit: Int, $pageState: String) {
    notifications(limit: $limit, pageState: $pageState) {
      items { id type title body read data createdAt }
      nextPageState
    }
  }
`;
const MARK = /* GraphQL */ `
  mutation Mark($id: UUID!) { markNotificationRead(input: { id: $id }) }
`;

interface GqlResponse {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions?: { code?: string; status?: number } }[];
}

describe('NotificationsResolver (Apollo on Fastify, real guards, fake port)', () => {
  const port = createFakePort();
  let app: EdgeTestApp;
  let userToken: string;

  const gql = async (query: string, variables: Record<string, unknown>, token?: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: token } : {}) },
      payload: { query, variables },
    });
    return res.json<GqlResponse>();
  };

  beforeAll(async () => {
    app = await createEdgeTestApp({ port, providers: [NotificationsResolver], graphql: true });
    userToken = await bearer(app, { id: USER_ID, roles: ['member'] });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    port.list.mockReset();
    port.markRead.mockReset();
  });

  it('exposes the documented schema (query, mutation, subscription, enum, scalars)', () => {
    const sdl = printSchema(app.get(GraphQLSchemaHost).schema);
    expect(sdl).toMatch(
      /notifications\(\s*limit: Int! = 20[\s\S]*?pageState: String\s*\): NotificationConnection!/,
    );
    expect(sdl).toContain('markNotificationRead(input: MarkNotificationReadInput!): Boolean!');
    expect(sdl).toContain('notificationCreated: Notification!');
    expect(sdl).toMatch(/enum NotificationType \{\s+DIGEST\s+PAYMENT_RECEIPT\s+SYSTEM\s+WELCOME/);
    expect(sdl).toContain('data: JSONObject!');
  });

  it('query notifications: the caller inbox as a connection', async () => {
    port.list.mockResolvedValue(
      makeNotificationPage(
        [
          makeContractNotification({
            id: NOTIFICATION_ID,
            type: 'payment_receipt',
            data: { a: 'b' },
          }),
        ],
        'cafe',
      ),
    );

    const body = await gql(LIST, { limit: 5, pageState: 'beef' }, userToken);

    expect(body.errors).toBeUndefined();
    expect(port.list).toHaveBeenCalledWith({
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      limit: 5,
      pageState: 'beef',
    });
    expect(body.data?.notifications).toEqual({
      items: [
        {
          id: NOTIFICATION_ID,
          type: 'PAYMENT_RECEIPT',
          title: 'Welcome aboard!',
          body: 'Hi Ada',
          read: false,
          data: { a: 'b' },
          createdAt: CREATED_AT.toISOString(),
        },
      ],
      nextPageState: 'cafe',
    });
  });

  it('rejects invalid args with a validation error (class-validator on @Args)', async () => {
    const tooMany = await gql(LIST, { limit: 1000 }, userToken);
    expect(tooMany.errors?.[0]?.extensions?.status).toBe(400);
    const badState = await gql(LIST, { pageState: 'not hex' }, userToken);
    expect(badState.errors?.[0]?.extensions?.status).toBe(400);
    expect(port.list).not.toHaveBeenCalled();
  });

  it('401 without a token, 403 without notifications:read', async () => {
    const anonymous = await gql(LIST, {});
    expect(anonymous.errors?.[0]?.extensions).toMatchObject({ code: 'MISSING_TOKEN', status: 401 });

    const forbidden = await gql(LIST, {}, await bearer(app, { id: USER_ID, roles: [] }));
    expect(forbidden.errors?.[0]?.extensions).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(port.list).not.toHaveBeenCalled();
  });

  it('mutation markNotificationRead: true, and NOT_FOUND passes through with its code', async () => {
    port.markRead.mockResolvedValueOnce(undefined);
    const ok = await gql(MARK, { id: NOTIFICATION_ID }, userToken);
    expect(ok).toEqual({ data: { markNotificationRead: true } });
    expect(port.markRead).toHaveBeenCalledWith({
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      notificationId: NOTIFICATION_ID,
    });

    port.markRead.mockRejectedValueOnce(new NotificationNotFoundException(NOTIFICATION_ID));
    const missing = await gql(MARK, { id: NOTIFICATION_ID }, userToken);
    expect(missing.errors?.[0]?.extensions).toMatchObject({
      code: 'NOTIFICATION_NOT_FOUND',
      status: 404,
    });
  });

  it('subscription notificationCreated: listens on the caller’s own (tenant, user) trigger and filters (real guards)', async () => {
    const pubSub = app.get<GraphqlPubSub>(GRAPHQL_PUB_SUB);
    const result = await subscribe({
      schema: app.get(GraphQLSchemaHost).schema,
      document: parse('subscription { notificationCreated { id title } }'),
      contextValue: { req: { headers: { authorization: userToken } }, loaders: {} },
    });
    if (!(Symbol.asyncIterator in result)) throw new Error(JSON.stringify(result.errors));
    const stream = result as AsyncGenerator<ExecutionResult>;
    const next = stream.next();

    const own = { ...subscriptionPayload, tenantId: TEST_TENANT_ID, userId: USER_ID };
    // Another user of the same tenant: another trigger.
    await pubSub.publish(notificationCreatedTrigger(TEST_TENANT_ID, OTHER_USER_ID), {
      ...own,
      userId: OTHER_USER_ID,
      title: 'not mine',
    });
    // The same user in another tenant: another trigger.
    await pubSub.publish(notificationCreatedTrigger(OTHER_TENANT_ID, USER_ID), {
      ...own,
      tenantId: OTHER_TENANT_ID,
      title: 'other tenant',
    });
    // A (B, U) payload published on the (A, U) trigger: the filter drops it.
    await pubSub.publish(notificationCreatedTrigger(TEST_TENANT_ID, USER_ID), {
      ...own,
      tenantId: OTHER_TENANT_ID,
      title: 'wrong trigger',
    });
    await pubSub.publish(notificationCreatedTrigger(TEST_TENANT_ID, USER_ID), own);

    await expect(next).resolves.toEqual({
      value: { data: { notificationCreated: { id: NOTIFICATION_ID, title: own.title } } },
      done: false,
    });
    await stream.return(undefined);
  });

  it('rejects a non-UUID id at the scalar', async () => {
    const res = await gql(MARK, { id: 'nope' }, userToken);
    expect(res.errors?.length).toBeGreaterThan(0);
    expect(port.markRead).not.toHaveBeenCalled();
  });
});

describe('notificationCreated subscription', () => {
  const payload: NotificationCreatedPush = {
    notificationId: NOTIFICATION_ID,
    userId: USER_ID,
    tenantId: TENANT_ID,
    type: 'welcome',
    title: 'Welcome aboard!',
    body: 'Hi',
    data: {},
    createdAt: CREATED_AT.toISOString(),
  };
  const contextFor = (user?: { tenantId: string; id: string }) =>
    ({
      req: { headers: {}, user: user ? makeAuthUser(user) : undefined },
      loaders: {},
    }) as GqlContext;

  it('isOwnNotification: true only when tenant and user both match', () => {
    expect(isOwnNotification(payload, {}, contextFor({ tenantId: TENANT_ID, id: USER_ID }))).toBe(
      true,
    );
    // The same user, signed in to another tenant.
    expect(
      isOwnNotification(payload, {}, contextFor({ tenantId: OTHER_TENANT_ID, id: USER_ID })),
    ).toBe(false);
    // Another user of the same tenant.
    expect(
      isOwnNotification(payload, {}, contextFor({ tenantId: TENANT_ID, id: OTHER_USER_ID })),
    ).toBe(false);
    // A payload without a tenant (a pre-B4 publisher) reaches nobody.
    const { tenantId: _tenantId, ...untenanted } = payload;
    expect(
      isOwnNotification(
        untenanted as NotificationCreatedPush,
        {},
        contextFor({ tenantId: TENANT_ID, id: USER_ID }),
      ),
    ).toBe(false);
    // A context without a user.
    expect(isOwnNotification(payload, {}, contextFor())).toBe(false);
  });

  it('resolves the JSON payload into the model (Date revived, no tenantId field)', () => {
    expect(toCreatedNotificationModel(payload)).toEqual({
      id: NOTIFICATION_ID,
      type: 'welcome',
      title: 'Welcome aboard!',
      body: 'Hi',
      read: false,
      data: {},
      createdAt: CREATED_AT,
    });
  });

  it('asks the PubSub for exactly notificationCreated:<tenant>:<user> of the caller', () => {
    const pubSub = new PubSub();
    const iterate = vi.spyOn(pubSub, 'asyncIterableIterator');
    const resolver = new NotificationsResolver(createFakePort(), pubSub);

    const iterator = resolver.notificationCreated(
      makeAuthUser({ tenantId: TENANT_ID, id: USER_ID }),
    );

    expect(iterate).toHaveBeenCalledOnce();
    expect(iterate).toHaveBeenCalledWith(`notificationCreated:${TENANT_ID}:${USER_ID}`);
    expect(notificationCreatedTrigger(TENANT_ID, USER_ID)).toBe(
      `notificationCreated:${TENANT_ID}:${USER_ID}`,
    );
    void iterator.return?.();
  });

  it('a publish for (A, U) reaches the (A, U) iterator only, not (B, U) nor (A, V)', async () => {
    const pubSub = new PubSub();
    const resolver = new NotificationsResolver(createFakePort(), pubSub);
    const subscribe = (tenantId: string, id: string) =>
      resolver.notificationCreated(makeAuthUser({ tenantId, id }));
    const own = subscribe(TENANT_ID, USER_ID);
    const otherTenant = subscribe(OTHER_TENANT_ID, USER_ID);
    const otherUser = subscribe(TENANT_ID, OTHER_USER_ID);
    const ownNext = own.next();
    const otherTenantNext = otherTenant.next();
    const otherUserNext = otherUser.next();

    await pubSub.publish(notificationCreatedTrigger(TENANT_ID, USER_ID), payload);
    // Markers on the other triggers: each iterator's first value must be its own marker.
    const marker = (tenantId: string, userId: string): NotificationCreatedPush => ({
      ...payload,
      tenantId,
      userId,
      title: `marker ${tenantId} ${userId}`,
    });
    await pubSub.publish(
      notificationCreatedTrigger(OTHER_TENANT_ID, USER_ID),
      marker(OTHER_TENANT_ID, USER_ID),
    );
    await pubSub.publish(
      notificationCreatedTrigger(TENANT_ID, OTHER_USER_ID),
      marker(TENANT_ID, OTHER_USER_ID),
    );

    await expect(ownNext).resolves.toEqual({ value: payload, done: false });
    await expect(otherTenantNext).resolves.toEqual({
      value: marker(OTHER_TENANT_ID, USER_ID),
      done: false,
    });
    await expect(otherUserNext).resolves.toEqual({
      value: marker(TENANT_ID, OTHER_USER_ID),
      done: false,
    });
    await Promise.all([own.return?.(), otherTenant.return?.(), otherUser.return?.()]);
  });
});
