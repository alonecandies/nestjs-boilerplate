# @domain/notifications-contracts

The published language of the notifications context: everything another context, a service image or the gateway needs to talk to notifications, without loading `@domain/notifications` itself.

- **gRPC**: `notifications.v1` (`NotificationsService`). The proto lives in `src/proto/notifications/v1/notifications.proto`, the ts-proto NestJS output in `src/generated/**` (committed, never edited by hand), and `NOTIFICATIONS_GRPC_PACKAGE` is the `GrpcPackageSpec` that `@platform/transport` takes to serve or call it.
- **Kafka**: `NOTIFICATION_CREATED_EVENT` (`notifications.notification-created.v1`) with its zod payload schema `notificationCreatedPayload` / `NotificationCreatedPayload`. Notifications produces it; the edges consume it to push to sockets and GraphQL subscriptions.
- `NOTIFICATION_TYPES` / `NotificationType`: the notification kinds the payload and the gRPC `Notification.type` carry.

It is a leaf package: it depends on `@platform/contracts` and third-party packages only, and other domains import notifications only through it. `scripts/check-boundaries.mjs` enforces both rules.

## Usage

```ts
import {
  NOTIFICATION_CREATED_EVENT,
  NOTIFICATIONS_GRPC_PACKAGE,
  type Notification,
} from '@domain/notifications-contracts';

connectGrpcServer(app, [NOTIFICATIONS_GRPC_PACKAGE]); // the service's main.ts
GrpcClientsModule.register({ spec: NOTIFICATIONS_GRPC_PACKAGE, url }); // an edge module's forRemote()
await kafka.publish(NOTIFICATION_CREATED_EVENT, payload, { key: payload.userId }); // the producer
// A consumer: @KafkaEventPattern(NOTIFICATION_CREATED_EVENT) + new ParseEventEnvelopePipe(NOTIFICATION_CREATED_EVENT)
```

Generated types are exported flat and as the namespace `notificationsV1`, the escape hatch for a later `v2` that reuses message names.

## Codegen

```bash
bun run --filter @domain/notifications-contracts proto:lint   # buf lint with the shared policy (libs/contracts/buf.yaml)
bun run --filter @domain/notifications-contracts proto:gen    # buf generate + the shared ESM fix (libs/contracts)
```

Check a proto change for breaking changes from this folder before releasing it:

```bash
buf breaking --config ../../../libs/contracts/buf.yaml \
  --against '../../../.git#branch=master,subdir=domains/notifications/contracts/src/proto'
```

The first comparison after the move to this package must point at the old root instead (`subdir=libs/contracts/src/proto`); it also reports the other contexts' files as deleted, which is expected.
