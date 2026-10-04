import { Role } from '@app/auth';
import type { NotificationCreatedPayload } from '@app/contracts';
import type { GqlContext } from '@app/graphql';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { printSchema } from 'graphql';
import { PubSub } from 'graphql-subscriptions';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  OTHER_USER_ID,
  USER_ID,
} from '../../../test/support/fixtures.js';
import { NotificationNotFoundException } from '../../domain/notification.errors.js';
import { NOTIFICATION_CREATED_TRIGGER } from '../../notifications.constants.js';
import {
  isOwnNotification,
  NotificationsResolver,
  toCreatedNotificationModel,
} from './notifications.resolver.js';

const NOTIFICATION_ID = '01920000-0000-7000-8000-00000000abcd';

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
    userToken = await bearer(app, { id: USER_ID, roles: [Role.User] });
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
    expect(port.list).toHaveBeenCalledWith({ userId: USER_ID, limit: 5, pageState: 'beef' });
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

  it('rejects a non-UUID id at the scalar', async () => {
    const res = await gql(MARK, { id: 'nope' }, userToken);
    expect(res.errors?.length).toBeGreaterThan(0);
    expect(port.markRead).not.toHaveBeenCalled();
  });
});

describe('notificationCreated subscription', () => {
  const payload: NotificationCreatedPayload = {
    notificationId: NOTIFICATION_ID,
    userId: USER_ID,
    type: 'welcome',
    title: 'Welcome aboard!',
    body: 'Hi',
    data: {},
    createdAt: CREATED_AT.toISOString(),
  };
  const contextFor = (userId?: string) =>
    ({
      req: { headers: {}, user: userId ? { id: userId } : undefined },
      loaders: {},
    }) as GqlContext;

  it('only delivers the subscriber’s own notifications', () => {
    expect(isOwnNotification(payload, {}, contextFor(USER_ID))).toBe(true);
    expect(isOwnNotification(payload, {}, contextFor(OTHER_USER_ID))).toBe(false);
    expect(isOwnNotification(payload, {}, contextFor())).toBe(false);
  });

  it('resolves the JSON payload into the model (Date revived)', () => {
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

  it('iterates the notificationCreated trigger of the GraphQL PubSub', async () => {
    const pubSub = new PubSub();
    const resolver = new NotificationsResolver(createFakePort(), pubSub);
    const iterator = resolver.notificationCreated();
    const next = iterator.next();
    await pubSub.publish(NOTIFICATION_CREATED_TRIGGER, payload);
    await expect(next).resolves.toEqual({ value: payload, done: false });
    await iterator.return?.();
  });
});
