# @app/notifications

The notifications bounded context: a per-user inbox in Cassandra, welcome and receipt
notifications (plus mails) derived from identity and billing events, a daily digest, and
real-time delivery over WebSocket and GraphQL subscriptions.

The edges (REST, GraphQL, WebSocket) depend only on `NotificationsPort`. The monolith binds that
port to the CQRS buses and the gateway binds it to gRPC; the presentation classes are identical
in both.

```
identity.user-registered.v1 ─┐                       ┌─► Cassandra notifications_by_user
billing.payment-succeeded.v1 ─┼─► Messaging consumers ─┤   Cassandra notification_recipients
                              │   → WelcomeUser /      ├─► MailService.enqueue (BullMQ, idempotent)
                              │     SendPaymentReceipt └─► NotificationCreatedEvent
                              │                            └─► NotificationsSagas (@Saga)
                              │                                 └─► PublishNotificationCreatedCommand
                              │                                      └─► notifications.notification-created.v1
edge (gateway / monolith) ◄───┴── NotificationPushConsumer ◄──────────────┘
   ├─► socket.io room user:{id} ('notification.created')   — fanned out by the Redis adapter
   └─► GRAPHQL_PUB_SUB 'notificationCreated'               — RedisPubSub, filtered per subscriber
```

## Modules

| Module                                               | Contents                                                                                                                                                         | Imported by                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `NotificationsCoreModule`                            | Command/query handlers, `NotificationsSagas`, Cassandra repositories, `DailyDigestCron`                                                                          | monolith, notifications-service              |
| `NotificationsGrpcModule`                            | Core + `NotificationsGrpcController` (`notifications.v1.NotificationsService`)                                                                                   | notifications-service                        |
| `NotificationsMessagingModule`                       | Core + `IdentityEventsConsumer`, `BillingEventsConsumer`                                                                                                         | monolith, notifications-service              |
| `NotificationsApiModule.forLocal()` / `.forRemote()` | `NotificationsController`, `NotificationsResolver`, `NotificationsGateway`, `NotificationPushConsumer` + the port (local adapter + Core / gRPC adapter + client) | monolith (`forLocal`), gateway (`forRemote`) |

### App wiring

**notifications-service** (gRPC 50052 + Kafka consumer + mail worker + cron):

```ts
imports: ([
  AppConfigModule.forRoot(),
  ObservabilityModule.forRoot({
    healthContributors: [CassandraHealthIndicator, RedisHealthIndicator, KafkaHealthIndicator],
  }),
  CqrsModule.forRoot(),
  ScheduleModule.forRoot(),
  CassandraModule.forRootAsync({ migrations: [notificationsCassandraMigrations] }),
  RedisModule.forRootAsync(), // digest lock (@WithLock)
  AppQueueModule.forRootAsync(),
  AppMailerModule.forRootAsync(), // MailService + MailProcessor (worker)
  KafkaProducerModule.forRootAsync(), // notification-created events
  NotificationsGrpcModule,
  NotificationsMessagingModule,
],
  // main.ts
  connectGrpcServer(app, ['notifications']));
connectKafkaConsumer(app, { groupId: 'notifications-service' });
```

**gateway** (edge, no Cassandra):

```ts
imports: [
  AppConfigModule.forRoot(), ObservabilityModule.forRoot(...),
  RedisModule.forRootAsync(), AuthModule.forRootAsync(), AppThrottlerModule.forRootAsync(),
  AppGraphqlModule.forRootAsync(), GraphqlPubSubModule,
  NotificationsApiModule.forRemote(),    // GrpcClientsModule.register(['notifications']) inside
],
// main.ts
app.useWebSocketAdapter(await createRedisIoAdapter(app));
connectKafkaConsumer(app, { groupId: 'gateway-push' }); // NotificationPushConsumer
```

**monolith**: everything of notifications-service (minus the gRPC module and server) plus the edge
globals, with `NotificationsApiModule.forLocal()` + `NotificationsMessagingModule`, and
`connectKafkaConsumer(app, { groupId: 'monolith' })`.

Global modules the lib expects:

- Core: `CqrsModule`, `CassandraModule` (with the migrations), `KafkaProducerModule`, `AppQueueModule` + `AppMailerModule`, `RedisModule`, `ScheduleModule`.
- Api: `AuthModule` (global guards, `TokenService`, `AccessTokenDenylist`), `AppThrottlerModule` (`WsThrottlerGuard` on the gateway), `AppGraphqlModule` + `GraphqlPubSubModule`, a socket.io adapter, and a connected Kafka consumer for the push. `forRemote()` also needs nestjs-cls (from `ObservabilityModule`) to propagate request ids.

Kafka topics that must exist (auto-creation is off): `identity.user-registered.v1`,
`billing.payment-succeeded.v1`, `notifications.notification-created.v1`, and their `.dlq` topics.

## Edge API

### REST (`/v1`, bearer JWT, `notifications:read`)

