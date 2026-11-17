# @domain/identity

The identity bounded context: user accounts, registration, login (Argon2id + access/refresh
JWTs), refresh-token rotation with **reuse detection**, logout (access-token denylist) and RBAC
role administration. It exposes REST, GraphQL and gRPC over CQRS, with hexagonal ports so the same
presentation classes run in the monolith (in-process) and in the gateway (over gRPC).

## Layers

```
src/
├── domain/                 UserAggregate, UserRegisteredEvent, session rules,
│                           identity errors, tenant roles, normalizeEmail (pure TS: @nestjs/cqrs, @platform/common, lodash)
├── application/
│   ├── commands/           RegisterUser, Login, RefreshSession, Logout, PurgeExpiredSessions
│   ├── queries/            GetUserById, GetUsersByIds, ListUsers
│   ├── event-handlers/     UserRegisteredRelay (→ Kafka)
│   ├── ports/              AuthPort, UsersPort (abstract classes, @domain/identity-contracts types)
│   ├── persistence/        UsersRepository, SessionsRepository, TransactionRunner (abstractions)
│   ├── services/           SessionTokensService (open session + issue the token pair)
│   └── mappers/            contract/record/request mappers
├── infrastructure/
│   ├── persistence/        identity.schema.ts (Drizzle), Drizzle repositories, DrizzleTransactionRunner
│   ├── adapters/local/     AuthLocalAdapter, UsersLocalAdapter (CommandBus / QueryBus)
│   ├── adapters/grpc/      AuthGrpcAdapter, UsersGrpcAdapter, IdentityGrpcCaller (deadline + breaker + metadata)
│   ├── scheduling/         PurgeExpiredSessionsCron (@Cron hourly + @WithLock)
│   └── security/           PasswordHasher (Argon2id; password.config.ts), TokenIssuer (access + refresh
│                           JWTs, refresh verification; refresh-token.config.ts)
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

| Module                                  | Contents                                                                                                                                                                                                                     | Used by                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `IdentityCoreModule`                    | command/query/event handlers, relay, repositories (Drizzle), `TransactionRunner`, `SessionTokensService`, cron, `PasswordHasher` (`password` namespace), `TokenIssuer` (own `JwtModule`; `auth` + `refreshToken` namespaces) | monolith, identity-service |
| `IdentityGrpcModule`                    | `IdentityCoreModule` + `AuthGrpcController`, `UsersGrpcController`                                                                                                                                                           | identity-service           |
| `IdentityApiModule.forLocal()`          | REST controllers, GraphQL resolvers, `LocalStrategy`, `UserReadCache`, `users` DataLoader + ports → local adapters (the app imports `IdentityCoreModule` too)                                                                | monolith                   |
| `IdentityApiModule.forRemote(options?)` | same presentation + ports → gRPC adapters + `GrpcClientsModule.register({ spec: IDENTITY_GRPC_PACKAGE, url }, options)`                                                                                                      | gateway                    |

Entry points: `@domain/identity/api` (edge: `IdentityApiModule`, ports, gRPC client config, GraphQL/REST types;
what the gateway imports), `@domain/identity` (everything in `./api` plus core, persistence, commands, queries,
domain), `@domain/identity/testing` (fakes and `TokenIssuer`, tests only).

The modules assume these app-level (global) modules:

| App              | Required global modules                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| monolith         | `AppConfigModule`, `ObservabilityModule`, `CqrsModule.forRoot()`, `ScheduleModule.forRoot()`, `DatabaseModule.forRootAsync({ schema: { ...identitySchema, ...billingSchema }, migrations: [identityMigrations, billingMigrations] })`, `RedisModule`, `AppCacheModule`, `AuthModule` (before `AppThrottlerModule`), `AppThrottlerModule`, `KafkaProducerModule`, `AppGraphqlModule` |
| gateway          | `AppConfigModule`, `ObservabilityModule`, `RedisModule`, `AppCacheModule`, `AuthModule`, `AppThrottlerModule`, `AppGraphqlModule` (no DB, no CQRS, no Kafka producer needed for identity)                                                                                                                                                                                           |
| identity-service | `AppConfigModule`, `ObservabilityModule`, `CqrsModule.forRoot()`, `ScheduleModule.forRoot()`, `DatabaseModule.forRootAsync({ schema: identitySchema, migrations: [identityMigrations] })`, `RedisModule` (denylist + locks), `KafkaProducerModule`, `AuthModule.forRootAsync({ globalGuards: false })`; `main.ts`: `connectGrpcServer(app, [IDENTITY_GRPC_PACKAGE])`                |

```ts
// apps/monolith/src/app.module.ts
import { IdentityApiModule, IdentityCoreModule, identitySchema } from '@domain/identity';
imports: [
  CqrsModule.forRoot(),
  ScheduleModule.forRoot(),
  DatabaseModule.forRootAsync({
    schema: { ...identitySchema, ...billingSchema },
    migrations: [identityMigrations, billingMigrations],
  }),
  RedisModule.forRootAsync(),
  AppCacheModule.forRootAsync(),
  AuthModule.forRootAsync(),
  AppThrottlerModule.forRootAsync(),
  KafkaProducerModule.forRootAsync(),
  AppGraphqlModule.forRootAsync(),
  IdentityCoreModule,
  IdentityApiModule.forLocal(),
];

