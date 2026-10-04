# @app/transport

gRPC and Kafka infrastructure shared by every service. The package makes service-to-service
calls behave like local calls. A `DomainException` thrown in a service reaches the gateway as the
same class, with the same code, message and details (server-side failures are sanitized). Kafka
consumers never block a partition, and every event is a validated, versioned envelope.

## Public API

### gRPC

| Export                                                                                                                                                                               | What it is for                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createGrpcServerOptions(cfg, packages, extras?)`                                                                                                                                    | Server `GrpcOptions`: bind URL and message limits from `grpcConfig`, loader options that match ts-proto, keepalive, `max_concurrent_streams`, `max_connection_age`, `gracefulShutdown`, and `grpc.health.v1` + reflection via `onLoadPackageDefinition`. |
| `createGrpcServerStrategy(cfg, packages, extras?)` / `HealthReportingGrpcServer`                                                                                                     | The same options as a `CustomStrategy`. Health reports `SERVING` only after `listen()` and `NOT_SERVING` as soon as `close()` starts.                                                                                                                    |
| `GrpcHealthService`                                                                                                                                                                  | Status of the server (`''`) and of each fully-qualified service.                                                                                                                                                                                         |
| `GrpcClientsModule.register(packages, { client?, breaker? })`                                                                                                                        | One `ClientGrpc` per package under `GRPC_PACKAGES[name].clientToken`. It also exports `GrpcCircuitBreakers` and the `grpc` config namespace.                                                                                                             |
| `createGrpcClientOptions(cfg, name, extras?)` / `buildGrpcServiceConfig(services, { timeoutMs, maxAttempts? })`                                                                      | Client options with a service config: per-call deadline, `UNAVAILABLE` retries plus retry throttling, `round_robin`, keepalive, and reconnect backoff.                                                                                                   |
| `grpcCall(source$, { timeoutMs, operation, breaker? })`                                                                                                                              | Runs one unary call: rxjs deadline (unsubscribing cancels the call), then the breaker, then maps any failure to a `DomainException`.                                                                                                                     |
| `GrpcCircuitBreakers` (`get(name)`, `states()`), `isCallerError`, `DEFAULT_GRPC_CIRCUIT_BREAKER_OPTIONS`                                                                             | One opossum 10 breaker per upstream. Caller errors (`NOT_FOUND`, `INVALID_ARGUMENT`, …) never open the circuit.                                                                                                                                          |
| `exceptionToGrpcError`, `domainExceptionToGrpcStatus`                                                                                                                                | Server side: `DomainException`, `HttpException`, zod errors, Nest `GrpcException`/`RpcException` and unknown errors become a status, a message, and `x-error-code` / `x-error-details-bin` trailers.                                                     |
| `grpcErrorToDomainException`, `grpcStatusToDomainException`                                                                                                                          | Client side: `ServiceError`, rxjs `TimeoutError` and opossum rejections become a `DomainException`. Details are hidden for 5xx-class statuses.                                                                                                           |
| `GRPC_STATUS_TO_HTTP_STATUS`, `HTTP_STATUS_TO_GRPC_STATUS`, `httpStatusFromGrpcStatus`, `grpcStatusFromHttpStatus`, `isServerSideGrpcStatus`, `grpcStatusName`, `isGrpcServiceError` | Mapping tables and helpers.                                                                                                                                                                                                                              |
| `RpcStatusException`                                                                                                                                                                 | Upstream `RESOURCE_EXHAUSTED` (429) / `UNIMPLEMENTED` (501), which `@app/common` has no class for.                                                                                                                                                       |
| `createOutgoingMetadata(ctx)`, `readIncomingMetadata(md)`, `createErrorTrailers`, `readErrorTrailers`, `isGrpcMetadata`, `GRPC_METADATA_KEYS`                                        | Metadata for request id, correlation id, user id and roles, and error trailers. Unsafe values are dropped.                                                                                                                                               |
| `callerContextFromCls(cls, overrides?)`                                                                                                                                              | Caller context for an outgoing call, built from nestjs-cls (request id, correlation id, incoming caller).                                                                                                                                                |
| `@GrpcController()`                                                                                                                                                                  | Composite decorator: `Controller()` + `UseFilters(DomainToGrpcExceptionFilter)` + `UseInterceptors(GrpcContextInterceptor)`.                                                                                                                             |
| `@GrpcServerCall()`                                                                                                                                                                  | Injects the raw grpc-js call (`call.cancelled`, `getDeadline()`).                                                                                                                                                                                        |
| `DomainToGrpcExceptionFilter`, `GrpcContextInterceptor`                                                                                                                              | Controller-scoped error mapping, and a nestjs-cls context per call (the request id is adopted from metadata).                                                                                                                                            |
| `ZodRpcValidationPipe(schema, message?)`                                                                                                                                             | Payload validation that throws `DomainValidationException`, which reaches the client as `INVALID_ARGUMENT` with the issues.                                                                                                                              |

### Kafka

| Export                                                                                                                                                                             | What it is for                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createKafkaServerOptions(cfg, { groupId? })`                                                                                                                                      | Consumer options: `postfixId: ''`, no topic auto-creation, `consumer.retry.retries: 8`, `partitionsConsumedConcurrently`, `autoCommit` (at-least-once), and an idempotent producer for dead-lettering. |
| `createKafkaClientOptions(cfg)` / `createKafkaClientConfig(cfg, clientId?)`                                                                                                        | Producer-only client: idempotent, `acks: -1`, `DefaultPartitioner`, GZIP. No client-level `retries`.                                                                                                   |
| `KafkaProducerModule.forRootAsync({ source?, eagerConnect?, connectRetry? })`                                                                                                      | Global module: `KAFKA_PRODUCER_CLIENT`, `KafkaProducer`, `KafkaHealthIndicator`, and the exported `kafka` namespace.                                                                                   |
| `KafkaProducer`                                                                                                                                                                    | `publish(topic, payload, { key?, correlationId?, eventId?, occurredAt? })` resolves with the envelope once the broker acks it. Also `createEnvelope`, `createRecord` and `connect()`.                  |
| `FakeKafkaProducer`                                                                                                                                                                | Drop-in for tests. It validates like the real producer and records instead of sending (`published(topic)`, `envelopes(topic)`, `failNextWith()`, `clear()`).                                           |
| `@KafkaEventPattern(topic)`                                                                                                                                                        | `EventPattern<string>(topic, Transport.KAFKA)`. Works around TS1241 and accepts only `KafkaTopic` or its `.dlq`.                                                                                       |
| `ParseEventEnvelopePipe(topic)`                                                                                                                                                    | Returns the typed `EventEnvelopeFor<T>`. Throws `InvalidEventException` (422, `INVALID_EVENT`), which also covers a wrong `type` or `version`.                                                         |
| `KafkaDeadLetterFilter`                                                                                                                                                            | Sends any failure to `<topic>.dlq` with error headers and emits `null` so the offset commits. It rethrows `KafkaRetriableException`, and rethrows when the dead-letter publish itself fails.           |
| `@KafkaConsumerController()`, `KafkaContextInterceptor`                                                                                                                            | `Controller()` + `KafkaDeadLetterFilter` + a nestjs-cls context per message (the event id becomes the request id, and the correlation id is taken from the header or the envelope).                    |
| `KafkaHealthIndicator`                                                                                                                                                             | Readiness contributor `kafka`: `describeCluster` through a reused admin client (no retries at all — neither requests nor the broker connect), with a timeout and a short result cache.                 |
| `buildDeadLetterRecord`, `sendToDeadLetter`, `errorTypeOf`, `DEAD_LETTER_HEADERS`, `KAFKA_ERROR_CODES`, `KAFKA_PRODUCER_CLIENT`, `KAFKA_PRODUCER_OPTIONS`, `InvalidEventException` | Building blocks and tokens.                                                                                                                                                                            |

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

