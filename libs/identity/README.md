# @app/identity

The identity bounded context: user accounts, registration, login (Argon2id + access/refresh
JWTs), refresh-token rotation with **reuse detection**, logout (access-token denylist) and RBAC
role administration. It exposes REST, GraphQL and gRPC over CQRS, with hexagonal ports so the same
presentation classes run in the monolith (in-process) and in the gateway (over gRPC).

## Layers

```
src/
├── domain/                 UserAggregate, UserRegisteredEvent, UserRolesChangedEvent, session rules,
│                           identity errors, USER_ROLES (pure TS: @nestjs/cqrs, @app/common, lodash)
├── application/
│   ├── commands/           RegisterUser, Login, RefreshSession, Logout, UpdateUserRoles, PurgeExpiredSessions
│   ├── queries/            GetUserById, GetUsersByIds, ListUsers
│   ├── event-handlers/     UserRegisteredRelay (→ Kafka), UserRolesChangedAuditHandler
│   ├── ports/              AuthPort, UsersPort (abstract classes, @app/contracts types)
│   ├── persistence/        UsersRepository, SessionsRepository, TransactionRunner (abstractions)
│   ├── services/           SessionTokensService (open session + issue the token pair)
│   └── mappers/            contract/record/request mappers
├── infrastructure/
│   ├── persistence/        identity.schema.ts (Drizzle), Drizzle repositories, DrizzleTransactionRunner
│   ├── adapters/local/     AuthLocalAdapter, UsersLocalAdapter (CommandBus / QueryBus)
│   ├── adapters/grpc/      AuthGrpcAdapter, UsersGrpcAdapter, IdentityGrpcCaller (deadline + breaker + metadata)
│   └── scheduling/         PurgeExpiredSessionsCron (@Cron hourly + @WithLock)
└── presentation/
    ├── http/               AuthController, UsersController, DTOs, response classes, LocalStrategy, LoginRequestGuard
    ├── graphql/            UsersResolver, AuthResolver, UserModel, AuthPayloadModel, UserConnectionModel,
    │                       RoleEnum, inputs/args, UsersLoaderRegistrar (`users` DataLoader)
    ├── grpc/               AuthGrpcController, UsersGrpcController, zod payload schemas
    └── shared/             UserReadCache (AppCacheService), access policy, transforms, user view
```

Presentation depends only on the ports. The application layer depends on repository
abstractions; only `IdentityCoreModule` knows they are Drizzle/Postgres.

## Modules and app wiring

| Module                                  | Contents                                                                                                                                  | Used by                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `IdentityCoreModule`                    | command/query/event handlers, relay, repositories (Drizzle), `TransactionRunner`, `SessionTokensService`, cron                            | monolith, identity-service |
| `IdentityGrpcModule`                    | `IdentityCoreModule` + `AuthGrpcController`, `UsersGrpcController`                                                                        | identity-service           |
| `IdentityApiModule.forLocal()`          | REST controllers, GraphQL resolvers, `LocalStrategy`, `UserReadCache`, `users` DataLoader + ports → local adapters + `IdentityCoreModule` | monolith                   |
| `IdentityApiModule.forRemote(options?)` | same presentation + ports → gRPC adapters + `GrpcClientsModule.register(['identity'], options)`                                           | gateway                    |

The modules assume these app-level (global) modules:

| App              | Required global modules                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| monolith         | `AppConfigModule`, `ObservabilityModule`, `CqrsModule.forRoot()`, `ScheduleModule.forRoot()`, `DatabaseModule.forRootAsync({ schema: { ...identitySchema, ...billingSchema } })`, `RedisModule`, `AppCacheModule`, `AuthModule` (before `AppThrottlerModule`), `AppThrottlerModule`, `KafkaProducerModule`, `AppGraphqlModule` |
| gateway          | `AppConfigModule`, `ObservabilityModule`, `RedisModule`, `AppCacheModule`, `AuthModule`, `AppThrottlerModule`, `AppGraphqlModule` (no DB, no CQRS, no Kafka producer needed for identity)                                                                                                                                      |
| identity-service | `AppConfigModule`, `ObservabilityModule`, `CqrsModule.forRoot()`, `ScheduleModule.forRoot()`, `DatabaseModule.forRootAsync({ schema: identitySchema })`, `RedisModule` (denylist + locks), `KafkaProducerModule`, `AuthModule.forRootAsync({ globalGuards: false })`; `main.ts`: `connectGrpcServer(app, ['identity'])`        |