// apps/gateway/src/app.module.ts
imports: [, /* edge infra */ IdentityApiModule.forRemote()];

// apps/identity-service/src/app.module.ts
imports: [
  CqrsModule.forRoot(),
  ScheduleModule.forRoot(),
  DatabaseModule.forRootAsync({ schema: identitySchema, migrations: [identityMigrations] }),
  RedisModule.forRootAsync(),
  KafkaProducerModule.forRootAsync(),
  AuthModule.forRootAsync({ globalGuards: false }),
  IdentityGrpcModule,
];
```

Other domains use `UserModel` for GraphQL fields and the `users` DataLoader (typed through a
`GraphqlLoaders` augmentation that ships with this package):

```ts
import { USERS_LOADER, UserModel } from '@domain/identity';

@ResolveField(() => UserModel, { nullable: true, complexity: 5 })
user(@Parent() payment: PaymentModel, @Loader(USERS_LOADER) users: GraphqlLoaders['users']) {
  return users.load(payment.userId); // all loads of one operation → ONE getUsersByIds
}
```

No Kafka consumer group is needed: identity only **produces** its three tenant-scoped events,
`identity.user-registered.v1`, `identity.membership-created.v1` and `identity.membership-removed.v1`.
Each is published after its unit of work committed, with the envelope `tenantId` passed explicitly
(never the caller's CLS principal) and the user id as key. Every handler that writes a membership
publishes `MembershipCreatedEvent` or `MembershipRemovedEvent` (`MembershipEventsRelay`): register
and a login that creates a missing personal workspace, tenant creation, invitation acceptance,
member removal and leave.

## Flows

- **Register**: normalise email → pre-check `existsByEmail` (skips argon2 for duplicates) →
  argon2id hash → `UserAggregate.register()` → **one transaction** (`TransactionRunner` on
  `TransactionHost`): insert user + personal workspace + first session → commit →
  `UserRegisteredEvent` → `UserRegisteredRelay` →
  `KafkaProducer.publish(USER_REGISTERED_EVENT, …, { key: userId, eventId, tenantId })` (the
  workspace id is chosen before the transaction), then `MembershipCreatedEvent` for that workspace.
  The unique constraint still decides under races (`23505` → `EMAIL_TAKEN`).
- **Login** (REST: `LoginRequestGuard` → `LocalAuthGuard` → `LocalStrategy` → `AuthPort.login`;
  GraphQL: `AuthPort.login`): unknown email burns `verifyDummy` (equal timing), wrong password and
  unknown email share one 401 `INVALID_CREDENTIALS`. Outdated argon2 parameters are re-hashed
  transparently (best effort).
- **Tokens**: `TokenIssuer` signs the access JWT (15 min, HS256, `jti` uuidv7; `JWT_ACCESS_*` from
  the platform `auth` namespace that every verifier shares) and the refresh JWT (7 d, its own
  secret from identity's `refreshToken` namespace, `jti` = session id), and verifies refresh
  tokens. The `sessions` row stores `sha256(refreshToken)` only.
- **Refresh rotation**: verify the JWT (no DB access for garbage) → one transaction:
  `UPDATE identity.sessions SET revoked_at, replaced_by_id WHERE id AND user_id AND refresh_token_hash AND
