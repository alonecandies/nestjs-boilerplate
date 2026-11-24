# @domain/notifications

The notifications bounded context: one inbox per `(tenant, user)` in Cassandra, welcome and receipt
notifications (plus mails) derived from identity and billing events, a daily digest, and
real-time delivery over WebSocket and GraphQL subscriptions.

The edges (REST, GraphQL, WebSocket) depend only on `NotificationsPort`. The monolith binds that
port to the CQRS buses and the gateway binds it to gRPC; the presentation classes are identical
in both.

```
identity.user-registered.v1 ──┐                       ┌─► Cassandra notifications_by_tenant_user
identity.membership-created.v1 ┤                       │   Cassandra notification_recipients_by_tenant
identity.membership-removed.v1 ┼─► Messaging consumers ─┤
billing.payment-succeeded.v1 ──┤   → WelcomeUser /      ├─► MailService.enqueue (BullMQ, idempotent)
                               │     Upsert/RemoveRecipient,
                               │     SendPaymentReceipt └─► PublishNotificationCreatedCommand (last)
                              │                             └─► notifications.notification-created.v1
edge (gateway / monolith) ◄───┴── NotificationPushConsumer ◄──────────────┘
   ├─► socket.io room t:{tid}:u:{uid} ('notification.created') — fanned out by the Redis adapter
   └─► GRAPHQL_PUB_SUB 'notificationCreated:{tid}:{uid}'       — RedisPubSub, one channel per (tenant, user)
```

## Modules

| Module                                               | Contents                                                                                                                                                                                                      | Imported by                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `NotificationsCoreModule`                            | Command/query handlers, Cassandra repositories, `DailyDigestCron`                                                                                                                                             | monolith, notifications-service              |
| `NotificationsGrpcModule`                            | Core + `NotificationsGrpcController` (`notifications.v1.NotificationsService`)                                                                                                                                | notifications-service                        |
| `NotificationsMessagingModule`                       | Core + `IdentityEventsConsumer`, `BillingEventsConsumer`                                                                                                                                                      | monolith, notifications-service              |
| `NotificationsApiModule.forLocal()` / `.forRemote()` | `NotificationsController`, `NotificationsResolver`, `NotificationsGateway`, `NotificationPushConsumer` + the port (local adapter, the monolith imports `NotificationsCoreModule` too / gRPC adapter + client) | monolith (`forLocal`), gateway (`forRemote`) |

Entry points: `@domain/notifications/api` (edge: `NotificationsApiModule`, `NotificationsPort` and its adapters, REST /
GraphQL / WebSocket / push presentation and constants; what the gateway imports), `@domain/notifications`
(everything in `./api` plus core, Cassandra, mail, commands, queries, domain) and `@domain/notifications/testing`
(`FakeNotificationsPort`, tests only).

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
  AppMailerModule.forRootAsync({ templateDirs: [NOTIFICATIONS_MAIL_TEMPLATES_DIR] }), // MailService + MailProcessor (worker)
  KafkaProducerModule.forRootAsync(), // notification-created events
  NotificationsGrpcModule,
  NotificationsMessagingModule,
],
  // main.ts
  connectGrpcServer(app, [NOTIFICATIONS_GRPC_PACKAGE]));
