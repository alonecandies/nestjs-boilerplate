import { GrpcClientsModule } from '@app/transport';
import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { NotificationsPort } from './application/ports/notifications.port.js';
import { NotificationsGrpcAdapter } from './infrastructure/adapters/grpc/notifications-grpc.adapter.js';
import { NotificationsLocalAdapter } from './infrastructure/adapters/local/notifications-local.adapter.js';
import { NotificationsCoreModule } from './notifications-core.module.js';
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
 * - `forLocal()` (monolith): the port runs on the CQRS buses of `NotificationsCoreModule`.
 * - `forRemote()` (gateway): the port calls notifications-service over gRPC.
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
      imports: [NotificationsCoreModule],
      controllers: CONTROLLERS,
      providers: [
        ...PROVIDERS,
        { provide: NotificationsPort, useClass: NotificationsLocalAdapter },
      ],
      exports: [NotificationsPort],
    };
  }

  static forRemote(): DynamicModule {
    return {
      module: NotificationsApiModule,
      imports: [GrpcClientsModule.register(['notifications'])],
      controllers: CONTROLLERS,
      providers: [...PROVIDERS, { provide: NotificationsPort, useClass: NotificationsGrpcAdapter }],
      exports: [NotificationsPort],
    };
  }
}