```ts
// apps/monolith/src/app.module.ts
import { IdentityApiModule, identitySchema } from '@app/identity';
imports: [
  CqrsModule.forRoot(),
  ScheduleModule.forRoot(),
  DatabaseModule.forRootAsync({ schema: { ...identitySchema, ...billingSchema } }),
  RedisModule.forRootAsync(),
  AppCacheModule.forRootAsync(),
  AuthModule.forRootAsync(),
  AppThrottlerModule.forRootAsync(),
  KafkaProducerModule.forRootAsync(),
  AppGraphqlModule.forRootAsync(),
  IdentityApiModule.forLocal(),
];

// apps/gateway/src/app.module.ts
imports: [, /* edge infra */ IdentityApiModule.forRemote()];

// apps/identity-service/src/app.module.ts
imports: [
  CqrsModule.forRoot(),
  ScheduleModule.forRoot(),
  DatabaseModule.forRootAsync({ schema: identitySchema }),
  RedisModule.forRootAsync(),
  KafkaProducerModule.forRootAsync(),
  AuthModule.forRootAsync({ globalGuards: false }),
  IdentityGrpcModule,
];
```

Other domains use `UserModel` for GraphQL fields and the `users` DataLoader (typed through a
`GraphqlLoaders` augmentation that ships with this package):

```ts
import { USERS_LOADER, UserModel } from '@app/identity';

@ResolveField(() => UserModel, { nullable: true, complexity: 5 })
user(@Parent() payment: PaymentModel, @Loader(USERS_LOADER) users: GraphqlLoaders['users']) {
  return users.load(payment.userId); // all loads of one operation → ONE getUsersByIds
}
```

No Kafka consumer group is needed: identity only **produces** `identity.user-registered.v1`.

## Flows

- **Register**: normalise email → pre-check `existsByEmail` (skips argon2 for duplicates) →
  argon2id hash → `UserAggregate.register()` → **one transaction** (`TransactionRunner` on
  `TransactionHost`): insert user + first session → commit → `UserRegisteredEvent` →
  `UserRegisteredRelay` → `KafkaProducer.publish(USER_REGISTERED, …, { key: userId, eventId })`.
  The unique constraint still decides under races (`23505` → `EMAIL_TAKEN`).
- **Login** (REST: `LoginRequestGuard` → `LocalAuthGuard` → `LocalStrategy` → `AuthPort.login`;
  GraphQL: `AuthPort.login`): unknown email burns `verifyDummy` (equal timing), wrong password and
  unknown email share one 401 `INVALID_CREDENTIALS`. Outdated argon2 parameters are re-hashed
  transparently (best effort).
- **Tokens**: access JWT (15 min, HS256, `jti` uuidv7) and refresh JWT (7 d, separate secret,
  `jti` = session id). The `sessions` row stores `sha256(refreshToken)` only.
- **Refresh rotation**: verify the JWT (no DB access for garbage) → one transaction:
  `UPDATE sessions SET revoked_at, replaced_by_id WHERE id AND user_id AND refresh_token_hash AND
revoked_at IS NULL AND expires_at > now RETURNING id` (compare-and-set: concurrent refreshes of
  one token cannot both win) + insert the successor. If nothing matched: a genuine token whose
  session is already revoked is **reuse** → every session of the user is revoked (outside the
  rotation transaction, so the following throw cannot roll it back) → 401 `REFRESH_TOKEN_REUSED`.
- **Logout**: denylist the access `jti` in Redis for its remaining lifetime, then revoke the
  session of `refreshToken`, or every session when it is omitted ("sign out everywhere").
- **Role change**: `UserAggregate.changeRoles()` (known roles, non-empty, an admin cannot drop
  their own admin role) → `UPDATE users SET roles` → `UserRolesChangedEvent` (audit log). Takes
  effect on the user's next refresh (≤ access TTL). The edge cache entry `user:{id}` is evicted.
- **Purge**: hourly `PurgeExpiredSessionsCron` (`@WithLock('identity:purge-sessions', 60 s)`)
  deletes expired sessions in batches of 5 000. Revoked-but-unexpired sessions are kept on
  purpose: they make reuse detectable until the token itself expires.

## REST (URI version `v1`, problem+json errors)

