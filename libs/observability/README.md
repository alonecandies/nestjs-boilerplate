# @app/observability

Everything a process needs to be observable, wired by one global module: **pino JSON logs**
(nestjs-pino) with `requestId` + `trace_id`/`span_id` on every line, a **request context**
(nestjs-cls) for HTTP, GraphQL, gRPC, Kafka and WebSocket handlers, **Prometheus** `/metrics`
(prom-client), **terminus** health probes, **OpenTelemetry** tracing (ESM preload + nestjs-otel
helpers) and **`@nestjs/observe`** (only when its credentials are configured).

One request id everywhere: `resolveRequestId()` is Fastify's `genReqId`, pino-http's `genReqId` and
nestjs-cls' `idGenerator`, so `request.id`, the log field `requestId`, `cls.getId()`, the
`x-request-id` response header and the Observe trace id are the same value. A valid incoming
`x-request-id` (≤ 128 chars of `[A-Za-z0-9._:-]`) is adopted; anything else is replaced by a UUIDv7.

## Public API

| Export                                                                                            | Signature / notes                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ObservabilityModule.forRoot(opts?)`                                                              | `(opts?: ObservabilityModuleOptions) => DynamicModule` (global). Options: `healthContributors?: Type<HealthContributor>[]`, `readinessTimeoutMs?` (3000), `shutdownDrainMs?` (0), `exposeHealthDetails?` (!prod), `observe?` (default: both `OBSERVE_*` creds set) |
| `HealthContributor`                                                                               | `abstract class { abstract readonly key: string; abstract check(): Promise<HealthIndicatorResult> }` — implemented by infra libs (Postgres, Redis, Cassandra, Kafka)                                                                                               |
| `HealthController`                                                                                | `GET /health/live` (no dependency checks, always 200 while the process runs), `GET /health/ready` (all contributors in parallel, each bounded by the timeout; 503 when one is down or while draining). `@Public()`, VERSION_NEUTRAL, `Cache-Control: no-store`     |
| `HealthContributorRegistry`                                                                       | `contributors: readonly HealthContributor[]` — resolved at `onModuleInit` (reuses exported instances; instantiates unprovided classes); rejects duplicate keys                                                                                                     |
| `MetricsController`                                                                               | `GET /metrics` — `@Public()`, VERSION_NEUTRAL; 404 when `METRICS_ENABLED=false`; cluster-wide aggregate under `runClustered()`                                                                                                                                     |
| `HttpMetricsHook`, `httpMetricLabels(method, route?, status)`                                     | Fastify `onResponse` hook → `http_request_duration_seconds{method,route,status_code}` (buckets 5 ms…5 s); `route` = route template or `UNMATCHED`; names the OTel server span when tracing                                                                         |
| `HTTP_REQUEST_DURATION_SECONDS`, `HTTP_DURATION_BUCKETS`, …                                       | metric constants (`HTTP_METRIC_LABEL_NAMES`, `UNMATCHED_ROUTE`, `METRICS_PATH`)                                                                                                                                                                                    |
| `makeCounterProvider`, `makeGaugeProvider`, …, `InjectMetric`                                     | re-exported from `@willsoto/nestjs-prometheus` for app-specific metrics                                                                                                                                                                                            |
| `RequestContextService`                                                                           | `isActive`, `requestId`, `correlationId` (get/set), `userId` (get/set), `run(fn, { requestId?, correlationId?, userId? })` — all safe outside a context                                                                                                            |
| `RequestContextInterceptor`                                                                       | global (registered by the module): opens a CLS context for rpc/ws/graphql-ws handlers keyed by the caller's id; passes HTTP through                                                                                                                                |
| `CLS_USER_ID`, `CLS_CORRELATION_ID`                                                               | CLS keys (symbols)                                                                                                                                                                                                                                                 |
| `resolveRequestId(req)`                                                                           | `(req: { headers: IncomingHttpHeaders }) => string` — validates/mints and writes the id back to the headers                                                                                                                                                        |
| `requestIdOf(req)`, `incomingCorrelationId(req)`                                                  | reuse `req.id`; valid `x-correlation-id` or `undefined`                                                                                                                                                                                                            |
| `resolveRpcRequestId(ctx)`, `resolveContextRequestId(ctx)`                                        | id from Kafka headers / gRPC metadata (`x-request-id`, else `x-correlation-id`), stable per message; any transport                                                                                                                                                 |
| `buildLoggerParams(obs, app, { sync? })`, `LOG_REDACT_PATHS`                                      | nestjs-pino `Params` (level label, redaction, quiet probes, rpc hooks); `traceContextMixin()`                                                                                                                                                                      |
| `createStandaloneLogger(context, env?)`                                                           | `LoggerService` over pino (sync) for processes without Nest (cluster primary, scripts)                                                                                                                                                                             |
| `TelemetryFlushService`, `flushLogs(timeoutMs?)`                                                  | `onApplicationShutdown` → `shutdownTracing()` + drain pino                                                                                                                                                                                                         |
| `observeInstrument(env?)`                                                                         | `ObserveInstrumentation \| undefined` for `NestFactory.create(…, { instrument })`; `isObserveEnabled(env?)`, `buildObserveOptions(cfg)`, `observeTraceIdGenerator(req)`, `ObserveModule`, `ObserveInstrument`                                                      |
| `Span`, `Traceable`, `CurrentSpan`, `TraceService`                                                | re-exported from nestjs-otel                                                                                                                                                                                                                                       |
| `isTracingEnabled(env?)`, `isTracingActive()`, `shutdownTracing()`                                | from `./otel`                                                                                                                                                                                                                                                      |
| `enableClusterMetricsAggregation()`, `enableClusterMetricsWorker()`, `requestClusterMetrics(ms?)` | node:cluster `/metrics` bridge (used by `@app/bootstrap`)                                                                                                                                                                                                          |

**Subpath `@app/observability/otel`** (imports nothing from Nest): `startTracing({ serviceName?, env? })`,
`shutdownTracing()`, `isTracingEnabled(env?)`, `isTracingActive()`, `type StartTracingOptions`, `type TracingEnv`.

## Usage

```ts
// apps/<app>/src/instrument.ts — preloaded: node --import ./dist/instrument.js dist/main.js
import { startTracing } from '@app/observability/otel';
await startTracing({ serviceName: 'identity-service' });

