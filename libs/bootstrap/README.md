# @app/bootstrap

The `main.ts` toolkit shared by every app: a production-configured **Fastify** Nest application,
`listen`, **OpenAPI + Scalar** docs, **node:cluster** supervision and process-level safety nets.
Requires the root module to import `AppConfigModule.forRoot()` and `ObservabilityModule.forRoot()`.

## Public API

| Export                                                                   | Signature / notes                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createHttpApp(module, opts?)`                                           | `(module: Type<unknown>, opts?: CreateHttpAppOptions) => Promise<NestFastifyApplication>`. Options: `rawBody?` (false), `multipart?: boolean \| MultipartLimits` (unset = adapter lazy), `cors?`/`cookies?`/`compression?` (true), `helmet?: FastifyHelmetOptions \| false`, `processHandlers?` (!test), `config?`, `appOptions?`                          |
| `configureHttpApp(app, opts?)`                                           | `(app: NestFastifyApplication, opts?: HttpAppSetupOptions) => Promise<void>` — the post-create wiring `createHttpApp` applies (pino logger, process handlers, helmet, compression, cookies, CORS, URI versioning, `shutdownHooks?` (true)). Use it in e2e tests on an app built from a `TestingModule` so overridden providers still get production wiring |
| `createServiceApp(module, opts?)`                                        | same, for gRPC/Kafka services whose port only serves `/health` + `/metrics`: no raw body, multipart, CORS, cookies                                                                                                                                                                                                                                         |
| `buildFastifyOptions(config, { multipart? })`                            | `=> FastifyAdapterOptions` (typed so `new FastifyAdapter(...)` is a default `FastifyAdapter`) — the Fastify server options (trustProxy, bodyLimit, keepAlive/request timeouts, `genReqId: resolveRequestId`, `requestIdHeader: false`, `forceCloseConnections: 'idle'`, `return503OnClosing`, router `maxParamLength: 500`)                                |
| `DEFAULT_MULTIPART_LIMITS`, `MultipartLimits`                            | 25 MiB/file, 10 files, 50 fields, 1 MiB/field, 100 parts                                                                                                                                                                                                                                                                                                   |
| `defaultHelmetOptions(config)`                                           | prod: `default-src 'none'; frame-ancestors 'none'`; dev: + Apollo Sandbox hosts                                                                                                                                                                                                                                                                            |
| `listen(app, { host?, port? })`                                          | `Promise<string>` — binds `HOST`/`PORT`, logs and returns the URL                                                                                                                                                                                                                                                                                          |
| `setupApiDocs(app, opts)`                                                | `(app, { title, description?, version?, path? ('/docs'), excludePathPrefixes? (['/health','/metrics']), configure?(builder), enabled? }) => boolean` — `/openapi.json`, `/openapi.yaml`, Scalar at `/docs` with route-level CSP; no-op unless `DOCS_ENABLED`                                                                                               |
| `OPENAPI_JSON_PATH`, `OPENAPI_YAML_PATH`, `DOCS_CONTENT_SECURITY_POLICY` | constants                                                                                                                                                                                                                                                                                                                                                  |
| `runClustered(bootstrap, opts?)`                                         | `(bootstrap: () => Promise<void>, { workers?, logger?, shutdownTimeoutMs?, restartDelay?: { minMs?, maxMs? } }) => Promise<void>` — 1 worker = just `bootstrap()`                                                                                                                                                                                          |
| `ClusterSupervisor`, `resolveWorkerCount(n)`                             | primary-side supervision (fork, restart with backoff, signal forwarding, SIGKILL deadline); `0` → `os.availableParallelism()`. Types `ClusterLike`, `ClusterWorkerLike`, `SignalSource`, `SupervisorSettings`                                                                                                                                              |
| `installProcessHandlers(logger?, opts?)`                                 | `(logger?: LoggerService, { shutdownTimeoutMs?, exitOnUnhandledRejection? = true }) => () => void` — fatal logging + exit(1) on uncaught errors, warnings → logger, forced-exit timer on SIGTERM/SIGINT; idempotent; returns `uninstall`                                                                                                                   |
| `armShutdownTimer(ms, logger?)`                                          | unref'd timer: exit(1) if graceful shutdown overruns                                                                                                                                                                                                                                                                                                       |

## Usage

```ts
// apps/gateway/src/main.ts  (start: node --import ./dist/instrument.js dist/main.js)
import 'reflect-metadata';
import { createHttpApp, listen, runClustered, setupApiDocs } from '@app/bootstrap';
import { AppModule } from './app.module.js';