connectKafkaConsumer(app, { groupId: 'notifications-service' });
```

**gateway** (edge, no Cassandra):

```ts
imports: [
  AppConfigModule.forRoot(), ObservabilityModule.forRoot(...),
  RedisModule.forRootAsync(), AuthModule.forRootAsync(), AppThrottlerModule.forRootAsync(),
  AppGraphqlModule.forRootAsync(), GraphqlPubSubModule,
  NotificationsApiModule.forRemote(),    // GrpcClientsModule.register({ spec: NOTIFICATIONS_GRPC_PACKAGE, url }) inside
],
// main.ts
app.useWebSocketAdapter(await createRedisIoAdapter(app));
connectKafkaConsumer(app, { groupId: 'gateway-push' }); // NotificationPushConsumer
```

**monolith**: everything of notifications-service (minus the gRPC module and server) plus the edge
globals, with `NotificationsCoreModule` + `NotificationsApiModule.forLocal()` + `NotificationsMessagingModule`, and
`connectKafkaConsumer(app, { groupId: 'monolith' })`.

Global modules the lib expects:

- Core: `CqrsModule`, `CassandraModule` (with the migrations), `KafkaProducerModule`, `AppQueueModule` + `AppMailerModule` (`templateDirs` must include `NOTIFICATIONS_MAIL_TEMPLATES_DIR`), `RedisModule`, `ScheduleModule`.
- Mail: `application/mail/notifications-mail.ts` declares the templates and their contexts
  (`defineNotificationsMail`). The `.hbs` files live in `infrastructure/mail/templates/`
  (`NOTIFICATIONS_MAIL_TEMPLATES_DIR`) and render with `@platform/mailer`'s layout partials.
- Api: `AuthModule` (global guards, `TokenService`, `AccessTokenDenylist`), `AppThrottlerModule` (`WsThrottlerGuard` on the gateway), `AppGraphqlModule` + `GraphqlPubSubModule`, a socket.io adapter, and a connected Kafka consumer for the push. `forRemote()` also needs nestjs-cls (from `ObservabilityModule`) to propagate request ids.

Kafka topics that must exist (auto-creation is off): `identity.user-registered.v1`,
`identity.membership-created.v1`, `identity.membership-removed.v1`, `billing.payment-succeeded.v1`,
`notifications.notification-created.v1`, and their `.dlq` topics.

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
GraphQL-aware). Args/inputs are validated with class-validator. The subscription listens on the
trigger of its token's tenant and user, `notificationCreated:{tenantId}:{userId}`
(`notificationCreatedTrigger(user.tenantId, user.id)`, both from `@CurrentUser()`), and the push
consumer publishes `{ ...payload, tenantId }` (`NotificationCreatedPush`, the tenant from the
envelope) on `notificationCreatedTrigger(tenantId, payload.userId)`. A user signed in to tenant A
never hears tenant B's notifications, their own included; a new tenant needs a new connection with
the new token. With RedisPubSub that is one Redis channel per connected (tenant, user) per replica
(Redis handles many channels well), so an event only wakes its owner's iterators. The filter
(`isOwnNotification`: `payload.tenantId` and `payload.userId` both equal the connection user's)
stays as defence in depth, so a payload published on a wrong trigger, or without a tenant, reaches
nobody. `resolve` maps the JSON payload (from RedisPubSub) to the model, which has no tenant
field.

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
denylist) before the connection is accepted, so no message can race authentication. With
`MAINTENANCE_MODE=true` it refuses first, with the 503 problem (`SERVICE_UNAVAILABLE`). Each socket
joins exactly one room, `t:{tenantId}:u:{userId}` (`tenantUserRoom`), both from the token it
authenticated with, and never changes room: another tenant needs a new connection with that
tenant's token. `NotificationPushConsumer` takes the tenant from the envelope
(`requireEventTenant`, before the dedupe claim) and calls `pushToUser(tenantId, userId, …)`, so a
user connected in tenant A never receives tenant B's notifications, their own included. An
envelope without a tenant is dead-lettered and pushes nothing. Per-message guards: `JwtAuthGuard`
(token not expired), RBAC, `WsSessionGuard` (denylist: a token revoked by logout or a tenant switch
gets `TOKEN_REVOKED`, like HTTP) and `WsThrottlerGuard` (`markRead`: 30 per 10 s).

Sockets do not outlive their session. When the access token expires the socket receives an
`exception` event (`TOKEN_EXPIRED`) and is disconnected (like graphql-ws's 4401 close). When a
token is put on the denylist, each replica's `RevocationSweeper` (`@platform/auth`, named
`socket.io`) disconnects its sockets that use it, after an `exception` event (`TOKEN_REVOKED`): at
once, since the denylist announces each revoked `jti` over Redis pub/sub, and otherwise at the next
sweep (every `WS_REVOCATION_SWEEP_INTERVAL_MS`, auth config, default 30 s) for a replica that
missed the announcement. Logout and `POST /v1/auth/switch-tenant` both denylist the access token,
so a switched-away token's sockets close at once; the user's other sessions keep theirs (there is
no room-wide close). This works in every topology (logout may run in identity-service); each sweep
costs one auto-pipelined EXISTS per distinct token, and if the denylist cannot answer, sockets are
kept until the next sweep. A server-side disconnect is not retried by socket.io clients: reconnect
with a fresh token.

### gRPC (`notifications.v1.NotificationsService`, service side)

| RPC                    | Command / query               | Validation                                                                                                  |
| ---------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ListNotifications`    | `ListNotificationsQuery`      | `ZodRpcValidationPipe`: `tenantId`, `userId` uuid, `limit` 0–100 (0 = default), `pageState` hex / null / '' |
| `MarkNotificationRead` | `MarkNotificationReadCommand` | `tenantId`, `userId`, `notificationId` uuid                                                                 |