| Method | Path                         | Validation                                                                                          | Responses                                                                              |
| ------ | ---------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/v1/notifications`          | Nest-native zod `@Query({ schema })`: `limit` 1–100 (default 20), `pageState` hex ≤ 2048 (optional) | 200 `NotificationPage { items: Notification[], nextPageState \| null }`, 400, 401, 403 |
| POST   | `/v1/notifications/:id/read` | `@Param('id', { schema: z.uuid() })`                                                                | 204, 400, 401, 403, 404 `NOTIFICATION_NOT_FOUND`                                       |

Responses go through `StandardSchemaSerializerInterceptor` with the zod response schema (unknown
keys stripped, e.g. `userId`). Errors are RFC 9457 `application/problem+json`. The user id always
comes from the token.

### GraphQL

```graphql
type Query {
  notifications(limit: Int! = 20, pageState: String): NotificationConnection!
}
type Mutation {
  markNotificationRead(input: MarkNotificationReadInput!): Boolean!
}
type Subscription {
  notificationCreated: Notification!
} # only the subscriber's own
type Notification {
  id: UUID!
  type: NotificationType!
  title: String!
  body: String!
  read: Boolean!
  data: JSONObject!
  createdAt: DateTime!
}
enum NotificationType {
  WELCOME
  PAYMENT_RECEIPT
  DIGEST
  SYSTEM
}
```

Every operation requires `notifications:read`, enforced by the global guards (they are
GraphQL-aware). Args/inputs are validated with class-validator. The subscription filter compares
`payload.userId` with `ctx.req.user.id`; `resolve` maps the JSON payload (from RedisPubSub) to
the model.

### WebSocket (socket.io namespace `/notifications`)

Connect with `io('<host>/notifications', { auth: { token: '<access jwt>' } })` (or an
`Authorization: Bearer` header).

| Direction | Event                    | Payload / ack                                                                                                     |
| --------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| handshake | —                        | Refused with `connect_error`; `err.data` = problem details (`MISSING_TOKEN`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, …) |
| s → c     | `notification.created`   | REST `Notification` shape                                                                                         |
| c → s     | `notifications.markRead` | `{ id: uuid }` (zod `@MessageBody({ schema })`) → ack `{ ok: true }`, errors ack `{ ok: false, error }`           |
| c → s     | `ping`                   | → `pong` event `{ ts }`                                                                                           |

The handshake is authenticated by a namespace middleware (`authenticateSocket`, including the
denylist) before the connection is accepted, so no message can race authentication. Each socket
joins room `user:{id}`. Per-message guards: `JwtAuthGuard` (token not expired), RBAC, and
`WsThrottlerGuard` (`markRead`: 30 per 10 s).

### gRPC (`notifications.v1.NotificationsService`, service side)

| RPC                    | Command / query               | Validation                                                                                      |
| ---------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `ListNotifications`    | `ListNotificationsQuery`      | `ZodRpcValidationPipe`: `userId` uuid, `limit` 0–100 (0 = default), `pageState` hex / null / '' |
| `MarkNotificationRead` | `MarkNotificationReadCommand` | `userId`, `notificationId` uuid                                                                 |

Errors: `DomainToGrpcExceptionFilter` (via `@GrpcController()`). `NotificationNotFoundException`
becomes `NOT_FOUND` with an `x-error-code: NOTIFICATION_NOT_FOUND` trailer. The gateway's
`NotificationsGrpcAdapter` turns it back into the same exception, and normalises proto-loader's
`null`s (absent `next_page_state`, `created_at`, `data`) to the local adapter's exact shape.

### Kafka

| Topic                                   | Role                                   | Handler                                                          |
| --------------------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `identity.user-registered.v1`           | consumed (Messaging)                   | `WelcomeUserCommand`                                             |
| `billing.payment-succeeded.v1`          | consumed (Messaging)                   | `SendPaymentReceiptCommand`                                      |
| `notifications.notification-created.v1` | produced (saga) · consumed (edge push) | `PublishNotificationCreatedCommand` · `NotificationPushConsumer` |

Consumers use `@KafkaEventPattern` + `ParseEventEnvelopePipe` (typed, validated envelopes) with a
controller-scoped dead-letter filter: any failure, including an invalid envelope, goes to
`<topic>.dlq` and the offset commits.

## Commands and queries

| Class                               | Effect                                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateNotificationCommand`         | `NotificationEntity.create()` → insert → `NotificationCreatedEvent`. With `idempotency: { key, occurredAt }` the id is derived (upsert). |
| `MarkNotificationReadCommand`       | `UPDATE … IF EXISTS`; 404 `NOTIFICATION_NOT_FOUND` when not in the user's inbox                                                          |
| `PublishNotificationCreatedCommand` | Kafka publish (key = user id, envelope id = notification id). Never throws; resolves `false` on failure                                  |
| `WelcomeUserCommand`                | Upsert recipient, welcome notification (`welcome:{userId}`), welcome mail (`welcome-{userId}`)                                           |
| `SendPaymentReceiptCommand`         | Receipt notification (`receipt:{paymentId}`), receipt mail (`receipt-{paymentId}`) when the recipient is known                           |
| `SendDailyDigestCommand`            | Bounded scan of recipients, unread items per user, digest mail (`digest-{userId}-{yyyy-mm-dd}`)                                          |
| `ListNotificationsQuery`            | One inbox page (`executePage`, driver paging state)                                                                                      |