| Method | Path                  | Auth                       | Body / query                               | Success                                      | Errors                                                                        |
| ------ | --------------------- | -------------------------- | ------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------- |
| POST   | `/v1/auth/register`   | `@Public`, `@AuthThrottle` | `{ email, password (8–128), displayName }` | 201 `AuthTokensResponse`                     | 400, 409 `EMAIL_TAKEN`, 429                                                   |
| POST   | `/v1/auth/login`      | `@Public`, `@AuthThrottle` | `{ email, password }` (passport-local)     | 200 `AuthTokensResponse`                     | 400, 401 `INVALID_CREDENTIALS` / `MISSING_CREDENTIALS`, 429                   |
| POST   | `/v1/auth/refresh`    | `@Public`                  | `{ refreshToken }` (JWT)                   | 200 `AuthTokensResponse`                     | 400, 401 `INVALID_REFRESH_TOKEN` / `SESSION_EXPIRED` / `REFRESH_TOKEN_REUSED` |
| POST   | `/v1/auth/logout`     | bearer                     | `{ refreshToken? }`                        | 204                                          | 401                                                                           |
| GET    | `/v1/auth/me`         | bearer                     | –                                          | 200 `UserResponse`                           | 401                                                                           |
| GET    | `/v1/users`           | `users:read`               | `?limit (1–100)&cursor&search`             | 200 `UserPageResponse`                       | 400, 401, 403, 422 `INVALID_CURSOR`                                           |
| GET    | `/v1/users/:id`       | self, or `users:read`      | `:id` uuidv7 (`ParseUUIDPipe`)             | 200 `UserResponse` (cached `user:{id}` 30 s) | 400, 401, 403, 404                                                            |
| PATCH  | `/v1/users/:id/roles` | `users:manage-roles`       | `{ roles: Role[] }`                        | 200 `UserResponse` (evicts the cache)        | 400, 401, 403, 404, 422 `CANNOT_REVOKE_OWN_ADMIN`                             |

DTOs are class-validator classes with `@ApiProperty` and `@Transform` normalisation (trimmed,
lowercased email; trimmed names/search). Responses are `@Exclude()`/`@Expose()` allow-list
classes serialised by a controller-level (HTTP-only) `ClassSerializerInterceptor`.

## GraphQL (code-first)

| Operation                                                      | Auth                  | Returns          |
| -------------------------------------------------------------- | --------------------- | ---------------- |
| `query me`                                                     | bearer                | `User`           |
| `query user(id: UUID!)`                                        | self or `users:read`  | `User`           |
| `query users(limit: Int = 20, cursor: String, search: String)` | `users:read`          | `UserConnection` |
| `mutation register(input: RegisterInput!)`                     | public, auth throttle | `AuthPayload`    |
| `mutation login(input: LoginInput!)`                           | public, auth throttle | `AuthPayload`    |
| `mutation refreshTokens(input: RefreshTokensInput!)`           | public                | `AuthPayload`    |
| `mutation updateUserRoles(input: UpdateUserRolesInput!)`       | `users:manage-roles`  | `User`           |

Types: `User { id: UUID!, email, displayName, roles: [Role!]!, createdAt: DateTime!, updatedAt: DateTime! }`,
`AuthPayload`, `UserConnection { items, nextCursor }`, `enum Role { ADMIN MODERATOR USER }` (internal
values = `@app/auth` `Role`). Every input field carries class-validator decorators.

## gRPC (`identity.v1`, served by identity-service)

| Service        | RPC               | Dispatches                  |
| -------------- | ----------------- | --------------------------- |
| `AuthService`  | `Register`        | `RegisterUserCommand`       |
|                | `Login`           | `LoginCommand`              |
|                | `RefreshTokens`   | `RefreshSessionCommand`     |
|                | `Logout`          | `LogoutCommand` (→ `Empty`) |
| `UsersService` | `GetUser`         | `GetUserByIdQuery`          |
|                | `GetUsersByIds`   | `GetUsersByIdsQuery`        |
|                | `ListUsers`       | `ListUsersQuery`            |
|                | `UpdateUserRoles` | `UpdateUserRolesCommand`    |

Controllers use `@GrpcController()` + the generated `…ServiceControllerMethods()` and validate
payloads with `ZodRpcValidationPipe` (`INVALID_ARGUMENT` + issues). Domain codes survive the hop
(`x-error-code` trailer). The gateway adapters apply `GRPC_DEADLINE_MS`, the `identity` circuit
breaker and caller metadata, and normalise proto-loader `null`s.

## Events

| Topic                         | Direction | Key      | Payload                                        |
| ----------------------------- | --------- | -------- | ---------------------------------------------- |
| `identity.user-registered.v1` | produced  | `userId` | `{ userId, email, displayName, registeredAt }` |