revoked_at IS NULL AND expires_at > now RETURNING id` (compare-and-set: concurrent refreshes of
  one token cannot both win) + insert the successor. If nothing matched: a genuine token whose
  session is already revoked is **reuse** → every session of the user is revoked (outside the
  rotation transaction, so the following throw cannot roll it back) → 401 `REFRESH_TOKEN_REUSED`.
- **Logout**: denylist the access `jti` in Redis for its remaining lifetime, then revoke the
  session of `refreshToken`, or every session when it is omitted ("sign out everywhere").
- **Purge**: hourly `PurgeExpiredSessionsCron` (`@WithLock('identity:purge-sessions', 60 s)`)
  deletes expired sessions in batches of 5 000. Revoked-but-unexpired sessions are kept on
  purpose: they make reuse detectable until the token itself expires.

## REST (URI version `v1`, problem+json errors)

| Method | Path                | Auth                                            | Body / query                               | Success                                            | Errors                                                                        |
| ------ | ------------------- | ----------------------------------------------- | ------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| POST   | `/v1/auth/register` | `@Public`, `@RateLimit('identity.credentials')` | `{ email, password (8–128), displayName }` | 201 `AuthTokensResponse`                           | 400, 409 `EMAIL_TAKEN`, 429                                                   |
| POST   | `/v1/auth/login`    | `@Public`, `@RateLimit('identity.credentials')` | `{ email, password }` (passport-local)     | 200 `AuthTokensResponse`                           | 400, 401 `INVALID_CREDENTIALS` / `MISSING_CREDENTIALS`, 429                   |
| POST   | `/v1/auth/refresh`  | `@Public`                                       | `{ refreshToken }` (JWT)                   | 200 `AuthTokensResponse`                           | 400, 401 `INVALID_REFRESH_TOKEN` / `SESSION_EXPIRED` / `REFRESH_TOKEN_REUSED` |
| POST   | `/v1/auth/logout`   | bearer                                          | `{ refreshToken? }`                        | 204                                                | 401                                                                           |
| GET    | `/v1/auth/me`       | bearer                                          | –                                          | 200 `UserResponse`                                 | 401                                                                           |
| GET    | `/v1/users`         | `users:read`                                    | `?limit (1–100)&cursor&search (3–100)`     | 200 `UserPageResponse`                             | 400, 401, 403, 422 `INVALID_CURSOR`                                           |
| GET    | `/v1/users/:id`     | self, or `users:read`                           | `:id` uuidv7 (`ParseUUIDPipe`)             | 200 `UserResponse` (self: cached `user:{id}` 30 s) | 400, 401, 403, 404                                                            |

DTOs are class-validator classes with `@ApiProperty` and `@Transform` normalisation (trimmed,
lowercased email; trimmed names/search, blank search = no filter). Responses are `@Exclude()`/`@Expose()` allow-list
classes serialised by a controller-level (HTTP-only) `ClassSerializerInterceptor`.

**User cache.** `UserReadCache` caches only the caller's own profile (`user:{id}`, 30 s, for `me`, `/v1/auth/me`
and a self read). Another user's profile (`GET /v1/users/:id`, `query user`) is read as `getScopedUser(id, { tenantId })`
with the caller's active tenant and is never cached (B4 ruling 4): a removed member is a 404 at once, and a warm
`user:{id}` is never served to a tenant the user is not in. A deployment that wants these reads cached can put them
behind a per-tenant membership marker, `tenantCacheKey('identity', tenantId, 'member', userId)` from
`@platform/redis`: fill it from the scoped port call, then serve `user:{id}`, and delete it after a successful member
remove or leave. The cost is that a removal which bypasses those edges, or a Redis outage, leaves the member readable
in that tenant for up to `USER_CACHE_TTL_MS`.

## GraphQL (code-first)

| Operation                                                      | Auth                  | Returns          |
| -------------------------------------------------------------- | --------------------- | ---------------- |
| `query me`                                                     | bearer                | `User`           |
| `query user(id: UUID!)`                                        | self or `users:read`  | `User`           |
| `query users(limit: Int = 20, cursor: String, search: String)` | `users:read`          | `UserConnection` |
| `mutation register(input: RegisterInput!)`                     | public, auth throttle | `AuthPayload`    |
| `mutation login(input: LoginInput!)`                           | public, auth throttle | `AuthPayload`    |
| `mutation refreshTokens(input: RefreshTokensInput!)`           | public                | `AuthPayload`    |

Types: `User { id: UUID!, email, displayName, createdAt: DateTime!, updatedAt: DateTime! }`,
`AuthPayload`, `UserConnection { items, nextCursor }`, `enum TenantRole { OWNER ADMIN MEMBER }` (values =
`@platform/common` `TenantRole`). Every input field carries class-validator decorators.

## gRPC (`identity.v1`, served by identity-service)

| Service          | RPC                                                | Dispatches                                                              |
| ---------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `AuthService`    | `Register`                                         | `RegisterUserCommand`                                                   |
|                  | `Login`                                            | `LoginCommand`                                                          |
|                  | `RefreshTokens`                                    | `RefreshSessionCommand`                                                 |
|                  | `Logout`                                           | `LogoutCommand` (→ `Empty`)                                             |
| `UsersService`   | `GetUser`                                          | `GetUserByIdQuery`                                                      |
|                  | `GetUsersByIds`                                    | `GetUsersByIdsQuery`                                                    |
|                  | `ListUsers`                                        | `ListUsersQuery`                                                        |
| `TenantsService` | `ListMyTenants`, `ListMembers`                     | `ListMyTenantsQuery`, `ListMembersQuery` (retried on `UNAVAILABLE`)     |
|                  | `CreateTenant`, `RenameTenant`                     | `CreateTenantCommand`, `RenameTenantCommand`                            |
|                  | `UpdateMemberRoles`, `RemoveMember`, `LeaveTenant` | `UpdateMemberRolesCommand`, `RemoveMemberCommand`, `LeaveTenantCommand` |
|                  | `CreateInvitation`, `AcceptInvitation`             | `CreateInvitationCommand`, `AcceptInvitationCommand`                    |

Controllers use `@GrpcController()` + the generated `…ServiceControllerMethods()` and validate
payloads with `ZodRpcValidationPipe` (`INVALID_ARGUMENT` + issues). Domain codes survive the hop
(`x-error-code` trailer). The gateway adapters apply `GRPC_DEADLINE_MS`, the `identity` circuit
breaker and caller metadata, and normalise proto-loader `null`s.

## Tenancy

Every account owns a personal tenant from registration, can create more, and belongs to a tenant through a
membership (`member`, `admin`, `owner`; `owner` ⊇ `admin` ⊇ `member`). The access token names the active tenant (`tid`)
and the roles there; `POST /v1/auth/switch-tenant` moves between tenants.

**Ports and adapters.** Three abstract ports, each with a local adapter (CommandBus / QueryBus, monolith and
identity-service) and a gRPC adapter over `identity.v1.TenantsService` (gateway, `IdentityApiModule.forRemote()`):

| Port              | Operations                                                        | Local adapter             | gRPC adapter             |
| ----------------- | ----------------------------------------------------------------- | ------------------------- | ------------------------ |
| `TenantsPort`     | `listMyTenants`, `createTenant`, `renameTenant`                   | `TenantsLocalAdapter`     | `TenantsGrpcAdapter`     |
| `MembersPort`     | `listMembers`, `updateMemberRoles`, `removeMember`, `leaveTenant` | `MembersLocalAdapter`     | `MembersGrpcAdapter`     |
| `InvitationsPort` | `createInvitation`, `acceptInvitation`                            | `InvitationsLocalAdapter` | `InvitationsGrpcAdapter` |

REST (`TenantsController`, `MembersController`, `InvitationsController`) and GraphQL (`TenancyResolver`) depend only on
the ports, so both topologies behave the same. Endpoints: `GET`/`POST /v1/tenants`, `PATCH /v1/tenant`
(`tenant:manage`), `GET /v1/tenant/members`, `PATCH`/`DELETE /v1/tenant/members/:userId` (`members:manage`),
`POST /v1/tenant/leave`, `POST /v1/tenant/invitations` (`members:manage`), `POST /v1/invitations/accept`; GraphQL
`myTenants`, `tenantMembers`, `createTenant`, `renameTenant`, `inviteMember`, `acceptInvitation`, `updateMemberRoles`,
`removeMember`, `leaveTenant`. The tables are in [docs/API.md](../../docs/API.md#tenants-members-and-invitations).

**Rules.**

- The actor and tenant come from the principal (`requireTenantActor`); a staff switch-in principal has no membership
  and cannot accept an invitation or leave.
- Only an owner can grant, revoke, invite or remove `owner` (`OWNER_RANK_REQUIRED`); roles are a non-empty, unique set
  (`INVALID_ROLES`).
- A tenant keeps at least one owner (`LAST_OWNER`): role changes, removals and departures run under a per-tenant lock,
  so two owners demoting each other at once cannot both succeed.
- An invitation is 32 random bytes (only the sha256 is stored), valid 7 days, single use. The mail job carries the raw
  token and is deleted once sent or failed (`INVITATION_MAIL_RETENTION`); the link is
  `<MAIL_APP_URL>/invitations/accept?token=…`. The accepting account's email must equal the invitation email.
  Unknown, expired and replayed tokens are one `INVITATION_INVALID`.
- Renames, role changes, removals, departures and invitations (sent and accepted) are written to the tenant's
  `audit_events`.

**Error codes** (`IdentityErrorCode`): `TENANT_SLUG_TAKEN` (409), `MEMBERSHIP_EXISTS` (409), `TENANT_ACCESS_DENIED`
(403), `OWNER_RANK_REQUIRED` (403), `INVITATION_EMAIL_MISMATCH` (403), `INVITATION_INVALID` (404), `LAST_OWNER` (422),
`INVALID_ROLES` (422), `MEMBERSHIP_REVOKED` (401), `STAFF_ONLY` and `STAFF_TOKEN_NOT_ALLOWED` (403).

**Testing.** `FakeTenancyState`, `FakeTenantsPort`, `FakeMembersPort` and `FakeInvitationsPort` (from
`@domain/identity/testing`) stand behind the gateway; `tenancy.repositories.int-spec.ts` covers the repositories, the
last-owner concurrency and the invitation accept against Citus.

## Events

| Topic                         | Direction | Key      | Payload                                        |
| ----------------------------- | --------- | -------- | ---------------------------------------------- |
| `identity.user-registered.v1` | produced  | `userId` | `{ userId, email, displayName, registeredAt }` |

Envelope id = the domain event id (idempotent consumers). Publishing is after commit; failures are
logged, never thrown. A transactional outbox (event row in the same transaction + relay) would
close the "committed but not published" window; it is not implemented.

## Data model (`identity.schema.ts` → `identitySchema`)

- `users`: `id uuid PK DEFAULT uuidv7()` (the app supplies uuidv7 ids), `email text UNIQUE`
  (`users_email_unique`, stored normalised), `password_hash`, `display_name`,
  `is_platform_staff boolean DEFAULT false` (set only by `staff:grant`), `created_at`, `updated_at` (`$onUpdate`).
- `sessions`: `id uuid PK` (= refresh `jti`), `user_id → users ON DELETE CASCADE`,
  `refresh_token_hash`, `user_agent`, `ip`, `expires_at`, `revoked_at`, `replaced_by_id`,
  `created_at`; indexes `sessions_user_id_idx`, `sessions_expires_at_idx`.
- Keyset pagination on `users.id DESC` uses the PK. The `ILIKE '%q%'` search uses
  `users_search_trgm_idx` (pg_trgm GIN on `email` + `display_name`; the extension comes from
  `@platform/database`'s platform set, which always runs first). Trigrams need 3+ characters, so
  every transport rejects a shorter search term (`IDENTITY_LIMITS.SEARCH_MIN_LENGTH`; a blank one
  means "no filter").

The tables and the `tenant_role` enum live in the `identity` Postgres schema (`identityPgSchema`); raw SQL qualifies
them (`identity.users`). The schema file imports only `drizzle-orm` and a dependency-free relative file, so
drizzle-kit can load it. Identity owns its migration history: `drizzle.config.ts` generates
`src/infrastructure/persistence/migrations` (`bun run --filter @domain/identity db:generate`), bookkeeping in
`identity.__drizzle_migrations`, and `identityMigrations` applies it after the platform set.

## Configuration

Identity's own namespaces, loaded by `IdentityCoreModule` (`infrastructure/security/`): `password` (`ARGON2_MEMORY_COST`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM`) and `refreshToken` (`JWT_REFRESH_SECRET`, `JWT_REFRESH_TTL_SEC`; it reads `JWT_ACCESS_SECRET` only for the production must-differ check). Also its own, for the gateway: `identityGrpcClient` (`IDENTITY_GRPC_URL`, `infrastructure/adapters/grpc/`), read by `IdentityApiModule.forRemote()`. From `@platform/config`: `auth` (`JWT_ACCESS_*`, `JWT_ISSUER`/`JWT_AUDIENCE`, `AUTH_DENYLIST_ENABLED`),
`grpc` (`GRPC_DEADLINE_MS`) for the gateway, `throttle`, its own
`identityRateLimit` (`IDENTITY_CREDENTIALS_*`, `IDENTITY_LOCKOUT_*` for `identity.credentials`), `redis` (key prefix of
locks, denylist and cache).

