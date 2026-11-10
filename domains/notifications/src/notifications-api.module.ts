import { NOTIFICATIONS_GRPC_PACKAGE } from '@domain/notifications-contracts';
import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { GrpcClientsModule } from '@platform/transport';
import { NotificationsPort } from './application/ports/notifications.port.js';
import { NotificationsGrpcAdapter } from './infrastructure/adapters/grpc/notifications-grpc.adapter.js';
import { notificationsGrpcClientConfig } from './infrastructure/adapters/grpc/notifications-grpc-client.config.js';
import { NotificationsLocalAdapter } from './infrastructure/adapters/local/notifications-local.adapter.js';
import { NotificationsResolver } from './presentation/graphql/notifications.resolver.js';
import { NotificationsController } from './presentation/http/notifications.controller.js';
import { NotificationPushConsumer } from './presentation/messaging/notification-push.consumer.js';
import { NotificationsGateway } from './presentation/ws/notifications.gateway.js';

/** Identical in both topologies — they only ever see `NotificationsPort`. */
const CONTROLLERS: Type[] = [NotificationsController, NotificationPushConsumer];
const PROVIDERS: Provider[] = [NotificationsResolver, NotificationsGateway];

/**
 * The notifications edge: REST `/v1/notifications`, GraphQL (`notifications`,
 * `markNotificationRead`, `notificationCreated`), the socket.io namespace `/notifications`, and
 * the Kafka push consumer that fans `notification-created` events out to WebSocket rooms and
 * GraphQL subscriptions.
 *
 * - `forLocal()` (monolith): the port runs on the CQRS buses of `NotificationsCoreModule`, which the
 *   app imports itself.
 * - `forRemote()` (gateway): the port calls notifications-service over gRPC. The client URL
 *   (`NOTIFICATIONS_GRPC_URL`) is read when `forRemote()` is called.
 *
 * Expects (global): `AuthModule` (guards, TokenService, denylist), `AppThrottlerModule`
 * (WsThrottlerGuard), `AppGraphqlModule` + `GraphqlPubSubModule`, a socket.io adapter
 * (`createRedisIoAdapter`) and `connectKafkaConsumer(app, { groupId })` for the push consumer.
 */
@Module({})
export class NotificationsApiModule {
  static forLocal(): DynamicModule {
    return {
      module: NotificationsApiModule,
      controllers: CONTROLLERS,
      providers: [
        ...PROVIDERS,
        { provide: NotificationsPort, useClass: NotificationsLocalAdapter },
      ],
      exports: [NotificationsPort],
    };
  }

  static forRemote(): DynamicModule {
    const target = {
      spec: NOTIFICATIONS_GRPC_PACKAGE,
      // Read when the module is defined: a client target cannot come from DI.
      url: notificationsGrpcClientConfig.parse().url,
    };
    return {
      module: NotificationsApiModule,
      imports: [GrpcClientsModule.register(target)],
      controllers: CONTROLLERS,
      providers: [...PROVIDERS, { provide: NotificationsPort, useClass: NotificationsGrpcAdapter }],
      exports: [NotificationsPort],
    };
  }
}