Both requests carry `tenant_id` (a proto3 `optional`, required by the schema) and every returned
`Notification` carries its `tenant_id`. The request tenant and user are only compared with the
caller principal that `GrpcContextInterceptor` adopts from the metadata, never used as its source:
`requireInboxActor(tenantId, userId)` (`application/inbox-actor.ts`), called by both handlers
before the repository, is the one inbox check for both topologies. Another pair is
`PERMISSION_DENIED` `TENANT_MISMATCH`, no principal is `UNAUTHENTICATED` `PRINCIPAL_MISSING`. The
edges always pass `tenantId: user.tenantId`; the local adapter refuses a request without a tenant
with the same 403.

Errors: `DomainToGrpcExceptionFilter` (via `@GrpcController()`). `NotificationNotFoundException`
becomes `NOT_FOUND` with an `x-error-code: NOTIFICATION_NOT_FOUND` trailer. The gateway's
`NotificationsGrpcAdapter` turns it back into the same exception, and normalises proto-loader's
`null`s (absent `next_page_state`, `created_at`, `data`) to the local adapter's exact shape.

### Kafka

| Topic                                   | Role                                               | Handler                                                          |
| --------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| `identity.user-registered.v1`           | consumed (Messaging)                               | `WelcomeUserCommand`                                             |
| `identity.membership-created.v1`        | consumed (Messaging)                               | `UpsertRecipientCommand`                                         |
| `identity.membership-removed.v1`        | consumed (Messaging)                               | `RemoveRecipientCommand`                                         |
| `billing.payment-succeeded.v1`          | consumed (Messaging)                               | `SendPaymentReceiptCommand`                                      |
| `notifications.notification-created.v1` | produced (welcome, receipt) · consumed (edge push) | `PublishNotificationCreatedCommand` · `NotificationPushConsumer` |

Consumers use `@KafkaEventPattern` + `ParseEventEnvelopePipe` (typed, validated envelopes) with a
controller-scoped dead-letter filter: any failure, including an invalid envelope, goes to
`<topic>.dlq` and the offset commits.

The tenant of a tenant-scoped event comes only from its envelope: `requireEventTenant(event)`
(`presentation/messaging/event-tenant.ts`) returns the envelope `tenantId` and throws
`DomainValidationException` `EVENT_TENANT_REQUIRED` when it is absent, malformed or the platform
(nil) tenant. The user-registered, membership and payment consumers call it before any command,
so an envelope published before B2-24 is dead-lettered: no row, no mail. The welcome lands in the
envelope tenant's inbox (the personal workspace) and the receipt in the payment's tenant.
`notifications.notification-created.v1` is tenant-scoped: `PublishNotificationCreatedCommand`
publishes it with the explicit option `tenantId: notification.tenantId` (the inbox tenant).

## Commands and queries