## Tests

`bunx vitest run --project identity` needs no infrastructure:

- domain: aggregate invariants/events, session rules, role list vs `@platform/auth`;
- security: `PasswordHasher` (Argon2id parameters, per-hash salt, over-long inputs, rehash detection), `TokenIssuer` (claims accepted by the platform `TokenService`, refresh verification, `typ` cross-check, expiry) and the `password` / `refreshToken` namespaces (defaults, production guards);
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
  `IdentityGrpcModule`. `apps/monolith/test/payment-user.e2e-spec.ts` and
  `apps/gateway/test/payment-user.e2e-spec.ts` compose this lib with billing in one GraphQL schema
  (`Payment.user` through the `users` loader).

Integration (Docker): `INTEGRATION=1 bunx vitest run --project identity:int` runs
`infrastructure/persistence/users.repository.int-spec.ts` on PostgreSQL 18 (testcontainers, or an
existing throwaway database via `INTEGRATION_DATABASE_URL`). It boots the real `DatabaseModule`, which
applies the platform set and identity's own history (schema `identity`), then covers the repositories: the hash-free
projection, `users_email_unique` → `EMAIL_TAKEN`, `findByIds`, keyset + literal ILIKE search,
the `isPlatformStaff` fresh read, DB defaults, the session FK cascade and compare-and-set rotation,
server-side prepared
statements (`pg_prepared_statements`, one statement for every `findByIds` batch size) and the
trigram search index (`EXPLAIN` → `Bitmap Index Scan on users_search_trgm_idx`).

