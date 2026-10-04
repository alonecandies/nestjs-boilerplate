# @app/transport

gRPC and Kafka infrastructure shared by every service. The package makes service-to-service
calls behave like local calls. A `DomainException` thrown in a service reaches the gateway as the
same class, with the same code, message and details (server-side failures are sanitized). Kafka
consumers never block a partition, and every event is a validated, versioned envelope.

## Public API

### gRPC

| Export                                                                                                                                                                               | What it is for                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createGrpcServerOptions(cfg, packages, extras?)`                                                                                                                                    | Server `GrpcOptions`: bind URL and message limits from `grpcConfig`, loader options that match ts-proto, keepalive, `max_concurrent_streams`, `max_connection_age`, `gracefulShutdown`, TLS / mutual TLS from `grpcConfig.tls`, and `grpc.health.v1` + reflection (default `grpcConfig.reflection`: off in production) via `onLoadPackageDefinition`. |
| `createGrpcServerStrategy(cfg, packages, extras?)` / `HealthReportingGrpcServer`                                                                                                     | The same options as a `CustomStrategy`. Health reports `SERVING` only after `listen()` and `NOT_SERVING` as soon as `close()` starts.                                                                                                                                                                                                                 |
| `GrpcHealthService`                                                                                                                                                                  | Status of the server (`''`) and of each fully-qualified service.                                                                                                                                                                                                                                                                                      |
| `GrpcClientsModule.register(packages, { client?, breaker? })`                                                                                                                        | One `ClientGrpc` per package under `GRPC_PACKAGES[name].clientToken`. It also exports `GrpcCircuitBreakers` and the `grpc` config namespace.                                                                                                                                                                                                          |
| `createGrpcClientOptions(cfg, name, extras?)` / `buildGrpcServiceConfig(services, { timeoutMs, maxAttempts?, retryableMethods? })`                                                   | Client options with a service config: a per-call deadline on every method, `UNAVAILABLE` retries plus retry throttling for the package's idempotent reads only (`GRPC_PACKAGES[name].idempotentMethods`), `round_robin`, keepalive, reconnect backoff, and TLS client credentials from `grpcConfig.tls`.                                              |
| `createGrpcServerCredentials(tls)`, `createGrpcChannelCredentials(tls)`                                                                                                              | grpc-js credentials from `grpcConfig.tls` (PEM files read once); `undefined` means plaintext.                                                                                                                                                                                                                                                         |
| `grpcCall(source$, { timeoutMs, operation, breaker? })`                                                                                                                              | Runs one unary call: rxjs deadline (unsubscribing cancels the call), then the breaker, then maps any failure to a `DomainException`.                                                                                                                                                                                                                  |
| `GrpcCircuitBreakers` (`get(name)`, `states()`), `isCallerError`, `DEFAULT_GRPC_CIRCUIT_BREAKER_OPTIONS`                                                                             | One opossum 10 breaker per upstream. Caller errors (`NOT_FOUND`, `INVALID_ARGUMENT`, …) never open the circuit.                                                                                                                                                                                                                                       |
| `exceptionToGrpcError`, `domainExceptionToGrpcStatus`                                                                                                                                | Server side: `DomainException`, `HttpException`, zod errors, Nest `GrpcException`/`RpcException` and unknown errors become a status, a message, and `x-error-code` / `x-error-details-bin` trailers.                                                                                                                                                  |
| `grpcErrorToDomainException`, `grpcStatusToDomainException`                                                                                                                          | Client side: `ServiceError`, rxjs `TimeoutError` and opossum rejections become a `DomainException`. Details are hidden for 5xx-class statuses.                                                                                                                                                                                                        |
| `GRPC_STATUS_TO_HTTP_STATUS`, `HTTP_STATUS_TO_GRPC_STATUS`, `httpStatusFromGrpcStatus`, `grpcStatusFromHttpStatus`, `isServerSideGrpcStatus`, `grpcStatusName`, `isGrpcServiceError` | Mapping tables and helpers.                                                                                                                                                                                                                                                                                                                           |
| `RpcStatusException`                                                                                                                                                                 | Upstream `RESOURCE_EXHAUSTED` (429) / `UNIMPLEMENTED` (501), which `@app/common` has no class for.                                                                                                                                                                                                                                                    |
| `createOutgoingMetadata(ctx)`, `readIncomingMetadata(md)`, `createErrorTrailers`, `readErrorTrailers`, `isGrpcMetadata`, `GRPC_METADATA_KEYS`                                        | Metadata for request id, correlation id, user id and roles, and error trailers. Unsafe values are dropped.                                                                                                                                                                                                                                            |
| `callerContextFromCls(cls, overrides?)`                                                                                                                                              | Caller context for an outgoing call, built from nestjs-cls (request id, correlation id, incoming caller).                                                                                                                                                                                                                                             |
| `@GrpcController()`                                                                                                                                                                  | Composite decorator: `Controller()` + `UseFilters(DomainToGrpcExceptionFilter)` + `UseInterceptors(GrpcContextInterceptor)`.                                                                                                                                                                                                                          |
| `@GrpcServerCall()`                                                                                                                                                                  | Injects the raw grpc-js call (`call.cancelled`, `getDeadline()`).                                                                                                                                                                                                                                                                                     |
| `DomainToGrpcExceptionFilter`, `GrpcContextInterceptor`                                                                                                                              | Controller-scoped error mapping, and a nestjs-cls context per call (the request id is adopted from metadata).                                                                                                                                                                                                                                         |
| `ZodRpcValidationPipe(schema, message?)`                                                                                                                                             | Payload validation that throws `DomainValidationException`, which reaches the client as `INVALID_ARGUMENT` with the issues.                                                                                                                                                                                                                           |

### Kafka

| Export                                                                                                                                                                             | What it is for                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createKafkaServerOptions(cfg, { groupId? })`                                                                                                                                      | Consumer options: `postfixId: ''`, no topic auto-creation, `consumer.retry.retries: 8`, `partitionsConsumedConcurrently`, `autoCommit` (at-least-once), and an idempotent producer for dead-lettering.                                                                                                                                                                                                  |
| `createKafkaClientOptions(cfg)` / `createKafkaClientConfig(cfg, clientId?)`                                                                                                        | Producer-only client: idempotent, `acks: -1`, `DefaultPartitioner`, GZIP. No client-level `retries`.                                                                                                                                                                                                                                                                                                    |
| `KafkaProducerModule.forRootAsync({ source?, eagerConnect?, connectRetry? })`                                                                                                      | Global module: `KAFKA_PRODUCER_CLIENT`, `KafkaProducer`, `KafkaHealthIndicator`, and the exported `kafka` namespace.                                                                                                                                                                                                                                                                                    |
| `KafkaProducer`                                                                                                                                                                    | `publish(topic, payload, { key?, correlationId?, eventId?, occurredAt? })` resolves with the envelope once the broker acks it. Also `createEnvelope`, `createRecord` and `connect()`.                                                                                                                                                                                                                   |
| `FakeKafkaProducer`                                                                                                                                                                | Drop-in for tests. It validates like the real producer and records instead of sending (`published(topic)`, `envelopes(topic)`, `failNextWith()`, `clear()`).                                                                                                                                                                                                                                            |
| `@KafkaEventPattern(topic)`                                                                                                                                                        | `EventPattern<string>(topic, Transport.KAFKA)`. Works around TS1241 and accepts only `KafkaTopic` or its `.dlq`.                                                                                                                                                                                                                                                                                        |
| `ParseEventEnvelopePipe(topic)`                                                                                                                                                    | Returns the typed `EventEnvelopeFor<T>`. Throws `InvalidEventException` (422, `INVALID_EVENT`), which also covers a wrong `type` or `version`.                                                                                                                                                                                                                                                          |
| `KafkaDeadLetterFilter`                                                                                                                                                            | Sends any failure that is left after `KafkaRetryInterceptor` to `<topic>.dlq` with error headers and emits `null` so the offset commits. It rethrows `KafkaRetriableException`, and rethrows when the dead-letter publish itself fails.                                                                                                                                                                 |
| `@KafkaConsumerController({ retry? })`, `KafkaContextInterceptor`, `KafkaRetryInterceptor`                                                                                         | `Controller()` + `KafkaDeadLetterFilter` + a nestjs-cls context per message (the event id becomes the request id, and the correlation id is taken from the header or the envelope) + an in-process retry of transient failures (`isRetriableKafkaHandlerError`: not 4xx `DomainException`s, `ZodError`s or `KafkaRetriableException`; `DEFAULT_KAFKA_RETRY_OPTIONS`: 4 attempts, 0.25 s → 2 s backoff). |
| `KafkaHealthIndicator`                                                                                                                                                             | Readiness contributor `kafka`: `describeCluster` through a reused admin client (no retries at all — neither requests nor the broker connect), with a timeout and a short result cache.                                                                                                                                                                                                                  |
| `createKafkaLogCreator(logger?)`, `isTransientKafkaLog`                                                                                                                            | kafkajs `logCreator` (set by `createKafkaClientConfig`, so consumer, producer and health client all use it): kafkajs logs go through Nest's `Logger` (pino), and the ERROR lines of kafkajs' own retry and reconnect loops are logged as WARN.                                                                                                                                                          |
| `replayDeadLetters(kafka, { topic, groupId?, dryRun? })`, `buildReplayRecord`                                                                                                      | Re-produces `<topic>.dlq` to `<topic>` (same key and value bytes, so consumers deduplicate on the envelope id; dead-letter headers removed), committing progress to `<topic>.dlq-replay`. CLI: `node --env-file=.env libs/transport/scripts/kafka-dlq-replay.mjs <topic> [--dry-run]` after `bun run build`.                                                                                            |
| `buildDeadLetterRecord`, `sendToDeadLetter`, `errorTypeOf`, `DEAD_LETTER_HEADERS`, `KAFKA_ERROR_CODES`, `KAFKA_PRODUCER_CLIENT`, `KAFKA_PRODUCER_OPTIONS`, `InvalidEventException` | Building blocks and tokens.                                                                                                                                                                                                                                                                                                                                                                             |

