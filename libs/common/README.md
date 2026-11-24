# @platform/common

Transport-agnostic, cross-cutting primitives used by every package: error model (DomainException +
RFC 9457 problem details), global enhancers (catch-all filter, timeout interceptor, validation pipes),
middleware, pagination DTOs and small lodash-backed utilities. **Depends on no other workspace package**
(it must stay at the bottom of the dependency graph) and reads no config itself — apps inject options.

## Public API

| Area              | Export                                                                                                                                                                                                                                                                                                                   | Notes                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Constants         | `HTTP_HEADERS`, `PROBLEM_JSON_CONTENT_TYPE`, `IS_PUBLIC_KEY`, `TIMEOUT_KEY`                                                                                                                                                                                                                                              | lower-case header names                                                                                                           |
| DI tokens         | `EXCEPTIONS_FILTER_OPTIONS`, `DEFAULT_TIMEOUT_MS`, `MAINTENANCE_MODE`, `MAINTENANCE_MODE_OPTIONS`, `COMMON_ENHANCERS_OPTIONS`, `DEFAULT_REQUEST_TIMEOUT_MS`                                                                                                                                                              | all optional, safe defaults                                                                                                       |
| Decorators        | `Public()`, `Timeout(ms)`                                                                                                                                                                                                                                                                                                | `@Timeout(0)` disables the timeout                                                                                                |
| Idempotency       | `IdempotencyKey()` (param decorator), `idempotencyKeySchema`, `IDEMPOTENCY_KEY_MIN_LENGTH` (8), `IDEMPOTENCY_KEY_MAX_LENGTH` (255), `IDEMPOTENCY_KEY_PATTERN`, `IDEMPOTENCY_KEY_FORMAT`                                                                                                                                  | The one `Idempotency-Key` rule (8-255 of `[A-Za-z0-9._:-]`); a bad header is a 400 at `headers.idempotency-key`                   |
| Context           | `getContextType(ctx)`, `getRequest<T>(ctx)`, `getHeaderValue(headers, name)`, `AppContextType`, `RequestLike`                                                                                                                                                                                                            | http / graphql / ws / rpc without importing `@nestjs/graphql`                                                                     |
| Errors            | `DomainException` (abstract) + `EntityNotFoundException`, `DomainConflictException`, `DomainValidationException`, `UnauthenticatedException`, `PermissionDeniedException`, `BusinessRuleViolationException`, `ExternalServiceException`, `ServiceUnavailableException`, `OperationTimeoutException`, `isDomainException` | `options: { details?, cause?, code? }`                                                                                            |
| Error codes       | `ErrorCode` (const + type), `errorCodeForStatus(status)`                                                                                                                                                                                                                                                                 | stable machine codes                                                                                                              |
| Problem details   | `ProblemDetails`, `toProblemDetails(exception, ctx)`, `DEFAULT_PROBLEM_TYPE_BASE_URL`                                                                                                                                                                                                                                    | one mapper for every transport                                                                                                    |
| Database errors   | `translateInfrastructureError(e)`, `SYSTEM_DATABASE_UNAVAILABLE`                                                                                                                                                                                                                                                         | `@platform/database` errors (by `name` + `code`) → 403 / 503 (the rest stay 500); used by `toProblemDetails` and the gRPC mapping |
| Validation issues | `ValidationIssue`, `IssueLike`, `toValidationIssues(issues)`                                                                                                                                                                                                                                                             | shape of `ProblemDetails.errors`                                                                                                  |
| Filter            | `AllExceptionsFilter`, `ExceptionsFilterOptions`                                                                                                                                                                                                                                                                         | problem+json (http), passthrough (graphql), `exception` event / ack (ws), rethrow (rpc)                                           |
| Interceptor       | `TimeoutInterceptor`                                                                                                                                                                                                                                                                                                     | http + graphql only, first emission only                                                                                          |
| Middleware        | `CorrelationIdMiddleware`, `MaintenanceModeMiddleware`, `MaintenanceModeOptions`, `MaintenanceModeSwitch`, `DEFAULT_MAINTENANCE_MODE_OPTIONS`, `RawRequest`, `RawResponse`, `requestPath()`, `createMaintenanceModeReader(moduleRef)`, `WsMaintenanceGuard`, `maintenanceException()`                                    | raw Node req/res (Fastify middie); the reader, the guard, `isMaintenanceEnabled(switch)` and `maintenanceProblem()` serve sockets |
| Pipes             | `createValidationPipe(overrides?)`, `createStandardSchemaValidationPipe(overrides?)`, `AppValidationPipe`, `flattenValidationErrors()`, `ValidationErrorBody`                                                                                                                                                            | both 400 with identical `errors[]`                                                                                                |
| Providers         | `provideCommonEnhancers(opts?)`, `provideCommonEnhancersAsync({ inject, useFactory })`, `CommonEnhancersOptions`                                                                                                                                                                                                         | APP_PIPE ×2, APP_FILTER, APP_INTERCEPTOR + option tokens                                                                          |
| DTO               | `CursorPaginationQueryDto` (`limit = 20` 1..100, `cursor?` ≤ 512), `CursorPage<T>`, `DEFAULT_PAGE_LIMIT`, `MAX_PAGE_LIMIT`, `resolvePageSize(limit, bounds?)`, `PageSizeBounds`                                                                                                                                          | swagger-free; extend it. `resolvePageSize`: absent/0/negative/non-integer → default, else capped                                  |
| Ids               | `generateId()` (UUIDv7), `isUuid`, `isUuidV7`, `uuidV7Timestamp`, `isSafeRequestId`                                                                                                                                                                                                                                      |                                                                                                                                   |
| Cursor            | `encodeCursor(obj)`, `decodeCursor(cursor, zodSchema)`, `MAX_CURSOR_LENGTH`                                                                                                                                                                                                                                              | garbage → 422 `INVALID_CURSOR`                                                                                                    |
| Objects           | `compactObject`, `pickDefined`, `toSnakeCaseKeys(o, { deep? })`, `toCamelCaseKeys(o, { deep? })`, `deepFreeze`                                                                                                                                                                                                           |                                                                                                                                   |
| Async             | `sleep(ms, signal?)`, `retry(fn, opts)`, `computeBackoffDelay`, `mapWithConcurrency(items, n, fn)`, `withTimeout(promise, ms, msg?)`                                                                                                                                                                                     |                                                                                                                                   |
| Crypto            | `sha256Hex`, `timingSafeEqualStr`, `randomTokenBase64Url(bytes = 32)`                                                                                                                                                                                                                                                    |                                                                                                                                   |
| Strings           | `maskEmail`, `toSafeFilename(name, max = 120)`                                                                                                                                                                                                                                                                           |                                                                                                                                   |
| Types             | `Nullable`, `Maybe`, `WrapperType`, `Constructor`, `DeepReadonly`                                                                                                                                                                                                                                                        |                                                                                                                                   |

