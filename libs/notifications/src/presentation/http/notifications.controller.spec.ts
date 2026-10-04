import { Role } from '@app/auth';
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
  USER_ID,
} from '../../../test/support/fixtures.js';
import { NotificationNotFoundException } from '../../domain/notification.errors.js';
import { NotificationsController } from './notifications.controller.js';

const NOTIFICATION_ID = '01920000-0000-7000-8000-00000000abcd';

describe('NotificationsController (Fastify, real guards, fake port)', () => {
  const port = createFakePort();
  let app: EdgeTestApp;
  let userToken: string;

  beforeAll(async () => {
    app = await createEdgeTestApp({ port, controllers: [NotificationsController] });
    userToken = await bearer(app, { id: USER_ID, roles: [Role.User] });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    port.list.mockReset();
    port.markRead.mockReset();
  });

  describe('GET /v1/notifications', () => {
    it('200: lists the caller inbox (user id from the token), serialised by the zod schema', async () => {
      const item = makeContractNotification({ id: NOTIFICATION_ID, data: { link: '/x' } });
      port.list.mockResolvedValue(makeNotificationPage([item], 'cafe'));

      const res = await app.inject({
        method: 'GET',
        url: '/v1/notifications?limit=5&pageState=beef',
        headers: { authorization: userToken },
      });

      expect(res.statusCode).toBe(200);
      expect(port.list).toHaveBeenCalledWith({ userId: USER_ID, limit: 5, pageState: 'beef' });
      expect(res.json()).toEqual({
        items: [
          {
            id: NOTIFICATION_ID,
            type: 'welcome',
            title: item.title,
            body: item.body,
            read: false,
            data: { link: '/x' },
            createdAt: CREATED_AT.toISOString(),
          },
        ],
        nextPageState: 'cafe',
      });
      // `userId` is not part of the response contract: stripped by the serializer.
      expect(res.json().items[0]).not.toHaveProperty('userId');
    });

    it('applies the default page size and returns a null nextPageState on the last page', async () => {
      port.list.mockResolvedValue(makeNotificationPage([]));
      const res = await app.inject({
        method: 'GET',
        url: '/v1/notifications',
        headers: { authorization: userToken },
      });
      expect(res.statusCode).toBe(200);
      expect(port.list).toHaveBeenCalledWith({ userId: USER_ID, limit: 20, pageState: undefined });
      expect(res.json()).toEqual({ items: [], nextPageState: null });
    });

    it.each([
      ['limit=0', 'limit'],
      ['limit=101', 'limit'],
      ['limit=abc', 'limit'],
      ['pageState=zz-not-hex', 'pageState'],
    ])('400 problem+json for ?%s', async (query, path) => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/notifications?${query}`,
        headers: { authorization: userToken },
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json().errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ path })]),
      );
      expect(port.list).not.toHaveBeenCalled();
    });

    it('401 without a token, and with a garbage token', async () => {
      const missing = await app.inject({ method: 'GET', url: '/v1/notifications' });
      expect(missing.statusCode).toBe(401);
      expect(missing.json().code).toBe('MISSING_TOKEN');

      const garbage = await app.inject({
        method: 'GET',
        url: '/v1/notifications',
        headers: { authorization: 'Bearer not-a-jwt' },
      });
      expect(garbage.statusCode).toBe(401);
      expect(port.list).not.toHaveBeenCalled();
    });

    it('403 when the token lacks notifications:read', async () => {
      const noPermissions = await bearer(app, { id: USER_ID, roles: [] });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/notifications',
        headers: { authorization: noPermissions },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('FORBIDDEN');
      expect(port.list).not.toHaveBeenCalled();
    });
  });

  describe('POST /v1/notifications/:id/read', () => {
    it('204 and marks the caller notification read', async () => {
      port.markRead.mockResolvedValue(undefined);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/notifications/${NOTIFICATION_ID}/read`,
        headers: { authorization: userToken },
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(port.markRead).toHaveBeenCalledWith({
        userId: USER_ID,
        notificationId: NOTIFICATION_ID,
      });
    });

    it('400 for a non-uuid id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/notifications/42/read',
        headers: { authorization: userToken },
      });
      expect(res.statusCode).toBe(400);
      expect(port.markRead).not.toHaveBeenCalled();
    });

    it('404 NOTIFICATION_NOT_FOUND from the port as problem+json', async () => {
      port.markRead.mockRejectedValue(new NotificationNotFoundException(NOTIFICATION_ID));
      const res = await app.inject({
        method: 'POST',
        url: `/v1/notifications/${NOTIFICATION_ID}/read`,
        headers: { authorization: userToken },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ status: 404, code: 'NOTIFICATION_NOT_FOUND' });
    });

    it('401 without a token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/notifications/${NOTIFICATION_ID}/read`,
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
