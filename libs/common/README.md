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
| Context           | `getContextType(ctx)`, `getRequest<T>(ctx)`, `getHeaderValue(headers, name)`, `AppContextType`, `RequestLike`                                                                                                                                                                                                            | http / graphql / ws / rpc without importing `@nestjs/graphql`                                                                     |
| Errors            | `DomainException` (abstract) + `EntityNotFoundException`, `DomainConflictException`, `DomainValidationException`, `UnauthenticatedException`, `PermissionDeniedException`, `BusinessRuleViolationException`, `ExternalServiceException`, `ServiceUnavailableException`, `OperationTimeoutException`, `isDomainException` | `options: { details?, cause?, code? }`                                                                                            |
| Error codes       | `ErrorCode` (const + type), `errorCodeForStatus(status)`                                                                                                                                                                                                                                                                 | stable machine codes                                                                                                              |
| Problem details   | `ProblemDetails`, `toProblemDetails(exception, ctx)`, `DEFAULT_PROBLEM_TYPE_BASE_URL`                                                                                                                                                                                                                                    | one mapper for every transport                                                                                                    |
| Database errors   | `translateInfrastructureError(e)`, `SYSTEM_DATABASE_UNAVAILABLE`                                                                                                                                                                                                                                                         | `@platform/database` errors (by `name` + `code`) → 403 / 503 (the rest stay 500); used by `toProblemDetails` and the gRPC mapping |
| Validation issues | `ValidationIssue`, `IssueLike`, `toValidationIssues(issues)`                                                                                                                                                                                                                                                             | shape of `ProblemDetails.errors`                                                                                                  |
| Filter            | `AllExceptionsFilter`, `ExceptionsFilterOptions`                                                                                                                                                                                                                                                                         | problem+json (http), passthrough (graphql), `exception` event / ack (ws), rethrow (rpc)                                           |
| Interceptor       | `TimeoutInterceptor`                                                                                                                                                                                                                                                                                                     | http + graphql only, first emission only                                                                                          |
| Middleware        | `CorrelationIdMiddleware`, `MaintenanceModeMiddleware`, `MaintenanceModeOptions`, `MaintenanceModeSwitch`, `DEFAULT_MAINTENANCE_MODE_OPTIONS`, `RawRequest`, `RawResponse`, `requestPath()`                                                                                                                              | raw Node req/res (Fastify middie); `isMaintenanceEnabled(switch)`, `maintenanceProblem()` serve the sockets                       |
| Pipes             | `createValidationPipe(overrides?)`, `createStandardSchemaValidationPipe(overrides?)`, `AppValidationPipe`, `flattenValidationErrors()`, `ValidationErrorBody`                                                                                                                                                            | both 400 with identical `errors[]`                                                                                                |
| Providers         | `provideCommonEnhancers(opts?)`, `provideCommonEnhancersAsync({ inject, useFactory })`, `CommonEnhancersOptions`                                                                                                                                                                                                         | APP_PIPE ×2, APP_FILTER, APP_INTERCEPTOR + option tokens                                                                          |
| DTO               | `CursorPaginationQueryDto` (`limit = 20` 1..100, `cursor?` ≤ 512), `CursorPage<T>`, `DEFAULT_PAGE_LIMIT`, `MAX_PAGE_LIMIT`                                                                                                                                                                                               | swagger-free; extend it                                                                                                           |
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
  consumers `@UseFilters(KafkaDeadLetterFilter)` — a throwing Kafka handler is redelivered forever.
- Problem bodies never contain `statusCode` (FastifyAdapter would rewrite the content type to JSON).
- On Fastify, Nest middleware receives the **raw** Node `req`/`res`; use `RawRequest` and `requestPath()`
  (`originalUrl`, query stripped). Headers set on the raw response survive the Fastify reply.
- `ServiceUnavailableException` collides with `@nestjs/common`'s, `Timeout` with `@nestjs/schedule`'s — alias
  on import.
- `TimeoutInterceptor` can't cancel the handler's promise; pass an `AbortSignal` down where supported.
- `decodeCursor` treats cursors as untrusted input: bad input is a 422 `INVALID_CURSOR`, never a 500.

## Tenancy kernel (`src/tenancy`)

- `TENANT_ROLES` (`owner` ⊇ `admin` ⊇ `member`), `isTenantRole`, `impliedTenantRoles`, `satisfiesTenantRole`,
  `normalizeTenantRoles`.
- `PLATFORM_TENANT_ID`: the nil UUID, the tenant of platform-level rows; never a tenant, never a principal's tenant.
- `Principal` (`userId`, `tenantId | null`, `roles`, `staff`) built only by `createPrincipal` (401
  `INVALID_PRINCIPAL` on a malformed id, the platform tenant, or roles/staff without a tenant).
- CLS accessors over nestjs-cls' process-wide `ClsService`: `getPrincipal`, `requirePrincipal` (401
  `PRINCIPAL_MISSING`), `setPrincipal` (needs an active context), `runWithPrincipal`. Writers: see the B2 plan, I-2.