`DailyDigestCron` runs at 09:00 UTC (`@Cron` + `@WithLock('notifications:daily-digest', 5 min)`,
`waitForCompletion`), looking at up to 1,000 recipients and 50 notifications each.

### Idempotency

Delivery is at-least-once, so every consumer path is idempotent:

- Notification ids for event-driven notifications are **deterministic uuidv7s**: the time part is
  the fact's time (`registeredAt`, `paidAt`) and the random bits are `sha256(sourceKey)`. A
  redelivered event upserts the same row. Inserts never write `read`, so a replay cannot mark a
  read notification unread.
- Mails use business idempotency keys (BullMQ job ids, 24 h retention). Keys are derived from the
  user or payment id rather than the envelope id, so a re-published event with a fresh envelope id
  is still deduplicated.
- The notification-created envelope id equals the notification id, so edge consumers can
  deduplicate re-publishes.

## Data model (Cassandra, `src/infrastructure/persistence/migrations/*.cql`)

```sql
-- 001: inbox, one partition per user, newest first, 90-day TTL
CREATE TABLE IF NOT EXISTS notifications_by_user (
  user_id uuid, notification_id uuid, type text, title text, body text,
  data map<text, text>, read boolean, created_at timestamp,
  PRIMARY KEY ((user_id), notification_id)
) WITH CLUSTERING ORDER BY (notification_id DESC) AND default_time_to_live = 7776000;

-- 002: mail recipients, a projection of identity's user-registered events
CREATE TABLE IF NOT EXISTS notification_recipients (
  user_id uuid PRIMARY KEY, email text, display_name text, updated_at timestamp);
```

`notificationsCassandraMigrations = { dir }` points at that folder. SWC `copyFiles` ships the `.cql`
files to `dist`. All statements are prepared constants that hit one partition (no
`ALLOW FILTERING`). Only the digest scans `notification_recipients`, and it does so paged and
capped.

## Tests

`bunx vitest run --project notifications`: 25 files and 111 tests. None need infrastructure.

- Domain: aggregate invariants and events, deterministic ids. Mapper round-trips, validated against the registered Kafka envelope schema.
- Every command/query handler (`*.handler.spec.ts`) with mocked repositories, buses, mail and `FakeKafkaProducer`. The saga (`ofType` mapping).
- Repositories against a mocked `cassandra-driver` client (CQL, prepare/idempotent flags, paging, LWT result). Migrations parsed with `@app/cassandra`'s loader.
- Local adapter (buses). gRPC adapter (null normalisation, NOT_FOUND trailers → `EntityNotFoundException`, sanitised 503). Cron (schedule metadata, lock won/lost, failure).
- REST and GraphQL through a Fastify test app: real `AuthModule` (real tokens), common enhancers and Apollo, with a **fake port**. The specs cover 200/204, 400 validation (zod and class-validator), 401, 403 and 404 problem details, the schema SDL, and the subscription filter, resolve and iterator.
- gRPC controller and Kafka consumers run through Nest's real RPC pipeline on in-memory transports (`test/support/in-memory-{grpc,kafka}.server.ts`): bus mapping, `INVALID_ARGUMENT`, NOT_FOUND trailers, and DLQ records for invalid envelopes and failing commands.
- gRPC round trip (`presentation/grpc/notifications-grpc.roundtrip.spec.ts`): `NotificationsGrpcAdapter` ↔ `NotificationsGrpcController` over real loopback gRPC. The remote adapter returns the local mapper's exact shape (map data, Date, `nextPageState` absent on the last page) and keeps `NOTIFICATION_NOT_FOUND` across the hop.
- WebSocket gateway: handshake middleware (valid, Bearer header, missing, revoked, forged), room join, `markRead` ack, `ping`, room push.
- Module composition for every topology: the Core welcome flow end to end (command → aggregate → saga → Kafka), `forLocal()`/`forRemote()` port binding, and the gRPC/Messaging controllers.

## Gotchas

- The consumers use `@app/transport`'s `@KafkaConsumerController()` (dead-letter filter + CLS
  interceptor). Bun installs two peer-variant copies of `@nestjs/microservices` (`@nestjs/core`
  loads one at runtime, `@app/transport` imports the other), so transport recognises the
  `KafkaContext` structurally (`isKafkaContext`) rather than with `instanceof`. The consumer
  specs run on this package's own copy, so they cover that cross-copy path.
- The push is best-effort. The inbox row is written before the event is published, but a crash
  between the two loses only the push; a transactional outbox would close that gap.
- `executePage` can return a page state at the exact end of a partition. The next page is then
  empty with a `null` state, so clients must treat that as the end.
- Recipients are only known after a `user-registered` event. Receipts for users created before
  this service existed are stored in the inbox but not mailed (a warning is logged).
- The gateway namespace is websocket-only (the `RedisIoAdapter` defaults), so there are no sticky
  sessions or CORS preflights. Pushes reach every replica through the Redis adapter.