Test doubles for the apps: `@domain/identity/testing` exports `createInMemoryIdentityPersistence`
(in-memory `UsersRepository`/`SessionsRepository` and an inline `TransactionRunner`, used by the
monolith e2e suite under the real handlers) and `FakeIdentityState`, `FakeAuthPort`, `FakeUsersPort`
(a fake identity-service behind the gateway's ports). Production code never imports the subpath.

## Scripts

- `bun run --filter @domain/identity staff:grant <email> [--revoke]`: grant or revoke platform staff (`users.is_platform_staff`); see [SECURITY.md](../../docs/SECURITY.md#the-first-admin-platform-staff).

## Gotchas

- Roles live in the access token: role changes apply after the next refresh (≤ 15 min). Reuse
  detection revokes refresh sessions only; outstanding access tokens expire on their own.
- Reuse detection is strict: two concurrent refreshes of the same token revoke the whole family
  (the loser sees a revoked session). Clients must serialise refreshes.
- `LoginRequestGuard` validates the login body because guards run before pipes; errors raised
  inside passport would otherwise become 401s.
- The GraphQL spec uses plain `vi.fn()` objects for its fakes. That was a workaround for an old
  `@platform/testing` `createMock()` bug, now fixed: `createMock()` works as a provider in GraphQL apps too.
- `@node-rs/argon2`'s `Algorithm` is an ambient const enum with an empty runtime object, so `PasswordHasher` relies on the default (Argon2id) and `needsRehash` compares against the literal `2`. Hashing runs on the libuv threadpool: keep `UV_THREADPOOL_SIZE` at or below the container's CPUs (see [docs/PERFORMANCE.md](../../docs/PERFORMANCE.md)).
