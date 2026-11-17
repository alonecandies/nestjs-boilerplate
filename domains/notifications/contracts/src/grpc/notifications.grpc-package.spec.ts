import { join } from 'node:path';
import {
  boundRpcPatterns,
  loadGrpcPackages,
  protoFilesUnder,
  wireRoundTrip,
} from '@platform/contracts/testing';
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATIONS_GRPC_PACKAGE,
  type Notification,
  NotificationsServiceControllerMethods,
} from '../index.js';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');
const root = loadGrpcPackages([NOTIFICATIONS_GRPC_PACKAGE]);

describe('NOTIFICATIONS_GRPC_PACKAGE', () => {
  it('resolves its protos under <package>/src/proto and registers every notifications proto', () => {
    expect(NOTIFICATIONS_GRPC_PACKAGE.protoDir).toBe(join(PACKAGE_ROOT, 'src', 'proto'));
    const own = protoFilesUnder(NOTIFICATIONS_GRPC_PACKAGE.protoDir).filter((file) =>
      file.startsWith('notifications/'),
    );
    expect(own).toEqual([...NOTIFICATIONS_GRPC_PACKAGE.protoPath].sort());
  });

  it('declares the protobuf package and service the proto defines', () => {
    expect(root.lookup('notifications.v1')).toBeDefined();
    expect(NOTIFICATIONS_GRPC_PACKAGE.services).toEqual(['NotificationsService']);
    expect(root.lookupService('notifications.v1.NotificationsService').name).toBe(
      'NotificationsService',
    );
  });

  it('retries only ListNotifications, never MarkNotificationRead', () => {
    const service = root.lookupService('notifications.v1.NotificationsService');
    expect(NOTIFICATIONS_GRPC_PACKAGE.idempotentMethods).toEqual({
      NotificationsService: ['ListNotifications'],
    });
    expect(service.methods['ListNotifications']).toBeDefined();
  });

  it('generated NotificationsService decorator binds every rpc of the proto', () => {
    const service = root.lookupService('notifications.v1.NotificationsService');
    expect(boundRpcPatterns(NotificationsServiceControllerMethods, service)).toEqual(
      service.methodsArray.map((method) => [
        {
          service: 'NotificationsService',
          rpc: method.name.charAt(0).toLowerCase() + method.name.slice(1),
          streaming: 'no_stream',
        },
      ]),
    );
  });
});

describe('notifications.v1 wire format (proto-loader semantics + generated types)', () => {
  it('round-trips map<string, string>, Timestamp and the tenant', () => {
    const notification: Notification = {
      id: 'n1',
      tenantId: 't1',
      userId: 'u1',
      type: 'welcome',
      title: 'Welcome',
      body: 'Hello',
      read: false,
      data: { link: '/inbox', paymentId: 'p1' },
      createdAt: new Date('2026-05-05T05:05:05.005Z'),
    };
    expect(wireRoundTrip(root, 'notifications.v1.Notification', notification)).toEqual(
      notification,
    );
  });
});