### Hybrid apps and context

| Export                                                     | What it is for                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connectGrpcServer(app, packages, extras?)`                | `app.connectMicroservice(createGrpcServerStrategy(...), { inheritAppConfig: true })`.                                                                                                                                    |
| `connectKafkaConsumer(app, { groupId? })`                  | `app.connectMicroservice(createKafkaServerOptions(...), { inheritAppConfig: true })`.                                                                                                                                    |
| `RPC_CLS_KEYS`, `correlationIdFromCls`, `requestIdFromCls` | nestjs-cls keys and readers shared by HTTP, gRPC and Kafka. `USER_ID` / `CORRELATION_ID` are `@app/observability`'s `CLS_USER_ID` / `CLS_CORRELATION_ID`, so `RequestContextService` sees what the interceptors adopted. |

## Usage

```ts
// identity-service main.ts
const app = await createServiceApp(AppModule);
connectGrpcServer(app, ['identity']); // after every app.useGlobal*()
await app.startAllMicroservices();
await listen(app);

// gRPC controller (service side)
@GrpcController()
@UsersServiceControllerMethods()
export class UsersGrpcController implements UsersServiceController {
  getUser(
    @Payload(new ZodRpcValidationPipe(getUserSchema)) req: GetUserRequest,
    @Ctx() _md?: Metadata,
  ) {
    return this.queryBus.execute(new GetUserByIdQuery(req.id)); // throws EntityNotFoundException → NOT_FOUND
  }
}