// app.module.ts
@Module({
  imports: [
    AppConfigModule.forRoot(),
    ObservabilityModule.forRoot({
      healthContributors: [DatabaseHealthIndicator, RedisHealthIndicator, KafkaHealthIndicator],
      shutdownDrainMs: 5_000, // behind a k8s Service / LB
    }),
  ],
})
export class AppModule {}

// anywhere
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name); // → pino JSON with requestId
  constructor(private readonly context: RequestContextService) {}

  @Span('OrdersService.place')
  async place(): Promise<void> {
    this.logger.log(`placing order for ${this.context.userId ?? 'anonymous'}`);
  }
}
```

## Env vars (via `@app/config` `observability`/`app` namespaces)

`LOG_LEVEL` (info), `LOG_PRETTY` (dev only; needs the `pino-pretty` devDependency), `METRICS_ENABLED`
(true), `SERVICE_NAME`, `NODE_ENV`, `OBSERVE_APP_KEY` + `OBSERVE_APP_SECRET` (+ `OBSERVE_SERVICE_ID`,
`OBSERVE_ENDPOINT` read by @nestjs/observe itself). `otel.ts` reads the standard OTel variables
directly: `OTEL_SDK_DISABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
(tracing is on only when one is set, unless `OTEL_SDK_DISABLED` says otherwise), `OTEL_SERVICE_NAME`
(> `SERVICE_NAME` > option), `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL`,
`OTEL_TRACES_SAMPLER[_ARG]`, `OTEL_RESOURCE_ATTRIBUTES`.

## Gotchas

- **Import `AppConfigModule.forRoot()` first** — the module injects the global `app` and
  `observability` namespaces. `forRoot()` reads the env once at definition time to decide whether
  `ObserveModule` exists (pass `observe: false` in tests).
- **Tracing must be preloaded** (`--import`): the ESM hook has to be registered before any
  instrumented module loads. OTel doesn't instrument Nest 12 / graphql 17 / postgres.js yet — use
  `@Span()`/`@Traceable()` on repositories, resolvers and CQRS handlers. HTTP server spans are named
  `GET /v1/users/:id` by `HttpMetricsHook`. Probes and `/metrics` are never traced.
- **Metrics come from a Fastify hook, not an interceptor**, so 404s, guard rejections (401/403),
  429s and filter-mapped statuses are counted. Never put raw URLs/ids in labels. No `service`
  label: Prometheus adds the target identity.
- `/health/ready` hides failure messages in production (they leak hosts/IPs); failures are logged.
  Liveness never checks dependencies — a DB outage must not restart every pod.
- Contributors don't need try/catch: throws, rejections and timeouts become `down`.
- Shutdown flush needs `app.enableShutdownHooks()` (done by `@app/bootstrap`, with
  `useProcessExit` so pino's exit flush also runs).
- `pino-http` augments `http.IncomingMessage` globally with a required `id: ReqId`. Any
  `interface X extends IncomingMessage { id?: … }` then fails to typecheck in every program that
  imports this package — declare such request types as intersections
  (`IncomingMessage & { id?: string | number }`) instead.
- nestjs-pino keeps ONE root logger per process (first params win) — `createStandaloneLogger()` is
  for processes that never boot Nest.
- `@nestjs/observe` runs with `sourceContext: false` (it would upload source around error frames) and
  `forwardLogs: false`; enable deliberately.