Envelope id = the domain event id (idempotent consumers). Publishing is after commit; failures are
logged, never thrown. A transactional outbox (event row in the same transaction + relay) would
close the "committed but not published" window; it is not implemented.

## Data model (`identity.schema.ts` → `identitySchema`)

- `user_role` enum: `admin`, `moderator`, `user`.
- `users`: `id uuid PK DEFAULT uuidv7()` (the app supplies uuidv7 ids), `email text UNIQUE`
  (`users_email_unique`, stored normalised), `password_hash`, `display_name`,
  `roles user_role[] DEFAULT ARRAY['user']`, `created_at`, `updated_at` (`$onUpdate`).
- `sessions`: `id uuid PK` (= refresh `jti`), `user_id → users ON DELETE CASCADE`,
  `refresh_token_hash`, `user_agent`, `ip`, `expires_at`, `revoked_at`, `replaced_by_id`,
  `created_at`; indexes `sessions_user_id_idx`, `sessions_expires_at_idx`.
- Keyset pagination on `users.id DESC` uses the PK. For large user bases, add a `pg_trgm` GIN
  index for the `ILIKE` search in a hand-written migration (see the schema comment).

The schema file imports only `drizzle-orm` and a dependency-free relative file, so drizzle-kit can
load it. Migrations are generated centrally in `@app/database`.

## Configuration

Read through `@app/config` namespaces: `auth` (`JWT_*`, `ARGON2_*`, `AUTH_DENYLIST_ENABLED`),
`grpc` (`IDENTITY_GRPC_URL`, `GRPC_DEADLINE_MS`) for the gateway, `throttle`
(`THROTTLE_AUTH_LIMIT` / `THROTTLE_AUTH_TTL_MS` for `@AuthThrottle`), `redis` (key prefix of
locks, denylist and cache).

## Tests

`bunx vitest run --project identity` needs no infrastructure:

- domain: aggregate invariants/events, session rules, role list vs `@app/auth`;
- every command/query handler with mocked repositories/ports (rotation order, reuse detection
  outside the transaction, timing-safe login, rehash, batching/order of `GetUsersByIds`, …);
- repositories: Drizzle's real query building over a fake postgres.js client (exact SQL, keyset,
  ILIKE escaping, unique-violation mapping through `DrizzleQueryError`);
- relay (`FakeKafkaProducer`, failure path), cron (`@Cron` metadata + `@WithLock` skip), mappers,
  normalisers, local adapters;
- REST through a Fastify test app with real JWTs and global guards (201/200/204, 400 validation,
  401/403 RBAC, 404/409/422 domain errors, cache + invalidation, allow-listed responses);
- GraphQL through `AppGraphqlModule` (Apollo on Fastify): enum mapping, guards, validation,
  domain codes, `users` DataLoader batching;
- gRPC round trip: `IdentityApiModule.forRemote()` adapters ↔ a real in-process gRPC server with
  the identity controllers (validation, mapping, null normalisation, error codes across the hop);
- compositions: `IdentityApiModule.forLocal()` (real CQRS + handlers + repositories, fake
  Postgres/Redis/Kafka: register → SQL → Kafka event, login with real argon2) and
  `IdentityGrpcModule`. Billing's `billing-identity.composition.spec.ts` composes this lib with
  billing in one GraphQL app (`Payment.user` through the `users` loader).

Integration (Docker): `INTEGRATION=1 bunx vitest run --project identity:int` runs
`infrastructure/persistence/users.repository.int-spec.ts` on PostgreSQL 18 (testcontainers, or an
existing throwaway database via `INTEGRATION_DATABASE_URL`). It boots the real `DatabaseModule`, which
applies the generated `@app/database` migrations, then covers the repositories: the hash-free
projection, `users_email_unique` → `EMAIL_TAKEN`, `findByIds`, keyset + literal ILIKE search,
`user_role[]` updates, DB defaults, the session FK cascade and compare-and-set rotation.

## Gotchas

- Roles live in the access token: role changes apply after the next refresh (≤ 15 min). Reuse
  detection revokes refresh sessions only; outstanding access tokens expire on their own.
- Reuse detection is strict: two concurrent refreshes of the same token revoke the whole family
  (the loser sees a revoked session). Clients must serialise refreshes.
- `LoginRequestGuard` validates the login body because guards run before pipes; errors raised
  inside passport would otherwise become 401s.
- The GraphQL spec uses plain `vi.fn()` objects for its fakes. That was a workaround for an old
  `@app/testing` `createMock()` bug, now fixed: `createMock()` works as a provider in GraphQL apps too.
