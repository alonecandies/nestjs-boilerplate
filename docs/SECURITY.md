# Security model

How the boilerplate authenticates, authorises, rate-limits and hardens its edges, and what you must
change before production. Everything below describes the code as it is. File paths are relative to
the repo root.

Related: [Architecture](ARCHITECTURE.md) · [Development](DEVELOPMENT.md) · [Docker](DOCKER.md) ·
[Releasing](RELEASING.md) · [README](../README.md)

- [Authentication](#authentication)
- [Authorisation (RBAC)](#authorisation-rbac), [AI tools](#ai-tools)
- [Rate limiting](#rate-limiting)
- [HTTP hardening: proxies, CORS, helmet, limits](#http-hardening-proxies-cors-helmet-limits)
- [Internal gRPC](#internal-grpc-mtls-reflection)
- [Webhooks and uploads](#webhooks-and-uploads)
- [Database roles](#database-roles)
- [Row-level security](#row-level-security): [the `SET LOCAL` context](#the-rls-context-set-local), [elevation](#elevation), [the system pool](#the-system-pool), [trust model](#trust-model), [boot guard](#boot-guard), [PgBouncer authentication](#pgbouncer-authentication)
- [Secrets, configuration guards and logs](#secrets-configuration-guards-and-logs)
- [Ops endpoints](#ops-endpoints-metrics-docs-health)
- [Production checklist](#production-checklist)
- [Known gaps](#known-gaps)

## Authentication

Implemented in [`libs/auth`](../libs/auth/README.md) (access-token verification, guards, denylist) and
[`domains/identity`](../domains/identity/README.md) (token issuance, password hashing, sessions, rotation, logout).

### Tokens

| Token   | Algorithm / secret                       | TTL (env)                                                                       | Claims                                                                                                                                                      | Stored server-side                                                   |
| ------- | ---------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Access  | HS256, `JWT_ACCESS_SECRET` (≥ 32 chars)  | 900 s (`JWT_ACCESS_TTL_SEC`); staff switch-in 900 s (`STAFF_SWITCH_IN_TTL_SEC`) | `sub` (user id), `email`, `tid` (active tenant), `roles` (tenant roles), `staff` (switch-in tokens only), `jti` (uuidv7), `typ`, `iss`, `aud`, `iat`, `exp` | no (verified locally); `jti` denylisted on logout                    |
| Refresh | HS256, `JWT_REFRESH_SECRET` (≥ 32 chars) | 604800 s (`JWT_REFRESH_TTL_SEC`)                                                | `sub`, `jti` = session id, `typ`, `iss`, `aud`, `iat`, `exp`                                                                                                | `sessions` row (with its tenant) holding `sha256(refreshToken)` only |

- `iss`/`aud` default to `nestjs-boilerplate` (`JWT_ISSUER`, `JWT_AUDIENCE`). Verification allows 5 s of
  clock skew: the code constant `JWT_CLOCK_TOLERANCE_SEC` (`libs/auth/src/auth.constants.ts`), not an
  environment variable.
- `tid` is required: a token without it (issued before B2) is 401 `INVALID_TOKEN`; the client refreshes.
  `roles` are the roles held in `tid` (owner ⊇ admin ⊇ member); unknown values are dropped. `staff` is
  written only on staff switch-in tokens and counts only as the JSON boolean `true`. Permissions are never in
  the token: each service resolves them from `roles` at verification.
- The refresh token carries no tenant: its session row does, so a refresh stays in the session's tenant.
- Identity signs both tokens (`TokenIssuer`, `domains/identity/src/infrastructure/security/`). The
  refresh secret and TTL live in identity's `refreshToken` namespace, which only the processes
  running `IdentityCoreModule` (monolith, identity-service) load: the gateway holds the access
  secret only.
- The `typ` claim plus separate secrets mean an access token can never be replayed as a refresh
  token or the other way round.
- Access tokens are verified **at every edge process** with no RPC: signature, `iss`/`aud`/`exp`, `typ`,
  then the Redis denylist (`JwtStrategy`, `libs/auth/src/strategies/jwt.strategy.ts`). The gateway
  and identity-service must share `JWT_ACCESS_SECRET`.
- Roles live in the access token, so a role change takes effect at the next refresh (≤ access TTL).
  Unknown roles in a token are dropped, not rejected (rolling deploys).

### Refresh rotation and reuse detection

`RefreshSessionHandler` (`domains/identity/src/application/commands/refresh-session/`):

1. Verify the refresh JWT first (garbage never reaches the database).
2. In one transaction, compare-and-set the session:
   `UPDATE identity.sessions SET revoked_at, replaced_by_id WHERE id AND user_id AND refresh_token_hash AND revoked_at IS NULL AND expires_at > now`,
   then insert the successor session. Two concurrent refreshes of one token cannot both win.
3. If nothing matched and the token is genuine but its session is already revoked, that is
   **reuse**: every session of the user is revoked (outside the rotation transaction, so the
   following error cannot roll it back) and the call fails with 401 `REFRESH_TOKEN_REUSED`.

Consequences for clients: refresh tokens are single-use, and refreshes must be serialised (two
parallel refreshes revoke the family). Revoked-but-unexpired sessions are kept on purpose until they
expire, so reuse stays detectable; `PurgeExpiredSessionsCron` deletes only expired rows (hourly,
under a Redis lock).

The gRPC client retries `UNAVAILABLE` **only** for idempotent reads (see
[Internal gRPC](#internal-grpc-mtls-reflection)), because a replayed `RefreshTokens` would trip reuse
detection.

### Logout and the denylist

`POST /v1/auth/logout` (bearer) puts the access `jti` on the Redis denylist for its remaining
lifetime (`{REDIS_KEY_PREFIX}:auth:denylist:{jti}`, TTL = remaining lifetime + 5 s), then revokes the
session of the given `refreshToken`, or **every** session when the body omits it.

- Presenting that refresh token again after logout counts as **reuse** (its session is revoked):
  401 `REFRESH_TOKEN_REUSED`, every session of the user is revoked and a "Refresh token reuse
  detected" warning is logged. This is deliberate (covered by
  `domains/identity/src/domain/session.spec.ts`); clients must discard **both** tokens on logout. The old access token is refused with 401 `TOKEN_REVOKED` on
  REST and GraphQL (`extensions.code`).

- The denylist **fails closed**: a Redis error or a check slower than 250 ms answers 503, never
  "allowed". `AUTH_DENYLIST_ENABLED=false` turns it off (not recommended).
- WebSockets authenticate at the handshake (the denylist is checked there). Per message,
  `WsSessionGuard` re-checks the denylist; every `WS_REVOCATION_SWEEP_INTERVAL_MS` (30 s by
  default) each replica disconnects its sockets whose token was revoked (`TOKEN_REVOKED`), and a
  per-socket timer disconnects a socket when its access token expires (`TOKEN_EXPIRED`).
- graphql-ws subscriptions authenticate at `connection_init` (close code 4403 for an invalid,
  expired, revoked or missing token) and are closed with 4401 `Access token expired` when the
  token's `exp` passes. They are swept too: each socket is tracked by its token's `jti`, and every
  `WS_REVOCATION_SWEEP_INTERVAL_MS` each replica closes those whose token was revoked with 4401
  `Access token revoked`. Both transports share one `RevocationSweeper` (`@platform/auth`).

### Passwords

- Argon2id via `@node-rs/argon2` (`PasswordHasher`, `domains/identity/src/infrastructure/security/`). Parameters from
  `ARGON2_MEMORY_COST` (19456 KiB), `ARGON2_TIME_COST` (2), `ARGON2_PARALLELISM` (1): the OWASP
  minimum profile. Hashes with outdated parameters are re-hashed transparently at login.
- Password length 8–128 at registration (`IDENTITY_LIMITS`); `MAX_PASSWORD_LENGTH` (1024) in
  `@domain/identity` bounds the hashing cost of any input.
- Login runs `verifyDummy` for unknown emails so response timing does not reveal which accounts
  exist; wrong password and unknown email share one 401 `INVALID_CREDENTIALS`.
- Register and login are limited by `identity.credentials`: per sha256(normalised email)+client IP, shared by REST
  and GraphQL. A per-account lockout (`IDENTITY_LOCKOUT_*`) refuses an account after `IDENTITY_LOCKOUT_THRESHOLD`
  failed attempts from any IP within one `IDENTITY_LOCKOUT_MS` window; a successful login before that resets the
  count. A locked account answers like any 429, so the lockout does not reveal whether an account exists.
  Trade-off (targeted lockout): the lockout is per account by design (spec §11), so anyone who knows an email can
  keep that account locked by failing logins for it, from any IP, for `IDENTITY_LOCKOUT_MS` at a time. Keep
  `IDENTITY_LOCKOUT_MS` short (minutes), keep the threshold high enough for real typos, and watch 429s on
  `/v1/auth/login` per account; a per-IP-only lockout would not stop distributed guessing.
- Argon2 runs on the libuv threadpool. Keep `UV_THREADPOOL_SIZE` **at or below the CPUs available to
  the container** (the image default is 4). Measured on the monolith capped at 2 CPUs: 4 threads gave
  p95 36 ms, 16 threads gave p95 304 ms and worse, because the extra busy threads get the whole cgroup
  throttled, event loop included ([DOCKER.md](DOCKER.md#images-dockerfile)).

### 401 / 403 codes

| Status | Code                                                                                                                                                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | `INVALID_PRINCIPAL`, `MEMBERSHIP_REVOKED`, `MISSING_TOKEN`, `INVALID_TOKEN`, `TOKEN_EXPIRED` (refresh and retry), `TOKEN_REVOKED`, `MISSING_CREDENTIALS`, `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN`, `SESSION_EXPIRED`, `REFRESH_TOKEN_REUSED` |
| 403    | `FORBIDDEN` with `details.requiredRoles` or `details.requiredPermissions`; `TENANT_ACCESS_DENIED`, `OWNER_RANK_REQUIRED`, `INVITATION_EMAIL_MISMATCH`, `STAFF_ONLY`, `STAFF_TOKEN_NOT_ALLOWED`, `TENANT_MISMATCH`                                   |

## Authorisation (RBAC)

Global guards, registered by `AuthModule.forRootAsync()` in this order: `JwtAuthGuard` →
`RolesGuard` → `PermissionsGuard`. They branch on the context type, so the same decorators work on
REST controllers, GraphQL resolvers and WebSocket handlers. `rpc` handlers (gRPC, Kafka) bypass them:
services trust the edge (see [Internal gRPC](#internal-grpc-mtls-reflection)). `@StaffOnly()` adds
`StaffOnlyGuard` on its route, after them.

| Decorator                                               | Meaning                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `@Public()` (`@platform/common`)                        | skip authentication                                                                             |
| `@RequirePermissions(...p)` / `@RequireAnyPermission()` | all / any of the permissions                                                                    |
| `@Roles(...roles)`                                      | any of the tenant roles, owner ⊇ admin ⊇ member; only for owner-only rules (prefer permissions) |
| `@StaffOnly()`                                          | platform-staff switch-in tokens only (403 `STAFF_ONLY`)                                         |
| `@Auth(...p)`                                           | alias of `@RequirePermissions(...p)`                                                            |
| `@CurrentUser(field?)`                                  | the `AuthUser` (401 when absent, even on `@Public` routes)                                      |

### Matrix (default grants)

Each domain declares its permissions and default grants (`domains/<x>/src/<x>.permissions.ts`,
`RbacModule.forFeature`); `AuthModule` assembles the map at boot and fails the boot on an undeclared
permission. Access tokens carry the roles of the active tenant (`tid`); permissions are resolved from
them at verification. Grants are cumulative: owner ⊇ admin ⊇ member (✓ = effective).

| Domain        | Permission            | `member` | `admin` | `owner` | Used by                                                                                                                         |
| ------------- | --------------------- | :------: | :-----: | :-----: | ------------------------------------------------------------------------------------------------------------------------------- |
| identity      | `users:read`          |          |    ✓    |    ✓    | `GET /v1/users`, another user's `GET /v1/users/:id`, `users`                                                                    |
| identity      | `members:manage`      |          |    ✓    |    ✓    | `PATCH`/`DELETE /v1/tenant/members/:userId`, `POST /v1/tenant/invitations`, `updateMemberRoles`, `removeMember`, `inviteMember` |
| identity      | `tenant:manage`       |          |         |    ✓    | `PATCH /v1/tenant`, `renameTenant`                                                                                              |
| billing       | `billing:checkout`    |    ✓     |    ✓    |    ✓    | `POST /v1/billing/checkout-sessions`, `createCheckoutSession`                                                                   |
| billing       | `billing:read-all`    |          |    ✓    |    ✓    | `GET /v1/billing/payments?all=true`, `payments(all: true)`: every payment of the active tenant only                             |
| notifications | `notifications:read`  |    ✓     |    ✓    |    ✓    | notifications REST, GraphQL, Socket.IO                                                                                          |
| notifications | `notifications:write` |          |    ✓    |    ✓    | reserved                                                                                                                        |
| files         | `files:read`          |    ✓     |    ✓    |    ✓    | `GET /v1/files/download-url` (own files)                                                                                        |
| files         | `files:write`         |    ✓     |    ✓    |    ✓    | upload, presign, delete (own files)                                                                                             |
| files         | `files:manage`        |          |    ✓    |    ✓    | download/delete any file of the active tenant only (keys `tenants/<tid>/…`; never another tenant's)                             |
| ai            | `ai:chat`             |    ✓     |    ✓    |    ✓    | `/v1/ai/conversations` (REST and SSE), the AI GraphQL fields and `aiMessageStream`: own conversations only                      |

Ownership rules that are **not** permissions, enforced by the handlers:

- A user can always read their own profile (`GET /v1/users/:id`, `user(id)`).
- Files are scoped to the key prefix `tenants/{tenantId}/users/{userId}/`, the tenant taken from the token; the tenant prefix is checked first (another tenant's key and a legacy `users/…` key are 403 for everyone, `files:manage` included), and access is checked before existence (403 before 404) so keys of other users and tenants cannot be probed.
- Notifications, payments and AI conversations always use the user id and tenant from the token, never from the request; another user's conversation is 404 `CONVERSATION_NOT_FOUND`.
- Owner rank: only an owner can grant, revoke, invite or remove the `owner` role, and a tenant always keeps one owner (`LAST_OWNER`); both are checked in the handlers, in every transport.

### Platform staff switch-in

Staff are users with `identity.users.is_platform_staff` (granted only by `staff:grant`, see "The first admin").
`POST /v1/staff/tenants/{tenantId}/switch-in { reason }` re-reads the flag, then issues an access token for that
tenant with `roles: ["admin"]`, `staff: true` and a lifetime of `STAFF_SWITCH_IN_TTL_SEC` (default 900 s). There is
no refresh token and no session. Every switch-in writes a `staff.switch_in` row to the tenant's `audit_events`
(reason, token id, expiry, client) and an `IdentityAudit` log line. Staff never get `tenant:manage` (an owner
grant). A switch-in token can neither switch tenants nor switch in again (`STAFF_TOKEN_NOT_ALLOWED`), so
it cannot outlive its TTL; the flag is re-read on every switch-in, so a revocation stops new switch-ins at once.
`POST /v1/staff/switch-out` (`@StaffOnly()`) revokes the switch-in token at once (denylist) and writes
`staff.switch_out`; otherwise the token simply expires.

### Principal propagation

The gateway forwards the authenticated principal on every gRPC call as `x-user-id`, `x-tenant-id`, `x-user-roles` and
`x-staff` (only from the CLS principal, never from request headers). A service rebuilds it with the same
`createPrincipal` rules as the edge: malformed metadata (`x-user-id` not a UUID, a nil or malformed tenant, a tenant
without a user) fails closed with `UNAUTHENTICATED` / `INVALID_PRINCIPAL`; `staff` is true only for the exact string
`true`; unknown roles are dropped; no `x-user-id` means no principal (not an error). Permissions are never sent: the
service recomputes them from the roles with its own RBAC registry. This metadata is trusted only inside the mesh: gRPC
mTLS (`GRPC_TLS_*`), or `GRPC_ALLOW_INSECURE` only behind a mesh that does mTLS plus a NetworkPolicy. Kafka envelopes
carry `tenantId` and `actorId`; a consumer acts as that actor (an envelope without them, from a deploy in flight, sets no
principal), and DataLoader batches keep the request's context.

### Tenant scoping

Every billing row carries `tenant_id` (the Citus distribution column) and every billing query filters on it. The REST,
GraphQL and gRPC entry points take the tenant from the caller's principal; a request that names another tenant is 403
`TENANT_MISMATCH`. The Stripe webhook has no principal: the tenant and user come from the metadata checkout signed into
the Stripe object, so only signed data decides the scope. An event with no or malformed tenant metadata (payouts,
sessions created before tenancy) is acknowledged and recorded under the platform tenant with no user, and it never
touches a tenant's payment; a nil-UUID user is treated as no user. The query is the first filter and
[row-level security](#row-level-security) the second: a query that forgets its `tenant_id` predicate still sees only
the principal's rows.

### Invitations

`POST /v1/tenant/invitations` creates a token of 32 random bytes (base64url, 43 characters). Only its sha256 is stored;
the raw token exists in the mail job and the mail, and the job is deleted once the mail is sent or has failed for good
(`INVITATION_MAIL_RETENTION`). It never reaches Kafka, logs or the database. An invitation lives 7 days and is single
use. The accepting account's email must equal the invitation email (compared case-insensitively, trimmed), otherwise 403
`INVITATION_EMAIL_MISMATCH`; unknown, expired and replayed tokens are one 404 `INVITATION_INVALID`, so tokens cannot be
probed; an invitee who is already a member gets 409 `MEMBERSHIP_EXISTS` and the invitation is not consumed. A staff
switch-in token cannot accept (403 `TENANT_ACCESS_DENIED`). `MAIL_APP_URL`, the base of the link in the mail, must be
https in production unless `SMTP_ALLOW_INSECURE=true`, because the link carries the token. Accepting needs no
credential, so it has no credential rate limit.

### Owner rank and the last owner

Only an owner can grant, revoke, invite or remove `owner`; admins manage everyone else (403 `OWNER_RANK_REQUIRED`). A
per-tenant lock serialises role changes, removals and departures, so a tenant keeps at least one owner even when two
owners demote each other at once (422 `LAST_OWNER`).

### The first admin (platform staff)

There is no seed account. Every registration creates the user's own workspace, where they are `owner`. Platform
staff (support access to other tenants, see [Platform staff switch-in](#platform-staff-switch-in)) is a flag only
this command sets, from a shell with database access:

```bash
bun run --filter @domain/identity staff:grant you@example.com           # grant
bun run --filter @domain/identity staff:grant you@example.com --revoke  # revoke
```

It connects with `DATABASE_MIGRATION_URL` only (never `DATABASE_URL`), and exits 1 when no user has that email.
No API can grant staff. A revocation takes effect at the next switch-in (the flag is re-read every time).

### AI tools

The AI chat ([AI.md](AI.md#tools)) lets the model call three read-only tools: `get_my_profile`, `list_my_notifications`
and `list_my_payments`. The model chooses when to call them, so they are built so that the model can never widen what
they read:

- **As the caller's principal.** `AiChatTools.forCaller(principal)` binds the tools to the request's principal before the
  call. A tool runs only when the context's principal is that caller (none: `PRINCIPAL_MISSING`; another one:
  `TOOL_CALLER_MISMATCH`), takes tenant and user from it, and its strict input schema has no id field, so the model
  cannot name another user or tenant. Each tool reads through the owning domain's port with that domain's own checks
  (row-level security, the inbox owner, own payments), never through the system pool; in ai-service the principal
  travels on in the gRPC metadata to identity-, notifications- and billing-service.
- **Read-only, permission-checked.** No tool writes. A tool whose REST twin needs a permission checks the same one from
  the caller's roles (`list_my_notifications`: `notifications:read`, else `PERMISSION_DENIED`).
- **Results are untrusted.** A tool result can carry text other people wrote (a notification title). The system
  instructions (`AI_TOOLS_SYSTEM_PROMPT`) tell the model that tool results are data, not instructions; since the tools
  can only read what the caller could read anyway, an injected instruction can at most make the model misreport the
  caller's own data. The reply is returned to the caller only.
- **Bounded and quiet.** At most `AI_MAX_TOOL_STEPS` steps, output capped (`AI_TOOL_LIMITS`), failures returned to the
  model as `{ error: { code, message } }` (`TOOL_FAILED` with no detail for anything unexpected) and logged by error
  name only. Prompts, completions and tool results are never logged.
- **Data leaves the cluster.** Tool results become part of the prompt sent to OpenRouter. Remove a tool from `AI_TOOLS`
  where that is not acceptable.

## Rate limiting

[`libs/redis`](../libs/redis/README.md) `AppThrottlerModule` (global `AppThrottlerGuard`, Redis
storage, one `EVALSHA` per request):

| Setting                                         | Default                                            | Applies to                                                                                                                                                                |
| ----------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `THROTTLE_IP_LIMIT` / `_TTL_MS`                 | 600 per 60 s                                       | every HTTP and GraphQL request, counted before authentication                                                                                                             |
| `THROTTLE_LIMIT` / `_TTL_MS`                    | 300 per 60 s                                       | per user (or IP when anonymous), all routes                                                                                                                               |
| `THROTTLE_TENANT_LIMIT` / `_TTL_MS`             | 3000 per 60 s                                      | per active tenant, all its members together (authenticated requests and Socket.IO messages)                                                                               |
| `THROTTLE_GRAPHQL_COST_LIMIT` / `_TTL_MS`       | 20000 points per 60 s                              | GraphQL: one charge per operation, weighted by complexity, per user (else IP); graphql-ws subscriptions too; HTTP 429                                                     |
| `THROTTLE_WS_*`                                 | 30 handshakes per 60 s per IP; 10 sockets per user | Socket.IO and graphql-ws connections: per-IP handshake budget, per-user concurrent sockets (429 `TOO_MANY_CONNECTIONS` / 4403)                                            |
| `IDENTITY_CREDENTIALS_*` / `IDENTITY_LOCKOUT_*` | 10 per 60 s; 10 failed attempts → 15 min           | `identity.credentials` routes: register, login (REST and GraphQL)                                                                                                         |
| `NOTIFICATIONS_MARK_READ_*`                     | 30 per 10 s per user                               | `notifications.mark-read`: Socket.IO `notifications.markRead` (`WsThrottlerGuard`), REST `POST /v1/notifications/:id/read` and GraphQL `markNotificationRead`, one budget |
| `AI_CHAT_*`                                     | 20 per 60 s per user, then 200 per 60 s per tenant | `ai.chat`: AI chat turns (REST send and stream, `sendAiMessage`, `streamAiMessage`), charged before the model call; the tenant budget is shared by every member           |
| exempt                                          | —                                                  | path prefixes `/health`, `/metrics`, `/docs`, `/openapi.json`, `/openapi.yaml`, `/swagger`; the Stripe webhook (`@SkipRateLimit`)                                         |

- Tracker: `user:<id>` for authenticated requests (fair per account, NAT-proof), otherwise
  `ip:<address>` with IPv6 collapsed to its /64. `AuthModule` is imported **before**
  `AppThrottlerModule` so the throttler sees `req.user`.
- The per-IP tracker is only as good as `req.ip`: see `TRUST_PROXY` below.
- The throttler **fails open** when Redis is not ready (a warning every 10 s). Pass
  `AppThrottlerModule.forRootAsync({ failOpen: false })` to answer 503 instead.
- The global guard skips `ws` and `rpc`; gateways opt in with `@UseGuards(WsThrottlerGuard)`.
- GraphQL also has a complexity limit (`GRAPHQL_MAX_COMPLEXITY`, 250): heavier operations are
  rejected with HTTP 400 before execution.

## HTTP hardening: proxies, CORS, helmet, limits

### `TRUST_PROXY`

Controls Fastify's `trustProxy`, i.e. whether `req.ip` (throttling, logs, session `ip`) comes from
`X-Forwarded-For`.

| Value                                          | Meaning                                                          | Where                              |
| ---------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| `false` (default)                              | trust nobody: `req.ip` is the socket peer                        | apps without a proxy               |
| CSV of IPs / CIDRs, e.g. `10.0.0.0/8`          | trust only those hops, walk `X-Forwarded-For` from the right     | **production**: your LB            |
| presets `loopback`, `linklocal`, `uniquelocal` | proxy-addr presets (combinable with CIDRs)                       | compose uses `uniquelocal`         |
| `true`                                         | trust every hop: any client picks its own IP and throttle bucket | **rejected at boot in production** |

### CORS

`createHttpApp` enables CORS for `CORS_ORIGINS` (default `http://localhost:3000,http://localhost:5173`)
with credentials, exposed `x-request-id`/`x-correlation-id`/`retry-after` headers and a 24 h
preflight cache. List
your real frontend origins: production refuses `*` at boot, because credentials are enabled.

### helmet and CSP (`libs/bootstrap/src/http/security.ts`)

| Mode                  | Global CSP                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| production            | `default-src 'none'; frame-ancestors 'none'` (a JSON API loads nothing and is never framed)                               |
| non-production        | `default-src 'self'; frame-ancestors 'none'`                                                                              |
| `GET /graphql` (HTML) | while `GRAPHQL_SANDBOX` is on, its own route-level CSP (`SANDBOX_CONTENT_SECURITY_POLICY`: Apollo's CDN and iframe hosts) |
| `/docs` route         | its own route-level CSP (`DOCS_CONTENT_SECURITY_POLICY`: jsDelivr + Google Fonts for Scalar)                              |

Apollo's CSRF prevention is on: GraphQL `GET`s and simple requests need
`content-type: application/json` or an `apollo-require-preflight` header.

### Request limits

| Limit                       | Default                                | Env / source                                   |
| --------------------------- | -------------------------------------- | ---------------------------------------------- |
| JSON body                   | 1 MiB                                  | `BODY_LIMIT_BYTES`                             |
| Request timeout (slowloris) | 30 s                                   | `HTTP_REQUEST_TIMEOUT_MS`                      |
| Handler timeout             | `HTTP_HANDLER_TIMEOUT_MS` (30 s) → 504 | `TimeoutInterceptor`, `@Timeout(ms)` per route |
| Keep-alive                  | 72 s (must exceed LB idle)             | `HTTP_KEEP_ALIVE_TIMEOUT_MS`                   |
| Upload size                 | 25 MiB                                 | `STORAGE_MAX_UPLOAD_BYTES`                     |
| Concurrent streamed uploads | 4 per process (503 beyond)             | `STORAGE_MAX_CONCURRENT_UPLOADS`               |
| gRPC message                | 4 MiB                                  | `GRPC_MAX_MESSAGE_BYTES`                       |
| graphql-ws payload          | `ws` default (100 MiB)                 | not limited in-process: cap it at the proxy    |

Validation: the global class-validator pipe runs with `whitelist` + `forbidNonWhitelisted`, zod
bodies are strict, and response serialisers are allow-lists (`@Expose()` classes or zod response
schemas), so unknown fields never leak in or out. Incoming `x-request-id` values are only adopted
when they match `[A-Za-z0-9._:-]{1,128}`.

## Internal gRPC (mTLS, reflection)

The services (identity, notifications, billing, ai) **trust their caller**: `rpc` handlers run no JWT
guard, and the principal (`x-user-id`, `x-tenant-id`, `x-user-roles`, `x-staff`) and the `actorId`/`userId`/`tenantId`
fields come from the caller. Whoever reaches port 50051 can act as any user of any tenant. Protect the
transport (see also [Principal propagation](#principal-propagation)):

| Variable                           | Default              | Effect                                                                                  |
| ---------------------------------- | -------------------- | --------------------------------------------------------------------------------------- |
| `GRPC_TLS_CERT_PATH` + `_KEY_PATH` | unset (plaintext)    | enable TLS on the server, and present this certificate as a client (mTLS); set together |
| `GRPC_TLS_CA_PATH`                 | unset                | CA that signed the **peers'** certificates; required when client certs are required     |
| `GRPC_TLS_REQUIRE_CLIENT_CERT`     | `true`               | server demands a client certificate signed by the CA                                    |
| `GRPC_ALLOW_INSECURE`              | `false`              | production **refuses to boot** with plaintext gRPC unless this explicit opt-out is set  |
| `GRPC_REFLECTION`                  | on unless production | server reflection (grpcurl, Postman); compose turns it on for local use                 |

Production: either mutual TLS (server certificates must name the `*_GRPC_URL` hosts) or a service
mesh doing mTLS with `GRPC_ALLOW_INSECURE=true`, **plus** a NetworkPolicy that lets only the gateway
reach the services' gRPC ports, and ai-service reach identity-, notifications- and billing-service (its chat tools call
them as the caller). Keep reflection off. ai-service re-checks tenant and user of every request against the principal
(403 `TENANT_MISMATCH`).

Client-side resilience (not a security control, but it limits blast radius): every call has a
deadline (`GRPC_DEADLINE_MS`, 5 s), a circuit breaker per upstream, and `UNAVAILABLE` retries only
for `GetUser`, `GetUsersByIds`, `ListUsers`, `ListMyTenants`, `ListMembers`, `ListNotifications`, `ListPayments`,
`ListConversations`, `GetConversation`, `ListMessages`. Upstream 5xx details
are sanitised before they reach the client.

## Webhooks and uploads

### Stripe webhook (`POST /v1/billing/webhooks/stripe`)

- The app is created with `rawBody: true`; the signature (`Stripe-Signature`, `STRIPE_WEBHOOK_SECRET`)
  is verified over the exact bytes. In the gateway topology the raw bytes are forwarded over gRPC and
  billing-service verifies them.
- Missing, forged or stale (> 300 s, the code constant `STRIPE_WEBHOOK_TOLERANCE_SEC` in `domains/billing/src/infrastructure/stripe/stripe.constants.ts`) signatures are a 422
  `INVALID_WEBHOOK_SIGNATURE` before any I/O.
- Exactly-once processing: `INSERT INTO billing.stripe_events … ON CONFLICT DO NOTHING` inside the same
  transaction as the payment update; duplicates answer `duplicate: true`. The event's outbox rows
  (`billing.payment-succeeded.v1`, and `billing.ledger-posting.v1` for a money event while
  `LEDGER_ENABLED=true`) are inserted in that same transaction, so a rolled-back delivery announces
  and posts nothing, and Stripe's retry runs it again. The owner (tenant and user) of a money event
  comes only from the signed object's metadata (or its PaymentIntent's); an event with no tenant is
  recorded for the platform and touches no payment.
- `@Public()` and `@SkipRateLimit()` (it skips every throttler; Stripe retries any non-2xx).
- Checkout redirect URLs come only from `STRIPE_SUCCESS_URL`/`STRIPE_CANCEL_URL`, never from the
  REST client (no open redirect). Client `Idempotency-Key`s are mapped per user, never forwarded to
  Stripe verbatim.

### File uploads ([`domains/files`](../domains/files/README.md))

- Content-type allow-list (images without SVG, PDF, JSON, ZIP, plain text, CSV, MPEG audio, MP4
  video); `image/svg+xml` and `text/html` are excluded (stored XSS). Checked in the multipart
  `fileFilter` before a byte is read.
- The declared type is checked, the content is not sniffed, so downloads are always presigned with
  `Content-Disposition: attachment`.
- Keys are `tenants/{tenantId}/users/{userId}/{uuidv7}/{safeFilename}`: unguessable, never
  overwritten, and built only by `buildUserFileKey` from the token's tenant. `assertStorageKey`
  rejects `..`, empty segments, leading `/`, control characters and backslashes before any prefix
  test; the tenant and owner tests are segment-aware (`users/u1` never matches `users/u10`).
- Presigned PUTs sign the content type and the exact `contentLength`; presigned URLs live
  `STORAGE_SIGNED_URL_TTL_SEC` (900 s).

## Database roles

Three Postgres roles separate what a connection may do (program spec section 4). In compose, CI and
the Testcontainers specs they come from one script, run as the superuser:
[`docker/postgres/init/02-roles.sql`](../docker/postgres/init/02-roles.sql) (the roles and their
settings) and [`03-pgbouncer-auth.sql`](../docker/postgres/init/03-pgbouncer-auth.sql) (PgBouncer's
password lookup). Compose runs both once on an empty volume; `startRlsTestPostgres()`
(`@platform/testing/postgres`) runs them in every spec that asserts isolation. Both are idempotent.
Dev passwords equal the role names and appear only in those files and the test helper.

| Role             | Attributes                                                             | Used by                                                            | Server settings (`ALTER ROLE … SET`)                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_owner`      | `LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS`, `CREATE` on the database | migrations, drizzle-kit, operator CLIs (direct to the coordinator) | `search_path = pg_catalog, public` only (the migrator sets Citus' sequential mode itself)                                                            |
| `app_runtime`    | `LOGIN NOSUPERUSER NOBYPASSRLS`                                        | every request (through PgBouncer)                                  | `search_path = pg_catalog, public`, `citus.propagate_set_commands = 'local'`, `statement_timeout = 15s`, `idle_in_transaction_session_timeout = 60s` |
| `app_system`     | `LOGIN NOSUPERUSER BYPASSRLS`                                          | the named system methods only (through PgBouncer, pool of 5)       | same as `app_runtime`                                                                                                                                |
| `pgbouncer_auth` | `LOGIN NOSUPERUSER`                                                    | PgBouncer's `auth_user`                                            | `search_path = pg_catalog`                                                                                                                           |

- **Why the settings live on the roles.** PgBouncer rejects both timeouts as startup parameters, so the
  server applies them per role. `citus.propagate_set_commands = 'local'` makes Citus prepend the
  transaction's `SET LOCAL` RLS context to every remote `BEGIN`; without it, every query that reaches a
  shard over a connection fails with `app.user_id is not set` (closed, but in every request).
- **Explicit `search_path`.** Each role has its own, so nothing resolves through a schema that happens to
  share a role's name (`"$user"`). Application SQL is schema-qualified.
- **Only `app_owner` creates schemas.** `PUBLIC` never gets `CREATE` on the database; `app_owner` owns
  every schema and table and distributes them (`create_reference_table` as `app_owner` is covered by
  `libs/testing/src/postgres/roles.int-spec.ts`). Table privileges for the two app roles are explicit per-table grants in each
  domain's migrations: a new table is unreachable until its migration grants it.
- **`pg_trgm`** is created by the superuser in the role script, so the platform set's
  `CREATE EXTENSION IF NOT EXISTS pg_trgm` is a no-op for `app_owner` (which has no `CREATE` on `public`).

**Production SQL** (as a superuser or the managed service's admin role, on the coordinator; Citus
propagates the roles to the workers, and `citus_check_cluster_node_health()` plus
`SELECT rolconfig FROM pg_roles` on each worker confirm the settings arrived). Replace each `<…>` with a secret from your secret
store; never reuse the dev passwords.

```sql
CREATE ROLE app_owner      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '<owner-password>';
CREATE ROLE app_runtime    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '<runtime-password>';
CREATE ROLE app_system     LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS   PASSWORD '<system-password>';
CREATE ROLE pgbouncer_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '<auth-password>';

GRANT CONNECT, CREATE ON DATABASE <database> TO app_owner;
GRANT CONNECT ON DATABASE <database> TO app_runtime, app_system;

ALTER ROLE app_owner   SET search_path = pg_catalog, public;
ALTER ROLE app_runtime SET search_path = pg_catalog, public;
ALTER ROLE app_system  SET search_path = pg_catalog, public;
ALTER ROLE app_runtime SET citus.propagate_set_commands = 'local';
ALTER ROLE app_runtime SET statement_timeout = '15s';
ALTER ROLE app_runtime SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE app_system  SET citus.propagate_set_commands = 'local';
ALTER ROLE app_system  SET statement_timeout = '15s';
ALTER ROLE app_system  SET idle_in_transaction_session_timeout = '60s';

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
```

Then run `03-pgbouncer-auth.sql` without its `PASSWORD` clause (set `pgbouncer_auth`'s password as
above). PgBouncer uses `auth_type = scram-sha-256`, `auth_user = pgbouncer_auth` and
`auth_query = SELECT usename, passwd FROM pgbouncer.get_auth($1)`: a `SECURITY DEFINER` function with
a pinned `search_path`, executable by `pgbouncer_auth` only, that returns the SCRAM verifier of
`app_runtime` and `app_system` and nothing for any other name (never `app_owner`, which connects
directly, nor a superuser). No secret file holds the verifiers. The coordinator's `pg_hba.conf` allows
`scram-sha-256` from PgBouncer's address only.

**Worker authentication** (a multi-node Citus cluster only). The coordinator opens connections to the
workers as the current user (`app_runtime`, `app_system`, `app_owner`), so each worker must
authenticate all three. The choice, from the Citus docs ("Cluster management", "pg_dist_authinfo"):

- **TLS for every node connection** through `citus.node_conninfo` (its default is `sslmode=require`).
  Set `verify-full` with your CA, then reload:
  `ALTER SYSTEM SET citus.node_conninfo = 'sslrootcert=<ca.crt> sslmode=verify-full'; SELECT pg_reload_conf();`
  It applies to new connections only.
- **SCRAM passwords per role** in `pg_dist_authinfo` (superuser-only; in Citus Community since 11.0),
  `nodeid = 0` meaning every node; a row for a specific node takes precedence:
  `INSERT INTO pg_dist_authinfo (nodeid, rolename, authinfo) VALUES (0, 'app_runtime', 'password=<runtime-password>');`
  and the same for `app_system` and `app_owner`. Rows are not secret-free: restrict superuser access.
  A `.pgpass` in the postgres user's home on every node is the alternative where this table is not
  wanted. Workers' `pg_hba.conf` require `hostssl … scram-sha-256` from the other nodes.
- Client certificates (`authinfo = 'sslcert=… sslkey=…'`) can replace the passwords later.

A single node needs none of this. Compose's optional worker profile and the test topology use `trust`
between nodes on a private Docker network, which is local-only.

## Row-level security

Every runtime query runs as `app_runtime` (`NOBYPASSRLS`) under `FORCE ROW LEVEL SECURITY`; the database, not
only the query, decides which rows a request sees (program spec section 8, B3). The pieces:

- **Forced RLS on every domain table.** `ENABLE` and `FORCE ROW LEVEL SECURITY`, so the owner `app_owner` is filtered
  too and holds no policy (two `TO app_owner` policies on `identity.users` for `staff:grant` are the one exception).
  A table with no policy for a role denies everything. Only each set's bookkeeping table
  (`<schema>.__drizzle_migrations`) and `app.tenant_colocation` carry no RLS, and no app role has any privilege on them.
- **Explicit grants, deny by default.** No default table privileges: a new table is unreachable until its own
  migration grants it. Function execution is revoked from `PUBLIC` the same way.
- **Policies are row-local.** A policy uses only the row's own columns and the three session helpers `app.user_id()`,
  `app.tenant_id()` and `app.elevated()` (called directly, never in a subquery), and calls no function that reads a
  table: Citus rejects subqueries in policies, and a helper that reads another distributed table fails on a shard
  (`XX000 cannot execute a distributed query from a query on a shard`). The per-table policies are in
  [`domains/identity/README.md`](../domains/identity/README.md#data-model-identityschemats--identityschema) and
  [`domains/billing/README.md`](../domains/billing/README.md#row-level-security-b3-5b3-6-program-spec-82) and
  [`domains/ai/README.md`](../domains/ai/README.md#distribution-and-row-level-security-0000_init).
  Rows with `tenant_id = PLATFORM_TENANT_ID` match no runtime policy; only the system pool reads or writes them.
- **ai: one owner per row.** `ai.conversations`, `ai.messages` and `ai.usage` each carry the conversation owner's
  `user_id`, and every policy is `tenant_id = app.tenant_id() AND user_id = app.user_id()`: a user sees only their own
  conversations, messages and usage, even inside their tenant, and elevation grants nothing. `app_runtime` has no UPDATE
  on `ai.messages` and only SELECT and INSERT on `ai.usage` (append-only); `app_system` has no grant at all. Because a
  row-local policy cannot check who owns the conversation a message names, the chat handlers load the conversation as
  the caller (`ConversationsRepository.findById`) in the same unit of work before they append to it.
- **One principal per transaction.** The principal is final before a unit of work opens. A runtime repository reaches
  the database only through `inUnitOfWork`, which compares the CLS principal with what `BEGIN` applied and throws
  `RLS_CONTEXT_STALE` when they differ. With no principal the adapter refuses to `BEGIN` (`RLS_NO_PRINCIPAL`).

### The RLS context: `SET LOCAL`

On `BEGIN`, the Drizzle transactional adapter sends the context in one simple-protocol round trip, built from the CLS
principal:

```sql
SET LOCAL app.user_id = '<uuid>'; SET LOCAL app.tenant_id = '<uuid or empty>'; SET LOCAL app.elevated = 'off'
```

This is the only SQL in the codebase built from strings, because `SET` takes no bound parameters. It is safe by
construction:

- `buildRlsContextSql` (`libs/database/src/rls/rls-context.ts`) accepts a value only if it matches `RLS_UUID_PATTERN`
  (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`, no `m`, `u` or `g` flag, so `$` is the end of the
  input and a trailing newline or quote fails). The result is lower-cased.
- Anything else throws before any SQL is sent, with a message that never echoes the value:
  `RLS_INVALID_USER_ID`, `RLS_INVALID_TENANT_ID`, and `RLS_PLATFORM_TENANT` for the nil UUID (never a runtime tenant
  or user). `tenantId: null` yields the empty string, a user-scoped unit of work.
- With no principal in CLS the adapter refuses to `BEGIN` (`RLS_NO_PRINCIPAL`), also inside a system context. At `COMMIT`,
  and in every `inUnitOfWork` call, the CLS principal is compared with what `BEGIN` applied: a different one throws
  `RLS_CONTEXT_STALE` and the transaction rolls back.
- `set_config()` is never used: Citus propagates `SET LOCAL` to the worker connections of the transaction (the role
  setting `citus.propagate_set_commands = 'local'` on `app_runtime` and `app_system`) but not `set_config()`.
- The values are transaction-local, so they cannot leak across pooled connections, and they work behind PgBouncer in
  transaction mode. No session `SET`, `set_config(…, false)`, `pg_advisory_lock`, `LISTEN` or temp table is used
  behind the pooler.

### Elevation

`app.elevated` widens a policy from "my row" to "the tenant's rows". It never changes `app.tenant_id`, so elevation
never crosses tenants. It needs a principal with a tenant, an open runtime transaction and a current context; every
refusal happens before anything is sent. Each elevation is logged and counted in
`db_rls_elevations_total{kind,name}`.

- **`elevate(permission)`** (`RlsElevation`) asserts in TypeScript that the principal holds the permission, then sends
  `SET LOCAL app.elevated = 'on'`, on until `COMMIT`, unless it was sent inside a savepoint that rolls back: the
  database reverts it, and `RlsElevation` forgets it too. A principal without it gets 403 `ELEVATION_DENIED`, and
  nothing is sent. It is the first call of the unit of work of `CreateInvitation`, `UpdateMemberRoles`, `RemoveMember`,
  `RenameTenant` and the whole-tenant `ListPayments` (`members:manage`, `tenant:manage`, `billing:read-all`).
- **`justified(reason, work)`** is elevation without a permission, for the code paths where the transaction itself
  proves the right, on for `work` only and off again in `finally`. The reasons are a closed list, and only a
  `*.elevated.ts` file may call it (`scripts/check-boundaries.mjs`):

| Reason                | Why the transaction justifies it                                                                   | Where                  |
| --------------------- | -------------------------------------------------------------------------------------------------- | ---------------------- |
| `tenant-bootstrap`    | the tenant was created in the same transaction: the owner membership                               | `TenantBootstrap`      |
| `verified-invitation` | a verified invitation token: the membership, the accepted flag, the audit row                      | `InvitationAcceptance` |
| `membership-activity` | the member's own `last_active_at` touch, which the policy lets only an elevated transaction update | `MembershipActivity`   |

### The system pool

Work without a principal (a login lookup before there is a user, a cron, a platform webhook) and the reads the
row-local policies leave out run on a separate pool: `app_system` (`BYPASSRLS`) on `DATABASE_SYSTEM_URL`, at most 5
connections (`DATABASE_SYSTEM_POOL_MAX`), through PgBouncer. Without `DATABASE_SYSTEM_URL` there is no system pool,
and a system method fails with `SYSTEM_DATABASE_UNAVAILABLE` (a 503 with that code; production refuses to start without
it); it never falls back to `DATABASE_URL`.

- **One door.** `SystemDatabase.run(method, work)` is the only way to the pool. Only a `*.system-repository.ts` file
  may name `SystemDatabase`, `SYSTEM_DATABASE` or `InjectSystemDatabase` (`scripts/check-boundaries.mjs`), and each
  domain pins its methods in `<domain>.system-methods.ts`, checked by a spec. `work` gets the system handle, never the
  runtime pool or its open transaction: a write there commits on its own.
- **Two scopes.** `pre-auth` methods run anywhere (the lookups before there is a principal). `system` methods run
  only inside `SystemContext.run(reason, fn)`, which clears the principal; outside it `SystemDatabase.run` refuses with
  `SYSTEM_CONTEXT_REQUIRED`. The reason (`<domain>.<job>`) goes into the log line of every call.
- **Observable.** Every call, a refused one too, is logged once as `{ systemMethod, scope, reason, outcome }` and
  counted in `db_system_calls_total{method,outcome}`.
- **Grants.** `app_system` holds per-table grants for these methods and nothing else (identity: `SELECT` on `users`,
  `tenants`, `memberships` and `invitations`, `SELECT, DELETE` on `sessions`; billing: `SELECT, INSERT, DELETE` on
  `stripe_events`, `SELECT` on `payments` for reconciliation R3, the outbox's `SELECT, INSERT, UPDATE, DELETE`,
  `SELECT, INSERT` on the three tenant ledger tables and `SELECT, INSERT, UPDATE` on the two local ones).
- **Not a pool method:** `staff:grant` connects as `app_owner` on `DATABASE_MIGRATION_URL`.

The pinned lists (12 methods when B3 shipped, 22 with the ledger's ten, 29 with the outbox's seven; program spec
section 9 numbers the first group, the second is the B3 ruling below). The table lists the methods each domain defines
itself; the shared `outbox.*` methods are in
[System-method lists after this plan](#system-method-lists-after-this-plan):

| Method                                        | Scope    | Used by (reason)                                                                                    |
| --------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `users.findCredentialsByEmail`                | pre-auth | login (spec 1): the credentials row by email                                                        |
| `users.existsByEmail`                         | pre-auth | register pre-check (spec 2); the unique constraint still guards races                               |
| `invitations.findByTokenHash`                 | pre-auth | accept invitation (spec 3): a multi-shard read, one index probe per shard                           |
| `sessions.deleteExpired`                      | system   | the hourly purge, `identity.purge-expired-sessions` (spec 4): multi-shard `DELETE` slices           |
| `stripeEvents.deleteProcessedBefore`          | system   | the hourly purge, `billing.purge-stripe-events` (spec 5)                                            |
| `stripeEvents.markProcessedAsPlatform`        | system   | platform webhooks without a user, `billing.platform-webhook` (spec 8, `stripe_events` half)         |
| `users.findByIdInTenant`                      | system   | `GET /v1/users/:id` and scoped `UsersPort` reads, `identity.user-directory`                         |
| `users.listInTenant`                          | system   | `ListUsers`, `identity.user-directory`                                                              |
| `users.findByIdsInTenant`                     | system   | `GetUsersByIds` (the GraphQL users DataLoader, `Payment.user`), `identity.user-directory`           |
| `memberships.findMember`                      | system   | the member and profile after a role change, `identity.member-directory`                             |
| `memberships.listMembers`                     | system   | `ListMembers` and GraphQL `tenantMembers`, `identity.member-directory`                              |
| `memberships.listForUser`                     | system   | `ListMyTenants`, `identity.my-tenants`: every membership of the caller, across tenants              |
| `ledgerReconciliation.listSucceededPayments`  | system   | reconciliation R3 (spec 9): paid payments of every tenant in a window, keyset by `(tenant_id, id)`  |
| `ledgerReconciliation.listEntryRefs`          | system   | reconciliation (spec 9): ledger entry refs of every tenant in a window, keyset                      |
| `ledgerReconciliation.findPaymentsByIds`      | system   | reconciliation R3 and R4 (spec 9): payments by `(tenant_id, id)` key, any tenant, at most 1000 keys |
| `ledgerReconciliation.appendDiscrepancies`    | system   | reconciliation (spec 10): findings under their tenants, deterministic ids, append-only              |
| `ledgerReconciliation.enqueueMissingPostings` | system   | reconciliation R4 (spec 10): re-enqueued ledger postings, outbox rows of any tenant                 |
| `ledgerEntryRefs.recordAsSystem`              | system   | the ledger-posting consumer in `SystemContext` (spec 10): refs of platform or user-less postings    |
| `ledgerAccounts.recordPlatformAccounts`       | system   | ledger postings (outbox plan delta 4): `PLATFORM_TENANT_ID` account rows only                       |
| `ledgerTrustedState.read`                     | system   | reconciliation R5 (spec 11): the stored trusted immudb state                                        |
| `ledgerTrustedState.advance`                  | system   | reconciliation R5 (spec 11): compare-and-set after the dual proof                                   |
| `ledgerRuns.start`                            | system   | the reconciliation cron (spec 11): a run starts                                                     |
| `ledgerRuns.finish`                           | system   | the reconciliation cron (spec 11): a run finishes, once                                             |

Later phases add their own methods to the same pinned lists, with their per-table `app_system` grants and this
table.

### System-method lists after this plan

Identity pins 13 methods and billing 17 (30 names in all, 4 of them shared). The four `outbox.*` methods come from
`@platform/outbox` (`OUTBOX_SYSTEM_METHODS`); each domain with an outbox lists the ones its relay uses. All are `system`
scope: the relay runs in `SystemContext.run('outbox.relay', …)`, the reconciliation in
`SystemContext.run('billing.reconcile-ledger', …)`.

| Domain   | Pinned list after this plan                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| identity | B3's ten (`users.*`, `invitations.findByTokenHash`, `sessions.deleteExpired`, `memberships.*`) plus `outbox.pollUnpublished`, `outbox.markPublished`, `outbox.deletePublishedBefore` |
| billing  | B3's two (`stripeEvents.deleteProcessedBefore`, `stripeEvents.markProcessedAsPlatform`) plus the four `outbox.*` and the eleven `ledger*` names of the table above                   |

| Method                         | Scope  | What it does                                                                                                                |
| ------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `outbox.pollUnpublished`       | system | the relay's multi-shard read of the oldest unpublished rows, no row lock, plus the backlog statistics                       |
| `outbox.markPublished`         | system | stamps the rows the broker acknowledged: router statements, each with `tenant_id = $n`                                      |
| `outbox.insertAsPlatform`      | system | billing only: rows for `PLATFORM_TENANT_ID` (payout postings, user-less webhooks), the only door for them; idempotent by id |
| `outbox.deletePublishedBefore` | system | the relay's retention purge (`OUTBOX_RETENTION_HOURS`) of published rows, on every shard                                    |

What keeps the outbox and the ledger inside the tenant rule:

- **The runtime role cannot read `outbox`**: it holds `INSERT` only, under the policy `tenant_id = app.tenant_id()`, and an
  enqueue is a plain `INSERT` without `RETURNING` in the caller's open transaction. Rows of another tenant, and of the
  platform tenant, are refused (`OUTBOX_TENANT_MISMATCH`, `OUTBOX_PLATFORM_TENANT`, and the policy as the backstop).
- **The relay publishes what was validated when it was stored**: `publishStored` re-checks the generic envelope schema and
  `type === topic`, rebuilds the two headers from the envelope and reads nothing from CLS, so a row cannot be rewritten
  into another tenant's event at publish time.
- **The ledger consumer's principal comes from the envelope**: `LedgerPostingConsumer` rejects an envelope whose tenant or
  actor differs from the payload's, then runs as `{ userId, tenantId, roles: [] }`; only the platform tenant and user-less
  postings run in `SystemContext`. `LedgerService` refuses a tenant that is not the principal's and never lets a principal
  touch `PLATFORM_TENANT_ID`.
- **The ledger is append-only**: reconciliation appends findings and never corrects an entry. The runtime role reads the
  ledger tables only when elevated, which the consumer's `roles: []` principal never is.
- **No PII** in immudb, in the discrepancy JSON, in the logs of these paths or in any metric label (amounts are minor
  units, ids are uuids, labels are `outbox`, `topic`, `outcome`, `kind`).

### Trust model

The row-local rule has a price. A co-member read (the member directory: `users JOIN memberships ON tenant_id = <the
caller's tenant>`) and a read of the caller's tenants outside the session tenant cannot be a database policy, so they
go through the system pool and are verified in application SQL: the handler asserts the scope first (the principal
acts in that tenant, or it is the user itself), and the system method filters on it in the SQL text. This is the same
trust model as the session context itself, which the application also supplies (the principal on `SET LOCAL`). A
review of a new system method therefore reads its SQL for the scoping predicate, and every one is covered by an int
spec that shows it returns only the asserted rows.

### Boot guard

After both pools are open and before `DatabaseModule` resolves, the boot guard asks the live connections what they
are (`libs/database/src/boot/boot-guard.ts`). Each check is one catalog statement with bound parameters only, and a
check whose statement errors, or answers in another shape than expected, is a finding like any other (fail closed).

| Check                                  | Fails when                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `runtime.not-superuser`                | `DATABASE_URL` logs in as a superuser                                                                |
| `runtime.no-bypassrls`                 | the runtime role has `BYPASSRLS`                                                                     |
| `runtime.owns-no-table`                | the runtime role owns, or is a member of a role that owns, a relation of the migration sets' schemas |
| `runtime.rls-forced`                   | a table of those schemas lacks `ENABLE` or `FORCE ROW LEVEL SECURITY` (bookkeeping tables excepted)  |
| `runtime.no-bookkeeping-privilege`     | the runtime role holds a privilege on a bookkeeping table or `app.tenant_colocation`                 |
| `runtime.citus-propagate-set-commands` | Citus is installed and `citus.propagate_set_commands` is not `local` for the runtime connection      |
| `system.not-superuser`                 | `DATABASE_SYSTEM_URL` logs in as a superuser                                                         |
| `system.bypassrls`                     | the system role lacks `BYPASSRLS`                                                                    |
| `system.owns-no-table`                 | the system role owns a relation of those schemas                                                     |
| `system.citus-propagate-set-commands`  | the same Citus setting, for the system connection                                                    |
| `system.distinct-user`                 | the system and runtime connections log in as the same user                                           |
| `system.configured`                    | `enforce` only: there is no system connection (`DATABASE_SYSTEM_URL` is not set)                     |

The other `system.*` checks run only when `DATABASE_SYSTEM_URL` is set. Production config requires it too: login,
register, accepting an invitation and the purges run on the system pool. `DATABASE_BOOT_GUARD` picks the mode:

- `enforce` (the default in production, and the only value production accepts): any finding throws
  `DatabaseBootGuardError` with every finding, and the app does not start. Compose sets it.
- `warn` (the default elsewhere): each finding is logged as a warning and the app starts.
- `off`: nothing is checked, with a warning. Only for fake databases (e2e suites); production config rejects it.

A table added after B3 without forced RLS therefore stops the next deploy in `enforce`.

### PgBouncer authentication

PgBouncer runs in transaction mode (`pool_mode = transaction`, `max_prepared_statements = 200`) with
`auth_type = scram-sha-256`. Compose mounts a userlist with the two dev passwords and nothing else
(`docker/pgbouncer/userlist.txt`, local only). Production authenticates with `auth_user = pgbouncer_auth` and

```text
auth_query = SELECT usename, passwd FROM pgbouncer.get_auth($1)
```

`pgbouncer.get_auth` is a `SECURITY DEFINER` function with a pinned `search_path`, executable by `pgbouncer_auth`
only, that returns the SCRAM verifier of `app_runtime` and `app_system` and nothing for any other name
(`docker/postgres/init/03-pgbouncer-auth.sql`; the production SQL is under [Database roles](#database-roles)).
`app_owner` is never reachable through the pooler.

`ignore_startup_parameters` lists `extra_float_digits` only. It must **not** list `statement_timeout` (or
`idle_in_transaction_session_timeout`): the roles carry both timeouts (`ALTER ROLE … SET`), and PgBouncer's refusal
of `statement_timeout` as a startup parameter (`08P01`) is how the migration runner knows `DATABASE_MIGRATION_URL`
was pointed at a pooler instead of the coordinator. Listing it would let the migrator run through the pooler and lose
its session advisory lock.

## Tenant isolation outside Postgres

Row-level security guards only the Postgres tables. Everything else (the Cassandra inbox and recipients, the
Redis cache, the object store, Socket.IO rooms and GraphQL subscription triggers) is isolated by **key design**:
each store has one named builder that takes `(tenantId, userId)`, and no key of these stores is concatenated
anywhere else.

| Store                     | Key                                                                                                | Builder                        |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------ |
| Cassandra inbox           | `notifications_by_tenant_user`, `PRIMARY KEY ((tenant_id, user_id), notification_id)`              | CQL `004`, `NOTIFICATIONS_CQL` |
| Cassandra recipients      | `notification_recipients_by_tenant`, `PRIMARY KEY ((tenant_id, user_id))`                          | CQL `003`, `RECIPIENTS_CQL`    |
| Socket.IO room            | `t:<tid>:u:<uid>`                                                                                  | `tenantUserRoom`               |
| GraphQL trigger (Redis)   | `notificationCreated:<tid>:<uid>`                                                                  | `notificationCreatedTrigger`   |
| Redis cache, tenant data  | `<prefix>:cache:<scope>:<tid>:…`                                                                   | `tenantCacheKey`               |
| Redis cache, user profile | `<prefix>:cache:user:<uid>`, only for the caller's own profile (B4 ruling 4: no per-tenant marker) | `userCacheKey`                 |
| Storage object            | `tenants/<tid>/users/<uid>/<uuidv7>/<safeFilename>`                                                | `buildUserFileKey`             |
| Mail idempotency          | digest `digest-<tid>-<uid>-<day>`; `welcome-<uid>` and `receipt-<paymentId>` are one tenant each   | the handlers                   |
| Unchanged                 | `auth:denylist:<jti>`, `lock:*`, `throttle:*`, `notifications:push:dedupe:<envelope id>`, BullMQ   | -                              |

**The tenant source rule.** A tenant id reaches a key only from `AuthUser.tenantId` /
`requirePrincipal().tenantId` or from a validated Kafka envelope `tenantId`. A tenant in a request body, a gRPC field
or an object key is only compared with the principal, never used as the source. A tenant-scoped event whose envelope
has no `tenantId` (or the platform tenant) throws in the consumer and lands in the dead-letter topic: no write, no
push, no mail (fail closed). A principal without a tenant never reaches a key builder.

**What a tenant switch guarantees.** `POST /v1/auth/switch-tenant` denylists the access token it was presented.
Every socket authenticated with that token, on either transport and on every replica, is closed by its replica's
sweep within `WS_REVOCATION_SWEEP_INTERVAL_MS` (Socket.IO: `exception` `TOKEN_REVOKED`, then disconnect;
graphql-ws: close 4401 `Access token revoked`), and Socket.IO messages on it are refused at once. A socket never
changes room or trigger: it joins exactly one room, fixed at the handshake from its token, so the new tenant needs a
new connection with the new token. There is no room-wide close: access tokens carry no session id, so the user's
other sessions in the old tenant stay connected (switching does not end the old membership; removal flows revoke on
their own).

**Legacy data.** There is no backfill. Old user-keyed Cassandra tables are dropped (`005`), and objects under
`users/…` stay in the bucket but answer 403 for everyone. After B4, run `docker compose down -v` once in a dev
environment (an adopter with real data follows the migration notes in
[the files README](../domains/files/README.md#data-model)).

The edge wiring is proved by `apps/{monolith,gateway}/test/tenant-isolation.e2e-spec.ts` (see
[TESTING.md](TESTING.md#tenant-isolation-suites)); the stores themselves by the Cassandra int specs of the
notifications domain and the real-Citus journeys of B3.

## Secrets, configuration guards and logs

### Where configuration comes from

- Only [`libs/config`](../libs/config/README.md) reads `process.env` (documented exceptions: `otel.ts`,
  `drizzle.config.ts`, test setup). Every variable is zod-validated at boot; error messages name the
  variable, never its value.
- `.env` files are loaded by Node (`--env-file-if-exists`), for local development only. Inject
  production secrets from a secret store as real environment variables (they win over `.env`).
- `.env`, `apps/*/.env` and `.env.docker` are gitignored. [`.env.example`](../.env.example) lists every
  variable with its default; CI fails when it drifts (`node scripts/check-env-example.mjs`).

### Boot-time production guards (`NODE_ENV=production`)

| Guard                                                                                                                                                                                                                                                                                     | Source                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` must not be the dev defaults and must differ                                                                                                                                                                                                   | `libs/config/src/namespaces/auth.config.ts`, `domains/identity/src/infrastructure/security/refresh-token.config.ts` |
| publicly known values (compose fallbacks, placeholders, RustFS keys) rejected for the JWT secrets, Stripe key and webhook secret, and S3 keys, unless `ALLOW_KNOWN_LOCAL_SECRETS=true`                                                                                                    | `auth`, `refreshToken`, `stripe`, `storage` namespaces                                                              |
| TLS to every dependency unless its explicit opt-out is set: Postgres `sslmode` (`DATABASE_ALLOW_INSECURE`), `rediss://` + password (`REDIS_ALLOW_INSECURE`), `KAFKA_SSL` (`KAFKA_ALLOW_INSECURE`), Cassandra TLS (`CASSANDRA_ALLOW_INSECURE`), mandatory STARTTLS (`SMTP_ALLOW_INSECURE`) | `database`, `redis`, `kafka`, `cassandra`, `mail` namespaces                                                        |
| no local endpoints or senders: S3/GCS emulators (`STORAGE_ALLOW_INSECURE`), the Mailpit default and an example.com sender (`SMTP_ALLOW_INSECURE`), localhost Checkout redirects (`STRIPE_ALLOW_LOCAL_REDIRECTS`), Cassandra SimpleStrategy (`CASSANDRA_ALLOW_SIMPLE_STRATEGY`)            | `storage`, `mail`, `stripe`, `cassandra` namespaces                                                                 |
| `CORS_ORIGINS` must not contain `*`                                                                                                                                                                                                                                                       | `app.config.ts`                                                                                                     |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` must not be the dev placeholders (forged webhooks)                                                                                                                                                                                          | `stripe.config.ts`                                                                                                  |
| with `AI_ENABLED=true`: `OPENROUTER_API_KEY` required (all environments), not a known placeholder, and `OPENROUTER_BASE_URL` https on a non-loopback host                                                                                                                                 | `ai.config.ts`                                                                                                      |
| JWT secrets ≥ 32 characters (all environments)                                                                                                                                                                                                                                            | `auth.config.ts`, `refresh-token.config.ts`                                                                         |
| `TRUST_PROXY=true` rejected                                                                                                                                                                                                                                                               | `app.config.ts`                                                                                                     |
| plaintext gRPC refused unless `GRPC_ALLOW_INSECURE=true`; TLS cert/key/CA must be consistent                                                                                                                                                                                              | `grpc.config.ts`                                                                                                    |
| `DOCS_ENABLED`, `GRAPHQL_SANDBOX`, `GRAPHQL_INTROSPECTION`, `GRPC_REFLECTION` default to off                                                                                                                                                                                              | `app`, `graphql`, `grpc` namespaces                                                                                 |
| internal error messages and stack traces hidden (problem+json, GraphQL, gRPC, `/health/ready`)                                                                                                                                                                                            | `exposeInternalErrors: !isProduction`                                                                               |
| paired credentials (SMTP, Cassandra, Kafka SASL) must be set together; Stripe key prefixes checked                                                                                                                                                                                        | `mail`, `cassandra`, `kafka`, `stripe` schemas                                                                      |

### immudb state signing key

immudb signs the state it returns (`--signingKey`, an ECDSA P-256 private key). Reconciliation R5 pins the matching
public key (`IMMUDB_SERVER_SIGNING_PUBLIC_KEY` or `_FILE`) and checks the signature of every state it advances the
trusted state to, so a server that is not the one holding the key is refused (an unsigned server too). Production
refuses an enabled ledger without `LEDGER_VERIFY=true` and a pinned key (`LEDGER_ALLOW_UNVERIFIED=true` opts out).

- **Generating.** Anywhere offline, never in the repository:
  `openssl ecparam -name prime256v1 -genkey -noout -out signing.key` (SEC1 `EC PRIVATE KEY`, which immudb parses),
  then `openssl ec -in signing.key -pubout -out signing.pub.pem`. The local compose stack generates its own
  development pair in the `immudb-signing` volume; its public file carries a `compose-local` marker line and the
  `immudb` config namespace refuses it in production (unless `ALLOW_KNOWN_LOCAL_SECRETS=true`, set by compose only).
- **Storing.** The private key goes to the secret store and is mounted into the immudb host only (file mode 0400
  for the immudb user); no application ever sees it. The applications get the public key only, as the base64 PEM
  (`IMMUDB_SERVER_SIGNING_PUBLIC_KEY`) or a mounted file (`IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE`).
- **Rotating.** Rotation changes who may sign future states; it cannot re-sign the past. Plan it as: (1) stop the
  reconcile cron (or let one run finish), (2) restart immudb with the new `--signingKey`, (3) roll the new public
  key out to every app, (4) re-run R5. Until the apps pin the new key, R5 refuses the new server's states (a
  signature failure is a `verification_failed` finding and the trusted state does not advance); the old key keeps
  verifying nothing new. The trusted state in `billing.ledger_trusted_state` (tx id and hash) stays valid across a
  rotation: it is a consistency anchor of the history, independent of the key, and the next advance is proven by
  the dual proof from it to the new state. Do not clear that row to "fix" a rotation: that turns the next run
  into a trust-on-first-use of whatever immudb then serves.
- **Losing or replacing the server.** A fresh immudb (empty volume, any key) fails the dual proof against the stored
  trusted state: R5 reports `verification_failed` and does not advance. That is the intended alarm; restore the
  ledger volume rather than resetting the trusted state.

### Log redaction

pino redacts these paths to `[REDACTED]` (`LOG_REDACT_PATHS`,
`libs/observability/src/logging/logger-params.ts`): `req.headers.authorization`, `req.headers.cookie`,
`req.headers["x-api-key"]`, `res.headers["set-cookie"]`, and `password`, `token`, `accessToken`,
`refreshToken` at the top level plus `*.password`, `*.passwordHash`, `*.token`, `*.accessToken`,
`*.refreshToken`, `*.secret`, `*.apiKey` one level down. Domains add their own paths through the app
composition: the monolith and the gateway pass billing's `BILLING_LOG_REDACT_PATHS`
(`req.headers["stripe-signature"]`) to `ObservabilityModule.forRoot({ redactPaths })`. Don't log
request bodies or whole DTOs, and add paths here (or to the owning domain's list) if you introduce
new secret fields. The AI client never logs prompts, completions or the upstream error message, and
`OPENROUTER_API_KEY` stays in config ([AI.md](AI.md#privacy)). Postgres query logging (`DATABASE_LOG_QUERIES`) prints parameters only outside
production; Redis URLs are logged with credentials removed.

## Ops endpoints (`/metrics`, `/docs`, health)

`/docs`, `/openapi.*` and the health probes share the API port (`PORT`, 3000). `/metrics` does not: it is served
by its own listener on `METRICS_PORT` (9464 in every container; host dev 9464-9467), and the API port answers 404 for
it:

| Route                                         | Exposure                                                                                                                                                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /metrics` (on `METRICS_PORT`)            | route-level traffic, error rates, heap and queue internals. Keep the port cluster-internal; set `METRICS_BEARER_TOKEN` (≥ 16 chars) as defence in depth: without `Authorization: Bearer <token>` it answers **404**. `METRICS_ENABLED=false` disables it |
| `GET /docs`, `/openapi.json`, `/openapi.yaml` | off in production unless `DOCS_ENABLED=true`                                                                                                                                                                                                             |
| `GET /health/live`, `/health/ready`           | public, no secrets; failure details hidden in production                                                                                                                                                                                                 |

At the ingress, route only `/v1`, `/graphql` and `/notifications` (Socket.IO) publicly. Never publish `METRICS_PORT`
(compose does not; Prometheus scrapes `:9464` inside the network) and let Prometheus scrape the pods directly.

## Production checklist

- [ ] `NODE_ENV=production` (enables every guard above).
- [ ] Strong, distinct `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` from a secret store; the gateway
      and identity-service share the access secret; only identity-service (or the monolith) needs
      the refresh secret.
- [ ] Real `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (the development placeholders are
      rejected at boot when `NODE_ENV=production`); webhook endpoint API version pinned in the
      Stripe dashboard.
- [ ] `TRUST_PROXY` = the load balancer's IPs/CIDRs; LB idle timeout < `HTTP_KEEP_ALIVE_TIMEOUT_MS`.
- [ ] `CORS_ORIGINS` = your frontend origins only (`*` is refused at boot).
- [ ] No `*_ALLOW_INSECURE`, `ALLOW_KNOWN_LOCAL_SECRETS` or `STRIPE_ALLOW_LOCAL_REDIRECTS` unless you
      can name what secures that hop instead (a mesh, a TLS sidecar); the compose stack sets all of them.
- [ ] gRPC: `GRPC_TLS_CERT_PATH`/`_KEY_PATH`/`_CA_PATH` (mTLS), or a mesh + `GRPC_ALLOW_INSECURE=true`;
      NetworkPolicy so only the gateway reaches 50051; `GRPC_REFLECTION` off.
- [ ] `METRICS_PORT` kept cluster-internal and `METRICS_BEARER_TOKEN` set; `/docs`, `/openapi.*` not routed publicly;
      `DOCS_ENABLED`, `GRAPHQL_SANDBOX`, `GRAPHQL_INTROSPECTION` left off.
- [ ] TLS everywhere, enforced at boot: Postgres `?sslmode=verify-full`, Redis `rediss://` with a
      password or ACL user, `KAFKA_SSL` + SASL, `CASSANDRA_SSL` with `CASSANDRA_TLS_CA_PATH` and
      `CASSANDRA_REPLICATION_DATACENTERS`, SMTP with STARTTLS (`SMTP_REQUIRE_TLS`); S3/GCS credentials
      scoped to the bucket (`GCS_KEY_FILE` must be a `service_account` key, or use workload identity).
- [ ] immudb runs with `--signingKey` (private key in the secret store, never the compose development key), apps pin the
      public key, `LEDGER_VERIFY=true` ([immudb state signing key](#immudb-state-signing-key)).
- [ ] Database roles created from the production SQL in [Database roles](#database-roles), with
      secret-store passwords; on a multi-node cluster, TLS (`verify-full`) and SCRAM between nodes.
- [ ] Every app that uses the database has `DATABASE_URL` (`app_runtime`), `DATABASE_SYSTEM_URL` (`app_system`) and,
      wherever migrations or CLIs run, `DATABASE_MIGRATION_URL` (`app_owner`, direct to the coordinator, never
      PgBouncer); the three log in as different users. `DATABASE_BOOT_GUARD=enforce`.
- [ ] PgBouncer in transaction mode with `auth_query` (`pgbouncer.get_auth`), `ignore_startup_parameters` set to
      `extra_float_digits` only, and `app_system` capped at 5 connections; `DATABASE_POOLER=pgbouncer`.
- [ ] `DATABASE_RUN_MIGRATIONS=false` and migrations run as a release job (see [DOCKER.md](DOCKER.md#bootstrap-jobs--migrations)).
- [ ] `UV_THREADPOOL_SIZE` ≤ container CPU limit; `CLUSTER_WORKERS=1` under Kubernetes.
- [ ] `SHUTDOWN_DRAIN_MS` about 5000 behind a Service or load balancer, below `SHUTDOWN_TIMEOUT_MS`, which
      stays below the pod's `terminationGracePeriodSeconds`; otherwise a rollout drops in-flight requests.
- [ ] Proxy-level limit on WebSocket frame size (graphql-ws, Socket.IO).
- [ ] First admin promoted manually; review `files:manage` and `billing:read-all` holders.
- [ ] Nothing from `docker-compose.yml` reused as is: it ships known credentials, plaintext Kafka,
      password-less Redis and anonymous Grafana by design ([DOCKER.md](DOCKER.md#what-is-local-only-dont-ship-this-compose-file)).

## Known gaps

- `notifications.notification-created.v1` is published directly (the notifications context has no Postgres
  store to hold an outbox row): a crash between the inbox write and the publish loses the push. The events of
  identity and billing go through the transactional outbox and are delivered at least once.
- A row the broker always refuses blocks its outbox until an operator acts (a batch stops at the first failed
  publish; `OutboxBacklogStuck` pages), so a poison row delays that outbox's later events, not loses them.
- WebSocket revocation is not instant: a live socket whose token is revoked is closed by the next
  sweep, up to `WS_REVOCATION_SWEEP_INTERVAL_MS` (30 s by default) later, on both transports.
  Socket.IO messages and new graphql-ws operations are refused at once (their guards re-check the
  denylist); a running subscription keeps receiving pushes until the sweep closes its socket.