// gRPC adapter (gateway side), in a module importing GrpcClientsModule.register(['identity'])
@Injectable()
export class UsersGrpcAdapter implements UsersPort, OnModuleInit {
  private users!: UsersServiceClient;
  constructor(
    @Inject(GRPC_PACKAGES.identity.clientToken) private readonly client: ClientGrpc,
    @Inject(grpcConfig.KEY) private readonly cfg: GrpcConfig,
    private readonly breakers: GrpcCircuitBreakers,
    private readonly cls: ClsService,
  ) {}
  onModuleInit(): void {
    this.users = this.client.getService<UsersServiceClient>('UsersService');
  }
  getUser(id: string): Promise<User> {
    const md = createOutgoingMetadata(callerContextFromCls(this.cls));
    return grpcCall(this.users.getUser({ id }, md), {
      timeoutMs: this.cfg.deadlineMs,
      operation: 'identity.GetUser',
      breaker: this.breakers.get('identity'),
    }); // rejects with EntityNotFoundException, just like the local adapter
  }
}

// Kafka producer and consumer
await this.kafka.publish(KAFKA_TOPICS.USER_REGISTERED, payload, { key: payload.userId });

@KafkaConsumerController()
export class IdentityEventsConsumer {
  @KafkaEventPattern(KAFKA_TOPICS.USER_REGISTERED)
  async onUserRegistered(
    @Payload(new ParseEventEnvelopePipe(KAFKA_TOPICS.USER_REGISTERED))
    event: EventEnvelopeFor<typeof KAFKA_TOPICS.USER_REGISTERED>,
  ): Promise<void> {
    /* idempotent on event.id */
  }
}
```

## Environment variables (through `@app/config`)

- `grpc`: `GRPC_URL`, `IDENTITY_GRPC_URL`, `NOTIFICATIONS_GRPC_URL`, `BILLING_GRPC_URL`, `GRPC_DEADLINE_MS`, `GRPC_MAX_MESSAGE_BYTES`, `GRPC_TLS_CA_PATH`, `GRPC_TLS_CERT_PATH`, `GRPC_TLS_KEY_PATH`, `GRPC_TLS_REQUIRE_CLIENT_CERT`, `GRPC_ALLOW_INSECURE`, `GRPC_REFLECTION`.
- `kafka`: `KAFKA_BROKERS`, `KAFKA_CLIENT_ID`, `KAFKA_GROUP_ID`, `KAFKA_CONSUMER_CONCURRENCY`, `KAFKA_SSL`, `KAFKA_SASL_MECHANISM`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, `KAFKA_CONNECTION_TIMEOUT_MS`, `KAFKA_REQUEST_TIMEOUT_MS`.
- `app`: `SERVICE_NAME`, used as the envelope `source` and as the default client and group id.

## Gotchas

- **Internal gRPC is unauthenticated.** The servers trust every caller (no JWT on `rpc`; `actorId` and `userId` come from the request), so whoever reaches the port can act as any user. Without `GRPC_TLS_*` the transport is also plaintext, and `NODE_ENV=production` refuses that unless `GRPC_ALLOW_INSECURE=true`. In production, use mutual TLS (or a mesh doing it) plus a NetworkPolicy that only lets the gateway reach the gRPC ports. Reflection is off in production by default.
- **Only idempotent reads are retried on `UNAVAILABLE`.** A replica can commit a mutation and die before answering; a replayed `RefreshTokens` would trip reuse detection and revoke every session of the user. Add a method to `GRPC_PACKAGES[name].idempotentMethods` (`@app/contracts`) only if running it twice is harmless.
- **Transient Kafka handler failures are retried in-process, then dead-lettered.** Keep the retry budget (`DEFAULT_KAFKA_RETRY_OPTIONS`) far below the consumer `sessionTimeout` (30 s): Nest does not heartbeat while a handler runs. Once the cause is fixed, replay the dead-letter topic with `kafka-dlq-replay.mjs`.
- **gRPC filters must be controller-scoped.** Use `@GrpcController()`. A global RPC filter combined with `inheritAppConfig: true` makes HTTP requests hang.
- **Param decorators on a gRPC handler drop the default `(request, metadata, call)` injection.** Declare `@Ctx()` and `@GrpcServerCall()` explicitly, and keep them optional. Bind pipes with `@Payload(pipe)`, never with `@UsePipes`.
- **Optional message fields decode as `null`.** With `defaults: true`, absent message fields decode as `null`, not `undefined`, so check them with `== null`.
- **Timestamp ↔ Date needs the generated modules loaded.** It only works once `@app/contracts` has been imported as values, which this package does.
- **Kafka handlers must never throw.** A thrown error is redelivered forever. Always use `@KafkaConsumerController()` (or `@UseFilters(KafkaDeadLetterFilter)`) and keep handlers idempotent: delivery is at-least-once, and a failed dead-letter publish is redelivered.
- **Topics must exist before consumers start.** Auto-creation is off, so the three topics and their `.dlq` topics must exist, or `startAllMicroservices()` fails.
- **Call `connect*()` in the right order.** Call it after all `app.useGlobal*()` calls and before `startAllMicroservices()`. Every global enhancer must branch on `context.getType()`.
- **`KafkaHealthIndicator` never retries.** kafkajs' `admin({ retry })` only covers admin requests; `admin.connect()` uses the client-level cluster retrier, so the health client also sets `retry.retries: 0` on the client (safe: it never produces). Otherwise a broker outage kept a connect loop running for tens of seconds after the check timed out, and SIGTERM waited for it; shutdown now also bounds the disconnect (2 s).
- **`KafkaHealthIndicator` needs the `kafka` namespace.** It resolves it through the global `KafkaProducerModule`. Processes without that module must load it themselves.
- **One `@nestjs/microservices` copy.** `KafkaDeadLetterFilter`, `KafkaContextInterceptor` and `exceptionToGrpcError` use plain `instanceof` against `KafkaContext`, `KafkaRetriableException`, `RpcException` and `GrpcException`. That is only correct because `bunfig.toml`'s hoisted linker installs a single copy: `app.connectMicroservice()` builds those objects from the copy `@nestjs/core` loads, and with Bun's isolated linker that was a different, peer-variant copy, so every check was silently false (no dead-lettering, no Kafka CLS context). `context/single-copy.spec.ts` fails if a second copy appears.
- **Name clash with `@nestjs/common`.** The `ServiceUnavailableException` returned by the mappers comes from `@app/common`, not from `@nestjs/common`.