- `grpc`: `GRPC_URL`, `IDENTITY_GRPC_URL`, `NOTIFICATIONS_GRPC_URL`, `BILLING_GRPC_URL`, `GRPC_DEADLINE_MS`, `GRPC_MAX_MESSAGE_BYTES`.
- `kafka`: `KAFKA_BROKERS`, `KAFKA_CLIENT_ID`, `KAFKA_GROUP_ID`, `KAFKA_CONSUMER_CONCURRENCY`, `KAFKA_SSL`, `KAFKA_SASL_MECHANISM`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, `KAFKA_CONNECTION_TIMEOUT_MS`, `KAFKA_REQUEST_TIMEOUT_MS`.
- `app`: `SERVICE_NAME`, used as the envelope `source` and as the default client and group id.

## Gotchas

- **gRPC filters must be controller-scoped.** Use `@GrpcController()`. A global RPC filter combined with `inheritAppConfig: true` makes HTTP requests hang.
- **Param decorators on a gRPC handler drop the default `(request, metadata, call)` injection.** Declare `@Ctx()` and `@GrpcServerCall()` explicitly, and keep them optional. Bind pipes with `@Payload(pipe)`, never with `@UsePipes`.
- **Optional message fields decode as `null`.** With `defaults: true`, absent message fields decode as `null`, not `undefined`, so check them with `== null`.
- **Timestamp ↔ Date needs the generated modules loaded.** It only works once `@app/contracts` has been imported as values, which this package does.
- **Kafka handlers must never throw.** A thrown error is redelivered forever. Always use `@KafkaConsumerController()` (or `@UseFilters(KafkaDeadLetterFilter)`) and keep handlers idempotent: delivery is at-least-once, and a failed dead-letter publish is redelivered.
- **Topics must exist before consumers start.** Auto-creation is off, so the three topics and their `.dlq` topics must exist, or `startAllMicroservices()` fails.
- **Call `connect*()` in the right order.** Call it after all `app.useGlobal*()` calls and before `startAllMicroservices()`. Every global enhancer must branch on `context.getType()`.
- **`KafkaHealthIndicator` never retries.** kafkajs' `admin({ retry })` only covers admin requests; `admin.connect()` uses the client-level cluster retrier, so the health client also sets `retry.retries: 0` on the client (safe: it never produces). Otherwise a broker outage kept a connect loop running for tens of seconds after the check timed out, and SIGTERM waited for it; shutdown now also bounds the disconnect (2 s).
- **`KafkaHealthIndicator` needs the `kafka` namespace.** It resolves it through the global `KafkaProducerModule`. Processes without that module must load it themselves.
- **Class checks are realm-safe.** Bun installs one copy of `@nestjs/microservices` per peer set, and the `@nestjs/core` the apps run links a different copy than this package imports. `app.connectMicroservice()` builds `KafkaContext`, `RpcException` and friends from `@nestjs/core`'s copy, so `instanceof` against our import is false in every app (dead-lettering and the Kafka CLS context were silently disabled). `KafkaDeadLetterFilter`, `KafkaContextInterceptor` and `exceptionToGrpcError` therefore use `isKafkaContext()` (structural) and `isInstanceAcrossRealms()` (class name on the prototype chain), both exported. Use them for any new check against a `@nestjs/microservices` class.
- **Name clash with `@nestjs/common`.** The `ServiceUnavailableException` returned by the mappers comes from `@app/common`, not from `@nestjs/common`.
