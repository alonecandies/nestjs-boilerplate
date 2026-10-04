# notifications-service

The notifications bounded context as a standalone microservice. It owns the Cassandra inbox and
reacts to other services' integration events:

- **gRPC** `notifications.v1.NotificationsService` (list the inbox with Cassandra paging, mark as
  read) for the gateway's `NotificationsApiModule.forRemote()`;
- **Kafka consumers** (group `notifications-service`): `identity.user-registered.v1` → welcome
  notification + welcome mail, `billing.payment-succeeded.v1` → receipt notification + receipt
  mail;
- produces `notifications.notification-created.v1` (saga), which the gateway pushes to the user
  over Socket.IO and GraphQL subscriptions;
- the BullMQ `mail` worker (SMTP) and the daily digest cron (09:00 UTC, `@WithLock`).

| Surface | Port (default)             | What                                                                  |
| ------- | -------------------------- | --------------------------------------------------------------------- |
| gRPC    | `GRPC_URL` `0.0.0.0:50052` | `notifications.v1.NotificationsService`, health, reflection           |
| HTTP    | `PORT` `3002`              | `GET /health/live`, `GET /health/ready`, `GET /metrics` only          |
| Kafka   | consumes / produces        | see above; every topic and its `.dlq` must exist (auto-create is off) |

The domain logic lives in [`@app/notifications`](../../libs/notifications/README.md); this app is
only the composition root.

## Composition (`src/app.module.ts`)

| Module                                                                             | Why                                                                                     |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `AppConfigModule.forRoot()` + `ConfigModule.forFeature(grpcConfig)`                | `app`/`observability` + the gRPC bind namespace, validated at boot                      |
| `ObservabilityModule.forRoot({ healthContributors: [cassandra, redis, kafka] })`   | pino JSON logs, request context, `/metrics`, `/health/*`                                |
| `CqrsModule.forRoot()`, `ScheduleModule.forRoot()`                                 | buses + `NotificationsSagas`; `DailyDigestCron`                                         |
| `CassandraModule.forRootAsync({ migrations: [notificationsCassandraMigrations] })` | keyspace + CQL migrations at boot (LWT-claimed), prepared statements, driver paging     |
| `RedisModule.forRootAsync()`                                                       | the digest's distributed lock                                                           |
| `AppQueueModule.forRootAsync()`, `AppMailerModule.forRootAsync({ worker: true })`  | BullMQ connection, `mail` queue, `MailService`, the `MailProcessor` worker (SMTP pool)  |
| `KafkaProducerModule.forRootAsync()`                                               | idempotent producer for `notification-created`                                          |
| `NotificationsGrpcModule`, `NotificationsMessagingModule`                          | `NotificationsCoreModule` (shared, one instance) + gRPC controller + Kafka consumers    |
| `provideCommonEnhancersAsync(...)`, `CorrelationIdMiddleware`                      | problem+json on the ops port; with `inheritAppConfig` the enhancers wrap gRPC/Kafka too |

`main.ts`: `createServiceApp(AppModule)` → `connectGrpcServer(app, ['notifications'])` +
`connectKafkaConsumer(app, { groupId: NOTIFICATIONS_CONSUMER_GROUP })` → `startAllMicroservices()`
→ `listen(app)`. The consumer group is pinned in code
(`src/notifications-service.constants.ts`): every replica must share it, and a renamed group would
start at the latest offset and silently skip events.

Consumers are `@KafkaConsumerController()`s: an invalid envelope or a failing command is published
to `<topic>.dlq` and the offset commits, so a poison message never blocks a partition. Handlers are
idempotent (deterministic notification ids, mail job ids `welcome-{userId}` / `receipt-{paymentId}`).

## Configuration

`.env.example` holds only what differs per service; `bun run setup:env` copies it to `.env`.
Everything else comes from the root `.env` / the environment ([`@app/config`](../../libs/config)):

