import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zStr } from '@platform/config';
import { z } from 'zod';

export const notificationsGrpcClientEnvSchema = z
  .object({
    // Any grpc-js target syntax: host:port, dns:///svc:port, … (compose: notifications-service:50051).
    NOTIFICATIONS_GRPC_URL: zStr('localhost:50052'),
  })
  .transform((env) => ({
    /** Target of `notifications.v1.NotificationsService`. */
    url: env.NOTIFICATIONS_GRPC_URL,
  }));

/**
 * Where the gateway dials notifications-service. Read by `NotificationsApiModule.forRemote()` when
 * the module is defined; deadlines, message limits and TLS stay in the platform `grpc` namespace.
 */
export const notificationsGrpcClientConfig = defineConfigNamespace(
  'notificationsGrpcClient',
  notificationsGrpcClientEnvSchema,
);
export type NotificationsGrpcClientConfig = ConfigType<typeof notificationsGrpcClientConfig>;