await runClustered(async () => {
  const app = await createHttpApp(AppModule, { rawBody: true, multipart: true });
  app.useWebSocketAdapter(await createRedisIoAdapter(app));
  connectKafkaConsumer(app, { groupId: 'gateway-push' });
  setupApiDocs(app, { title: 'Gateway API', version: '1.0.0' });
  await app.startAllMicroservices();
  await listen(app);
});

// apps/identity-service/src/main.ts
const app = await createServiceApp(AppModule);
connectGrpcServer(app, ['identity']);
await app.startAllMicroservices();
await listen(app);
```

### E2E tests with production wiring

```ts
const config = appConfig.parse();
const builder = Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(REDIS_CLIENT)
  .useValue(new InMemoryRedis().asRedis());
const app = await createFastifyTestApp(
  builder,
  (created) => configureHttpApp(created, { config, shutdownHooks: false }),
  { adapter: new FastifyAdapter(buildFastifyOptions(config)), appOptions: { bufferLogs: true } },
);
```

`src/integration.smoke.spec.ts` does exactly this with `AppConfigModule`, `ObservabilityModule`,
`RedisModule` (fake client), `AuthModule` (global guards), `AppThrottlerModule` and the common
enhancers/middleware — it is the cross-library composition check of the infrastructure libs.

## Env vars (via `@app/config` `app` namespace)

`HOST`, `PORT`, `TRUST_PROXY`, `BODY_LIMIT_BYTES`, `HTTP_KEEP_ALIVE_TIMEOUT_MS` (72000),
`HTTP_REQUEST_TIMEOUT_MS` (30000), `CORS_ORIGINS`, `DOCS_ENABLED` (!prod), `CLUSTER_WORKERS` (1; 0 =
per core), `SHUTDOWN_TIMEOUT_MS` (10000), `NODE_ENV`; `OBSERVE_APP_KEY`/`OBSERVE_APP_SECRET` switch on
`@nestjs/observe` instrumentation.

## Gotchas

- **Graceful shutdown**: SIGTERM → terminus drain (`shutdownDrainMs`) → Fastify close (idle
  keep-alive sockets dropped, in-flight requests finish) → `onApplicationShutdown` hooks (telemetry
  flush last) → `process.exit(0)`. Nest's `forceCloseConnections` is deliberately NOT used: it
  destroys in-flight sockets too. `armShutdownTimer` bounds the whole sequence.
- `requestIdHeader` is disabled on purpose: Fastify would adopt ANY incoming `x-request-id`
  unvalidated. `genReqId: resolveRequestId` validates it (and pino/cls reuse the same id).
- `connectionTimeout: 0`: a socket-inactivity timeout would cut socket.io long-polling; slowloris
  is bounded by `requestTimeout` instead. Keep `HTTP_KEEP_ALIVE_TIMEOUT_MS` above the LB idle timeout.
- `abortOnError: false`: boot errors reject `createHttpApp` — let `main.ts` crash (non-zero exit).
- Call `setupApiDocs` after `createHttpApp` (helmet must be registered before the `/docs` route so
  its route-level CSP applies) and before `listen`. `/health*` and `/metrics` are left out of the
  document. Scalar HTML is rendered once, not per request.
- `rawBody: true` keeps a Buffer copy of every JSON body — only enable it where webhooks need it.
- **Cluster mode** is for VMs/bare metal; under Kubernetes keep `CLUSTER_WORKERS=1` and scale pods.
  The primary never boots Nest; `/metrics` returns the aggregate of all workers (IPC bridge in
  `@app/observability`). Workers inherit `execArgv`, so the tracing preload applies to each.
- `processHandlers` defaults off under `NODE_ENV=test`: an `uncaughtException` handler that exits
  would kill the test runner.
