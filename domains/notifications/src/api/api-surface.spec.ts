import * as root from '../index.js';
import { NotificationsApiModule } from '../notifications-api.module.js';
import { NotificationsCoreModule } from '../notifications-core.module.js';
import * as api from './index.js';

const API_VALUES = [
  'NOTIFICATIONS_RBAC',
  'NotificationsPermission',
  'DEFAULT_NOTIFICATIONS_PAGE_SIZE',
  'MAX_NOTIFICATIONS_PAGE_SIZE',
  'NOTIFICATIONS_WS_EVENTS',
  'NOTIFICATIONS_WS_NAMESPACE',
  'NOTIFICATION_CREATED_TRIGGER',
  'NotificationConnectionModel',
  'NotificationModel',
  'NotificationPushConsumer',
  'NotificationTypeEnum',
  'NotificationsApiModule',
  'NotificationsController',
  'NotificationsGateway',
  'NotificationsGrpcAdapter',
  'NotificationsLocalAdapter',
  'NotificationsPort',
  'NotificationsResolver',
  'PAGE_STATE_MAX_LENGTH',
  'PAGE_STATE_PATTERN',
  'PUSH_DEDUPE_TTL_SEC',
  'isOwnNotification',
  'listNotificationsQuerySchema',
  'notificationCreatedTrigger',
  'notificationIdParamSchema',
  'notificationsRateLimitConfig',
  'notificationPageResponseSchema',
  'notificationResponseSchema',
  'notificationsGrpcClientConfig',
  'notificationsGrpcClientEnvSchema',
  'tenantUserRoom',
  'toCreatedNotificationModel',
  'toNotificationConnection',
  'toNotificationPageResponse',
  'toNotificationResponse',
];

describe('@domain/notifications entry points', () => {
  it('./api exports exactly the edge surface', () => {
    expect(Object.keys(api).sort()).toEqual([...API_VALUES].sort());
  });

  it('./api has tenantUserRoom and no longer userRoom or WS_REVOCATION_SWEEP_INTERVAL_MS', () => {
    expect(api).toHaveProperty('tenantUserRoom');
    expect(api).not.toHaveProperty('userRoom');
    expect(api).not.toHaveProperty('WS_REVOCATION_SWEEP_INTERVAL_MS');
  });

  it('the root entry re-exports ./api and keeps core, Cassandra and mail', () => {
    for (const name of API_VALUES) {
      expect(root).toHaveProperty(name, (api as Record<string, unknown>)[name]);
    }
    for (const name of [
      'NotificationsCoreModule',
      'NotificationsMessagingModule',
      'notificationsCassandraMigrations',
      'NOTIFICATIONS_MAIL_TEMPLATES_DIR',
      'DAILY_DIGEST_CRON',
    ]) {
      expect(root).toHaveProperty(name);
      expect(api).not.toHaveProperty(name);
    }
  });

  it('forLocal() binds the port without importing NotificationsCoreModule', () => {
    expect(NotificationsApiModule.forLocal().imports ?? []).not.toContain(NotificationsCoreModule);
  });
});