## Usage

```ts
import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import {
  CorrelationIdMiddleware,
  MaintenanceModeMiddleware,
  provideCommonEnhancersAsync,
} from '@platform/common';
import { type AppConfig, AppConfigModule, appConfig } from '@platform/config';

@Module({
  imports: [AppConfigModule.forRoot()],
  providers: [
    ...provideCommonEnhancersAsync({
      inject: [appConfig.KEY],
      useFactory: (app: AppConfig) => ({
        exposeInternalErrors: !app.isProduction,
        // a bit below Fastify's requestTimeout so the client gets a 504 problem, not a reset socket
        defaultTimeoutMs: app.handlerTimeoutMs, // HTTP_HANDLER_TIMEOUT_MS (30 s)
        maintenanceMode: app.maintenanceMode,
      }),
    }),
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware, MaintenanceModeMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
```

Domain errors:

```ts
export class EmailAlreadyTakenException extends DomainConflictException {
  override readonly code = 'EMAIL_TAKEN';
}
throw new EmailAlreadyTakenException('Email is already registered');
// → 409 application/problem+json
// { type: '…/email-taken', title: 'Email Taken', status: 409, code: 'EMAIL_TAKEN', detail, instance, requestId }
```

## Environment variables

None — this package never reads `process.env`. Values come from `@platform/config` through the option tokens.

## Gotchas

- **Every DTO / `@InputType` field needs ≥ 1 class-validator decorator** (`@IsOptional()`/`@Allow()` at
  least): the global pipe uses `whitelist` + `forbidNonWhitelisted`. Use `@Type(() => Number)` for numbers
  (`enableImplicitConversion` is off).