| Class                               | Effect                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateNotificationCommand`         | `NotificationEntity.create()` → insert into the input's `(tenant, user)` inbox → `NotificationCreatedEvent`. With `idempotency: { key, occurredAt }` the id is derived (upsert). |
| `MarkNotificationReadCommand`       | `requireInboxActor`, then `UPDATE … USING TTL <remaining> … IF EXISTS`; 404 `NOTIFICATION_NOT_FOUND` when not in the `(tenant, user)` inbox (or past its 90 days)                |
| `PublishNotificationCreatedCommand` | Kafka publish (key = user id, envelope id = notification id, envelope tenant = inbox tenant). Rejects on failure, so the event that created the notification fails               |
| `WelcomeUserCommand`                | Welcome notification (`welcome:{userId}`), welcome mail to the event's email (`welcome-{userId}`), then the push                                                                 |
| `UpsertRecipientCommand`            | Upsert the `(tenant, user)` recipient row, `USING TIMESTAMP` = the membership's `createdAt`                                                                                      |
| `RemoveRecipientCommand`            | Delete the `(tenant, user)` recipient row, `USING TIMESTAMP` = `removedAt`                                                                                                       |
| `SendPaymentReceiptCommand`         | Receipt notification (`receipt:{paymentId}`), receipt mail (`receipt-{paymentId}`) when the user is a recipient in the payment's tenant, then the push                           |
| `SendDailyDigestCommand`            | Bounded scan of `(tenant, user)` recipients, each pair's own unread items, one digest mail per pair (`digest-{tenantId}-{userId}-{yyyy-mm-dd}`)                                  |
| `ListNotificationsQuery`            | `requireInboxActor`, then one `(tenant, user)` inbox page (`executePage`, driver paging state)                                                                                   |

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
  is still deduplicated. The digest key names the tenant too, so one user's digests in two tenants
  are two mails.
- Recipient writes carry `USING TIMESTAMP` = the membership event's time (microseconds). Cassandra
  keeps the newest write and a delete shadows every write stamped at or before it, so replays and
  reordered `created`/`removed` deliveries converge, and a replayed `created` cannot resurrect a
  removed member.
- The notification-created envelope id equals the notification id. Before pushing, the edge push
  consumer claims `<prefix>:notifications:push:dedupe:{envelope id}` (`SET NX EX 600`), so a
  re-published event does not show the same toast twice. If Redis is unavailable it pushes anyway
  (fail open).

## Data model (Cassandra, `src/infrastructure/persistence/migrations/*.cql`)

```sql
-- 001: user-keyed inbox and 002: user-keyed recipients (both dropped by 005)

-- 003: mail recipients per membership, a projection of identity's membership events
CREATE TABLE IF NOT EXISTS notification_recipients_by_tenant (
  tenant_id uuid, user_id uuid, email text, display_name text, updated_at timestamp,
  PRIMARY KEY ((tenant_id, user_id)));

-- 004: inbox, one partition per (tenant, user), newest first, 90-day TTL
CREATE TABLE IF NOT EXISTS notifications_by_tenant_user (
  tenant_id uuid, user_id uuid, notification_id uuid, type text, title text, body text,
  data map<text, text>, read boolean, created_at timestamp,
  PRIMARY KEY ((tenant_id, user_id), notification_id)
) WITH CLUSTERING ORDER BY (notification_id DESC) AND default_time_to_live = 7776000;

-- 005: drop the user-keyed tables
DROP TABLE IF EXISTS notifications_by_user;
DROP TABLE IF EXISTS notification_recipients;
```

A user in two tenants has two inboxes. Every inbox statement binds `tenant_id` then `user_id`, so a
paging state only ever pages the partition it is replayed on.

There is no backfill from the user-keyed tables: their rows have no tenant, and Cassandra cannot
derive one. Old inbox rows (90-day TTL, best effort) and old recipients are dropped; recipients come
back from new membership events. A dev stack resets its volumes (`docker compose down -v`).

Rows expire with the table's default TTL, and that TTL applies to UPDATEs too: a plain
`UPDATE … SET read = true` would give `read` a fresh 90 days and leave a "ghost" row (only `read`,
no row marker) in the inbox after the real cells expired. `markRead` therefore binds
`USING TTL` = the row's remaining lifetime, computed from the uuidv7 id and
`NOTIFICATIONS_TTL_SEC` (which must equal `default_time_to_live`; the migrations spec checks it).
Listings also skip any row with neither `type` nor `created_at` (ghosts written before this fix).

`notificationsCassandraMigrations = { dir }` points at that folder. SWC `copyFiles` ships the `.cql`
files to `dist`. All statements are prepared constants that hit one partition (no
`ALLOW FILTERING`). Only the digest scans `notification_recipients_by_tenant`, and it does so
paged and capped.

## Tests

`bunx vitest run --project notifications` needs no infrastructure.

- Domain: aggregate invariants and events, deterministic ids. Mapper round-trips, validated against the registered Kafka envelope schema.
- Every command/query handler (`*.handler.spec.ts`) with mocked repositories, buses, mail and `FakeKafkaProducer`. The welcome and receipt handlers publish last, after the mail, and reject when the publish fails; `src/notifications-push-redelivery.spec.ts` runs them through the real core: a broker failure rejects, and the redelivery publishes once, with one inbox row and one mail.
- Mail templates (`infrastructure/mail/notifications-mail-templates.spec.ts`): every declared template ships, has a context type and renders with the shared layout partials in strict mode, with HTML escaping.
- Repositories against a mocked `cassandra-driver` client (CQL, prepare/idempotent flags, paging, LWT result). Migrations parsed with `@platform/cassandra`'s loader.
- `test/recipients.int-spec.ts` (Docker; `INTEGRATION=1 bunx vitest run --project notifications:int`): the real migrations and recipients repository on `@platform/testing/cassandra`: per-pair rows, removal of one pair, write-timestamp ordering and the scan.
- `test/inbox-isolation.int-spec.ts` (Docker, same command): all five migrations (the user-keyed tables are gone), one inbox per `(tenant, user)` for list and `markRead`, a paging state replayed on another pair, a re-inserted read notification, and the digest reading each pair's own inbox (and stopping after a membership removal).
- `application/inbox-actor.spec.ts`: the principal must be exactly the inbox pair (403 `TENANT_MISMATCH`, 401 `PRINCIPAL_MISSING`); the list and markRead handler specs reject a mismatch before the repository, and the gRPC controller spec proves it with the real handlers and principal metadata (`PERMISSION_DENIED`).
- Local adapter (buses). gRPC adapter (null normalisation, NOT_FOUND trailers → `EntityNotFoundException`, sanitised 503). Cron (schedule metadata, lock won/lost, failure).
- REST and GraphQL through a Fastify test app: real `AuthModule` (real tokens), common enhancers and Apollo, with a **fake port**. The specs cover 200/204, 400 validation (zod and class-validator), 401, 403 and 404 problem details, the schema SDL, and the subscription filter, resolve and iterator.
- gRPC controller and Kafka consumers run through Nest's real RPC pipeline on in-memory transports (`test/support/in-memory-{grpc,kafka}.server.ts`): bus mapping, `INVALID_ARGUMENT`, NOT_FOUND trailers, and DLQ records for invalid envelopes and failing commands.
- gRPC round trip (`presentation/grpc/notifications-grpc.roundtrip.spec.ts`): `NotificationsGrpcAdapter` ↔ `NotificationsGrpcController` over real loopback gRPC. The remote adapter returns the local mapper's exact shape (map data, Date, `nextPageState` absent on the last page) and keeps `NOTIFICATION_NOT_FOUND` across the hop.
- WebSocket gateway: handshake middleware (valid, Bearer header, missing, revoked, forged), room join, disconnect at token expiry (and timer cleanup), the revocation sweep, `WsSessionGuard` (TOKEN_REVOKED), `markRead` ack, `ping`, room push.
- Module composition for every topology: the Core welcome flow end to end (command → aggregate → mail → Kafka), `forLocal()`/`forRemote()` port binding, and the gRPC/Messaging controllers.
- Test doubles for the apps: `@domain/notifications/testing` exports `FakeNotificationsPort` (an in-memory inbox per `(tenantId, userId)` behind the gateway's `NotificationsPort`; `add()` requires the tenant), `InMemoryNotificationsRepository` (the inbox repository keyed like the table) and `InMemoryNotificationRecipientsRepository` (the recipients projection with the Cassandra adapter's last-write-wins rules).

## Gotchas

- The consumers use `@platform/transport`'s `@KafkaConsumerController()` (dead-letter filter, CLS
  interceptor and bounded in-process retry of transient failures). Transport recognises the
  `KafkaContext` with `instanceof`, which relies on the hoisted linker installing a single
  `@nestjs/microservices` copy (see `libs/transport/README.md`).
- The push is published at least once without an outbox. The welcome and receipt handlers publish
  `notifications.notification-created.v1` last, after the inbox row and the mail, and a failed
  publish fails their event: the consumer retries it in process, then dead-letters it
  (`KafkaDeadLetters` pages; replay with `dlq-replay`). The redelivery rewrites the same row,
  enqueues the same mail job (a no-op while BullMQ keeps the deduplicated job: 24 h, or until
  10,000 newer mail jobs have completed, whichever comes first) and publishes again. The
  trade-off: a persistent publish failure dead-letters an event whose row and mail were already
  written, and replaying it after that window sends the mail again.
- `executePage` can return a page state at the exact end of a partition. The next page is then
  empty with a `null` state, so clients must treat that as the end.
- Recipients are only known after a `membership-created` event for that `(tenant, user)`. A receipt
  for a pair without a row (a membership from before this service consumed the event, or one that
  ended) is stored in the inbox but not mailed, with one warning; no other tenant is consulted.
- The gateway namespace is websocket-only (the `RedisIoAdapter` defaults), so there are no sticky
  sessions or CORS preflights. Pushes reach every replica through the Redis adapter.
