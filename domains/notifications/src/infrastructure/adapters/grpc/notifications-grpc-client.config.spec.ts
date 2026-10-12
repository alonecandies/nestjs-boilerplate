import { describe, expect, it } from 'vitest';
import { notificationsGrpcClientConfig } from './notifications-grpc-client.config.js';

describe('notificationsGrpcClientConfig (NOTIFICATIONS_GRPC_URL, read by NotificationsApiModule.forRemote())', () => {
  it('defaults to notifications-service on its host-dev port', () => {
    expect(notificationsGrpcClientConfig.parse({})).toEqual({ url: 'localhost:50052' });
  });

  it('accepts any grpc-js target syntax and treats a blank value as unset', () => {
    expect(
      notificationsGrpcClientConfig.parse({
        NOTIFICATIONS_GRPC_URL: 'dns:///notifications-service:50051',
      }).url,
    ).toBe('dns:///notifications-service:50051');
    expect(notificationsGrpcClientConfig.parse({ NOTIFICATIONS_GRPC_URL: '  ' }).url).toBe(
      'localhost:50052',
    );
  });

  it('is its own namespace, owned by notifications', () => {
    expect(notificationsGrpcClientConfig.KEY).toBe('CONFIGURATION(notificationsGrpcClient)');
  });
});