- The class-validator pipe **skips parameters that declare a Standard Schema** (`@Body({ schema })`), so
  zod-typed params are validated exactly once, by the Standard Schema pipe.
- Both pipes throw `BadRequestException({ message, errors: ValidationIssue[] })`. To render any error
  outside HTTP (GraphQL `formatError`, gRPC), call `toProblemDetails(e, ctx)` rather than parsing
  `getResponse()`.
- `AllExceptionsFilter` already **logs** (5xx → `error` with stack, 4xx → `debug`) for every transport —
  don't log again in `formatError` or RPC filters.
- For RPC it only rethrows: gRPC controllers need `@GrpcController()` (controller-scoped filter) and Kafka
  consumers `@KafkaConsumerController()` (`KafkaDeadLetterFilter` plus in-process retries, the budget and
  heartbeats). An error that escapes it is redelivered forever, and a `TypeError`, `RangeError`,
  `ReferenceError` or `SyntaxError` that reaches kafkajs stops the consumer for good.
- Problem bodies never contain `statusCode` (FastifyAdapter would rewrite the content type to JSON).
- On Fastify, Nest middleware receives the **raw** Node `req`/`res`; use `RawRequest` and `requestPath()`
  (`originalUrl`, query stripped). Headers set on the raw response survive the Fastify reply.
- `ServiceUnavailableException` collides with `@nestjs/common`'s, `Timeout` with `@nestjs/schedule`'s — alias
  on import.
- `TimeoutInterceptor` can't cancel the handler's promise; pass an `AbortSignal` down where supported.
- `decodeCursor` treats cursors as untrusted input: bad input is a 422 `INVALID_CURSOR`, never a 500.
- `MAINTENANCE_MODE` is provided in the root module only (`provideCommonEnhancers*`): an `@Optional()` injection in
  another module gets `undefined`, which reads as off. Read it with `createMaintenanceModeReader(moduleRef)` (looked up
  across modules at the first read; a function switch is called at every read; no switch in the app reads off), or put
  `WsMaintenanceGuard` first in a gateway's `@UseGuards(...)`. Never make that guard an `APP_GUARD`: with
  `inheritAppConfig` it would also wrap the Kafka and gRPC handlers, which keep running during maintenance.
- The reader never throws and fails closed: a function switch that throws, or a lookup that fails for any reason
  but "not provided", reads **on** (Socket.IO is refused with the 503 problem, graphql-ws with 4403, pushes are dropped) and is logged at
  most once per `MAINTENANCE_SWITCH_FAULT_LOG_INTERVAL_MS` (60 s) per reader; a switch not built yet (bootstrap)
  reads off and is looked up again. `MaintenanceModeMiddleware` reads the switch itself, so on HTTP a throwing
  switch is that request's 500, not a crash.
- A function switch must give the same answer on every replica: a push is gated on the switch of the replica that
  emits it, and a cross-replica adapter (Redis) delivers it to sockets held elsewhere, whatever their replica's
  switch says.

## Tenancy kernel (`src/tenancy`)

- `TENANT_ROLES` (`owner` ⊇ `admin` ⊇ `member`), `isTenantRole`, `impliedTenantRoles`, `satisfiesTenantRole`,
  `normalizeTenantRoles`.
- `PLATFORM_TENANT_ID`: the nil UUID, the tenant of platform-level rows; never a tenant, never a principal's tenant.
- `Principal` (`userId`, `tenantId | null`, `roles`, `staff`) built only by `createPrincipal` (401
  `INVALID_PRINCIPAL` on a malformed id, the platform tenant, or roles/staff without a tenant).
- CLS accessors over nestjs-cls' process-wide `ClsService`: `getPrincipal`, `requirePrincipal` (401
  `PRINCIPAL_MISSING`), `setPrincipal` (needs an active context), `runWithPrincipal`. Writers: see the B2 plan, I-2.
- `markTokenVerified` / `isTokenVerified`: marks the frozen principal this process's own access-token verification
  wrote (`writePrincipal` in `@platform/auth`); it throws for anything else, a frozen object that is not a principal
  included. Outside a gRPC call, only a marked principal leaves the process on a gRPC call (`@platform/transport`),
  in plain headers and in a signed principal assertion; one from an event envelope or `runWithPrincipal` makes the
  call anonymous.