| Variable                                                                      | Value here               | Notes                                                 |
| ----------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------- |
| `SERVICE_NAME`                                                                | `notifications-service`  | log `service`, Kafka client id, envelope `source`     |
| `PORT` / `GRPC_URL`                                                           | `3002` / `0.0.0.0:50052` | the gateway dials `NOTIFICATIONS_GRPC_URL`            |
| `KAFKA_GROUP_ID`                                                              | `notifications-service`  | equal to the group pinned in main.ts                  |
| `CASSANDRA_RUN_MIGRATIONS`                                                    | `true`                   | `false` when a job owns schema changes                |
| `CASSANDRA_CONTACT_POINTS`, `CASSANDRA_LOCAL_DC`, `CASSANDRA_KEYSPACE`        | root `.env`              | `CASSANDRA_LOCAL_DC` must match the cluster's DC name |
| `REDIS_URL`, `KAFKA_BROKERS`, `SMTP_*`, `MAIL_FROM`, `MAIL_QUEUE_CONCURRENCY` | root `.env`              |                                                       |

## Running

```bash
bun run docker:infra                                    # Cassandra, Redis, Kafka (+ topics), Mailpit
bun run dev:notifications                               # node --watch on the TS sources (no build)
bun run --filter @app/notifications-service build       # SWC → dist/ (the .cql migrations ship with @app/notifications)
bun run --filter @app/notifications-service start       # node --import ./dist/instrument.js dist/main.js
```

`src/instrument.ts` is preloaded (`--import`) by `start` (from `dist/`) and by `bun run dev` (from
the TS sources, after the swc-node loader), so tracing works in the dev loop too; it is a no-op
without an OTLP endpoint.

Scaffold providers/controllers with `bun run g <schematic> <name>` from this folder (e.g.
`bun run g service foo`): it runs `nest g` and then `eslint --fix src`, because the Nest
schematics import `TestingModule` as a value and `consistent-type-imports` would fail
`bun run check`.

## Boot, degradation and shutdown

Measured with the dist entrypoint (`NODE_ENV=production`) against throwaway containers:

| Situation                            | Behaviour                                                                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nothing reachable                    | **fails fast**: Cassandra connect retries with backoff while Redis waits for `ready`; after 10 s (`REDIS_CONNECT_TIMEOUT_MS`) a `fatal` log and exit 1                                                                                           |
| **Kafka down**, Cassandra + Redis up | **fails fast**: migrations applied and gRPC started, then the consumer exhausts its connect retries (`KafkaJSNumberOfRetriesExceeded`, ~9 s); the app is closed cleanly and exits 1. A consumer that cannot join its group must not report ready |
| SMTP down                            | degraded by design: mails stay queued and are retried (7 attempts, exponential backoff); the recipient is masked in the logs                                                                                                                     |
| Everything up                        | ready 200 (cassandra, redis, kafka); a `user-registered` event becomes an inbox row readable over gRPC within ~1 s                                                                                                                               |
| `SIGTERM`                            | gRPC `NOT_SERVING` → gRPC/HTTP drain, the consumer finishes in-flight messages and leaves the group → Cassandra/Redis/Kafka closed → exit 0 (~5 s)                                                                                               |

## Tests

```bash
bunx vitest run --project notifications-service --project notifications-service:e2e
```

- `test/app.e2e-spec.ts` boots the **real `AppModule`** with fakes only at the network edges: a
  Cassandra client answering CQL (`CASSANDRA_CLIENT`), `InMemoryRedis`, a recording BullMQ queue
  (`getQueueToken('mail')`; `MailProcessor` replaced so no Worker dials Redis) and
  `FakeKafkaProducer`. It checks `/health/live`, `/metrics`, `/health/ready` (exactly
  cassandra/redis/kafka) and real gRPC round trips from a gateway-style `ClientGrpcProxy`
  (`ListNotifications`: Timestamp → `Date`, map/bool defaults, page state; malformed page state →
  `INVALID_ARGUMENT` before any CQL; `MarkNotificationRead` LWT → `NOT_FOUND` +
  `NOTIFICATION_NOT_FOUND`). The Kafka consumers run on an in-process transport connected like
  `connectKafkaConsumer` (`inheritAppConfig`): a `user-registered` envelope writes the recipient and
  inbox rows, queues the welcome mail and publishes `notification-created`; a malformed envelope is
  dead-lettered without throwing.
- `test/env-example.spec.ts` validates `.env.example` and pins ports and the consumer group.

No Docker is needed.
