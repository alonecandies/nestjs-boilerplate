# Security model

How the boilerplate authenticates, authorises, rate-limits and hardens its edges, and what you must
change before production. Everything below describes the code as it is. File paths are relative to
the repo root.

Related: [Architecture](ARCHITECTURE.md) · [Development](DEVELOPMENT.md) · [Docker](DOCKER.md) ·
[Releasing](RELEASING.md) · [README](../README.md)

- [Authentication](#authentication)
- [Authorisation (RBAC)](#authorisation-rbac)
- [Rate limiting](#rate-limiting)
- [HTTP hardening: proxies, CORS, helmet, limits](#http-hardening-proxies-cors-helmet-limits)
- [Internal gRPC](#internal-grpc-mtls-reflection)
- [Webhooks and uploads](#webhooks-and-uploads)
- [Secrets, configuration guards and logs](#secrets-configuration-guards-and-logs)
- [Ops endpoints](#ops-endpoints-metrics-docs-health)
- [Production checklist](#production-checklist)
- [Known gaps](#known-gaps)

## Authentication

Implemented in [`libs/auth`](../libs/auth/README.md) (tokens, guards, hashing) and
[`libs/identity`](../libs/identity/README.md) (sessions, rotation, logout).

### Tokens

| Token   | Algorithm / secret                       | TTL (env)                        | Claims                                                   | Stored server-side                                |
| ------- | ---------------------------------------- | -------------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| Access  | HS256, `JWT_ACCESS_SECRET` (≥ 32 chars)  | 900 s (`JWT_ACCESS_TTL_SEC`)     | `sub`, roles, `jti` (uuidv7), `typ`, `iss`, `aud`, `exp` | no (verified locally); `jti` denylisted on logout |
| Refresh | HS256, `JWT_REFRESH_SECRET` (≥ 32 chars) | 604800 s (`JWT_REFRESH_TTL_SEC`) | `sub`, `jti` = session id, `typ`, `iss`, `aud`, `exp`    | `sessions` row with `sha256(refreshToken)` only   |

- `iss`/`aud` default to `nestjs-boilerplate` (`JWT_ISSUER`, `JWT_AUDIENCE`). Verification allows 5 s of
  clock skew (`JWT_CLOCK_TOLERANCE_SEC`).
- The `typ` claim plus separate secrets mean an access token can never be replayed as a refresh
  token or the other way round.
- Access tokens are verified **at every edge process** with no RPC: signature, `iss`/`aud`/`exp`, `typ`,
  then the Redis denylist (`JwtStrategy`, `libs/auth/src/strategies/jwt.strategy.ts`). The gateway
  and identity-service must share `JWT_ACCESS_SECRET`.
- Roles live in the access token, so a role change takes effect at the next refresh (≤ access TTL).
  Unknown roles in a token are dropped, not rejected (rolling deploys).

### Refresh rotation and reuse detection

`RefreshSessionHandler` (`libs/identity/src/application/commands/refresh-session/`):

1. Verify the refresh JWT first (garbage never reaches the database).
2. In one transaction, compare-and-set the session:
   `UPDATE sessions SET revoked_at, replaced_by_id WHERE id AND user_id AND refresh_token_hash AND revoked_at IS NULL AND expires_at > now`,
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
  `libs/identity/src/domain/session.spec.ts`); clients must discard **both** tokens on logout. The old access token is refused with 401 `TOKEN_REVOKED` on
  REST and GraphQL (`extensions.code`).

- The denylist **fails closed**: a Redis error or a check slower than 250 ms answers 503, never
  "allowed". `AUTH_DENYLIST_ENABLED=false` turns it off (not recommended).
- WebSockets authenticate at the handshake (the denylist is checked there). Per message,
  `WsSessionGuard` re-checks the denylist; every 30 s each replica disconnects its sockets whose
  token was revoked (`TOKEN_REVOKED`), and a per-socket timer disconnects a socket when its access
  token expires (`TOKEN_EXPIRED`).
- graphql-ws subscriptions authenticate at `connection_init` (close code 4403 for an invalid,
  expired, revoked or missing token) and are closed with 4401 when the token's `exp` passes.

### Passwords

- Argon2id via `@node-rs/argon2` (`PasswordHasher`, `libs/auth/src/password/`). Parameters from
  `ARGON2_MEMORY_COST` (19456 KiB), `ARGON2_TIME_COST` (2), `ARGON2_PARALLELISM` (1): the OWASP
  minimum profile. Hashes with outdated parameters are re-hashed transparently at login.
- Password length 8–128 at registration (`IDENTITY_LIMITS`); `MAX_PASSWORD_LENGTH` (1024) in
  `@app/auth` bounds the hashing cost of any input.
- Login runs `verifyDummy` for unknown emails so response timing does not reveal which accounts
  exist; wrong password and unknown email share one 401 `INVALID_CREDENTIALS`.
- Registration and login are throttled per IP by `@AuthThrottle()` (`THROTTLE_AUTH_LIMIT` = 10 per
  `THROTTLE_AUTH_TTL_MS` = 60 s).
- Argon2 runs on the libuv threadpool. Keep `UV_THREADPOOL_SIZE` **at or below the CPUs available to
  the container** (the image default is 4). Measured on the monolith capped at 2 CPUs: 4 threads gave
  p95 36 ms, 16 threads gave p95 304 ms and worse, because the extra busy threads get the whole cgroup
  throttled, event loop included ([DOCKER.md](DOCKER.md#images-dockerfile)).

### 401 / 403 codes

| Status | Code                                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | `MISSING_TOKEN`, `INVALID_TOKEN`, `TOKEN_EXPIRED` (refresh and retry), `TOKEN_REVOKED`, `MISSING_CREDENTIALS`, `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN`, `SESSION_EXPIRED`, `REFRESH_TOKEN_REUSED` |
| 403    | `FORBIDDEN` with `details.requiredRoles` or `details.requiredPermissions`                                                                                                                                |

## Authorisation (RBAC)

Global guards, registered by `AuthModule.forRootAsync()` in this order: `JwtAuthGuard` →
`RolesGuard` → `PermissionsGuard`. They branch on the context type, so the same decorators work on
REST controllers, GraphQL resolvers and WebSocket handlers. `rpc` handlers (gRPC, Kafka) bypass them:
services trust the edge (see [Internal gRPC](#internal-grpc-mtls-reflection)).

| Decorator                                               | Meaning                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `@Public()` (`@app/common`)                             | skip authentication                                        |
| `@RequirePermissions(...p)` / `@RequireAnyPermission()` | all / any of the permissions                               |
| `@Roles(...roles)`                                      | any of the roles (prefer permissions)                      |
| `@Auth(...p)`                                           | alias of `@RequirePermissions(...p)`                       |
| `@CurrentUser(field?)`                                  | the `AuthUser` (401 when absent, even on `@Public` routes) |

### Matrix (`libs/auth/src/rbac/role-permissions.ts`)

| Permission            | `admin` | `moderator` | `user` | Used by                                                       |
| --------------------- | :-----: | :---------: | :----: | ------------------------------------------------------------- |
| `users:read`          |    ✓    |      ✓      |        | `GET /v1/users`, another user's `GET /v1/users/:id`, `users`  |
| `users:write`         |    ✓    |             |        | reserved                                                      |
| `users:manage-roles`  |    ✓    |             |        | `PATCH /v1/users/:id/roles`, `updateUserRoles`                |
| `notifications:read`  |    ✓    |      ✓      |   ✓    | notifications REST, GraphQL, Socket.IO                        |
| `notifications:write` |    ✓    |      ✓      |        | reserved                                                      |
| `billing:checkout`    |    ✓    |             |   ✓    | `POST /v1/billing/checkout-sessions`, `createCheckoutSession` |
| `billing:read-all`    |    ✓    |             |        | `GET /v1/billing/payments?all=true`, `payments(all: true)`    |
| `files:read`          |    ✓    |      ✓      |   ✓    | `GET /v1/files/download-url` (own files)                      |
| `files:write`         |    ✓    |      ✓      |   ✓    | upload, presign, delete (own files)                           |
| `files:manage`        |    ✓    |             |        | download/delete any user's file (each use is logged)          |

Ownership rules that are **not** permissions, enforced by the handlers:

- A user can always read their own profile (`GET /v1/users/:id`, `user(id)`).
- Files are scoped to the key prefix `users/{userId}/`; access is checked before existence (403 before 404) so keys of other users cannot be probed.
- Notifications and payments always use the user id from the token, never from the request.
- Role changes run under `SELECT … FOR UPDATE` plus an advisory lock: an admin cannot drop their own
  admin role (`CANNOT_REVOKE_OWN_ADMIN`) and the last admin cannot be removed
  (`CANNOT_REMOVE_LAST_ADMIN`).

### The first admin

There is no seed account. Every registration gets the `user` role. Promote the first admin
directly in Postgres, then log in again (roles are read into the next token):

```sql
UPDATE users SET roles = ARRAY['admin']::user_role[] WHERE email = 'you@example.com';
```

After that, admins manage roles through `PATCH /v1/users/:id/roles` or `updateUserRoles`.

## Rate limiting

[`libs/redis`](../libs/redis/README.md) `AppThrottlerModule` (global `AppThrottlerGuard`, Redis
storage, one `EVALSHA` per request):

| Setting                           | Default      | Applies to                                                                                                                       |
| --------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `THROTTLE_LIMIT` / `_TTL_MS`      | 100 per 60 s | every HTTP and GraphQL request                                                                                                   |
| `THROTTLE_AUTH_LIMIT` / `_TTL_MS` | 10 per 60 s  | `@AuthThrottle()` routes: register, login (REST and GraphQL)                                                                     |
| `WsThrottlerGuard`                | per handler  | Socket.IO `notifications.markRead`: 30 per 10 s                                                                                  |
| exempt                            | —            | path prefixes `/health`, `/metrics`, `/docs`, `/openapi.json`, `/openapi.yaml`, `/swagger`; the Stripe webhook (`@SkipThrottle`) |

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
your real frontend origins; never use `*` with credentials.

### helmet and CSP (`libs/bootstrap/src/http/security.ts`)

| Mode           | Global CSP                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------- |
| production     | `default-src 'none'; frame-ancestors 'none'` (a JSON API loads nothing and is never framed)  |
| non-production | `'self'` plus the Apollo Sandbox CDN hosts, `crossOriginEmbedderPolicy` off for its iframe   |
| `/docs` route  | its own route-level CSP (`DOCS_CONTENT_SECURITY_POLICY`: jsDelivr + Google Fonts for Scalar) |

Apollo's CSRF prevention is on: GraphQL `GET`s and simple requests need
`content-type: application/json` or an `apollo-require-preflight` header.

### Request limits

| Limit                       | Default                      | Env / source                                |
| --------------------------- | ---------------------------- | ------------------------------------------- |
| JSON body                   | 1 MiB                        | `BODY_LIMIT_BYTES`                          |
| Request timeout (slowloris) | 30 s                         | `HTTP_REQUEST_TIMEOUT_MS`                   |
| Handler timeout             | ~request timeout − 1 s → 504 | `TimeoutInterceptor`, `@Timeout(ms)`        |
| Keep-alive                  | 72 s (must exceed LB idle)   | `HTTP_KEEP_ALIVE_TIMEOUT_MS`                |
| Upload size                 | 25 MiB                       | `STORAGE_MAX_UPLOAD_BYTES`                  |
| Concurrent streamed uploads | 4 per process (503 beyond)   | `STORAGE_MAX_CONCURRENT_UPLOADS`            |
| gRPC message                | 4 MiB                        | `GRPC_MAX_MESSAGE_BYTES`                    |
| graphql-ws payload          | `ws` default (100 MiB)       | not limited in-process: cap it at the proxy |

Validation: the global class-validator pipe runs with `whitelist` + `forbidNonWhitelisted`, zod
bodies are strict, and response serialisers are allow-lists (`@Expose()` classes or zod response
schemas), so unknown fields never leak in or out. Incoming `x-request-id` values are only adopted
when they match `[A-Za-z0-9._:-]{1,128}`.

## Internal gRPC (mTLS, reflection)

The services (identity, notifications, billing) **trust their caller**: `rpc` handlers run no JWT
guard, and `actorId`/`userId` come from the request. Whoever reaches port 50051 can act as any user.
Protect the transport:

| Variable                           | Default              | Effect                                                                                  |
| ---------------------------------- | -------------------- | --------------------------------------------------------------------------------------- |
| `GRPC_TLS_CERT_PATH` + `_KEY_PATH` | unset (plaintext)    | enable TLS on the server, and present this certificate as a client (mTLS); set together |
| `GRPC_TLS_CA_PATH`                 | unset                | CA that signed the **peers'** certificates; required when client certs are required     |
| `GRPC_TLS_REQUIRE_CLIENT_CERT`     | `true`               | server demands a client certificate signed by the CA                                    |
| `GRPC_ALLOW_INSECURE`              | `false`              | production **refuses to boot** with plaintext gRPC unless this explicit opt-out is set  |
| `GRPC_REFLECTION`                  | on unless production | server reflection (grpcurl, Postman); compose turns it on for local use                 |

Production: either mutual TLS (server certificates must name the `*_GRPC_URL` hosts) or a service
mesh doing mTLS with `GRPC_ALLOW_INSECURE=true`, **plus** a NetworkPolicy that lets only the gateway
reach the services' gRPC ports. Keep reflection off.

Client-side resilience (not a security control, but it limits blast radius): every call has a
deadline (`GRPC_DEADLINE_MS`, 5 s), a circuit breaker per upstream, and `UNAVAILABLE` retries only
for `GetUser`, `GetUsersByIds`, `ListUsers`, `ListNotifications`, `ListPayments`. Upstream 5xx details
are sanitised before they reach the client.

## Webhooks and uploads

### Stripe webhook (`POST /v1/billing/webhooks/stripe`)

- The app is created with `rawBody: true`; the signature (`Stripe-Signature`, `STRIPE_WEBHOOK_SECRET`)
  is verified over the exact bytes. In the gateway topology the raw bytes are forwarded over gRPC and
  billing-service verifies them.
- Missing, forged or stale (> 300 s, `STRIPE_WEBHOOK_TOLERANCE_SEC`) signatures are a 422
  `INVALID_WEBHOOK_SIGNATURE` before any I/O.
- Exactly-once processing: `INSERT INTO stripe_events … ON CONFLICT DO NOTHING` inside the same
  transaction as the payment update; duplicates answer `duplicate: true`.
- `@Public()` and `@SkipThrottle()` (Stripe retries any non-2xx).
- Checkout redirect URLs come only from `STRIPE_SUCCESS_URL`/`STRIPE_CANCEL_URL`, never from the
  REST client (no open redirect). Client `Idempotency-Key`s are mapped per user, never forwarded to
  Stripe verbatim.

### File uploads ([`libs/files`](../libs/files/README.md))

- Content-type allow-list (images without SVG, PDF, JSON, ZIP, plain text, CSV, MPEG audio, MP4
  video); `image/svg+xml` and `text/html` are excluded (stored XSS). Checked in the multipart
  `fileFilter` before a byte is read.
- The declared type is checked, the content is not sniffed, so downloads are always presigned with
  `Content-Disposition: attachment`.
- Keys are `users/{userId}/{uuidv7}-{safeFilename}`: unguessable, never overwritten. `assertStorageKey`
  rejects `..`, empty segments, leading `/`, control characters and backslashes; ownership uses a
  segment-aware prefix test (`users/u1` never matches `users/u10`).
- Presigned PUTs sign the content type and the exact `contentLength`; presigned URLs live
  `STORAGE_SIGNED_URL_TTL_SEC` (900 s).

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

| Guard                                                                                              | Source                                         |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` must not be the dev defaults and must differ            | `libs/config/src/namespaces/auth.config.ts`    |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` must not be the dev placeholders (forged webhooks)   | `stripe.config.ts`                             |
| JWT secrets ≥ 32 characters (all environments)                                                     | `auth.config.ts`                               |
| `TRUST_PROXY=true` rejected                                                                        | `app.config.ts`                                |
| plaintext gRPC refused unless `GRPC_ALLOW_INSECURE=true`; TLS cert/key/CA must be consistent       | `grpc.config.ts`                               |
| `DOCS_ENABLED`, `GRAPHQL_SANDBOX`, `GRAPHQL_INTROSPECTION`, `GRPC_REFLECTION` default to off       | `app`, `graphql`, `grpc` namespaces            |
| internal error messages and stack traces hidden (problem+json, GraphQL, gRPC, `/health/ready`)     | `exposeInternalErrors: !isProduction`          |
| paired credentials (SMTP, Cassandra, Kafka SASL) must be set together; Stripe key prefixes checked | `mail`, `cassandra`, `kafka`, `stripe` schemas |

### Log redaction

pino redacts these paths to `[REDACTED]` (`LOG_REDACT_PATHS`,
`libs/observability/src/logging/logger-params.ts`): `req.headers.authorization`, `req.headers.cookie`,
`req.headers["x-api-key"]`, `req.headers["stripe-signature"]`, `res.headers["set-cookie"]`, and
`password`, `token`, `accessToken`, `refreshToken` at the top level plus `*.password`,
`*.passwordHash`, `*.token`, `*.accessToken`, `*.refreshToken`, `*.secret`, `*.apiKey` one level
down. Don't log request bodies or whole DTOs, and add paths here if you introduce new secret fields.
Postgres query logging (`DATABASE_LOG_QUERIES`) prints parameters only outside production; Redis URLs
are logged with credentials removed.

## Ops endpoints (`/metrics`, `/docs`, health)

All of these share the API port (3000):

| Route                                         | Exposure                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /metrics`                                | route-level traffic, error rates, heap and queue internals. Set `METRICS_BEARER_TOKEN` (≥ 16 chars): without `Authorization: Bearer <token>` it answers **404**. `METRICS_ENABLED=false` disables it |
| `GET /docs`, `/openapi.json`, `/openapi.yaml` | off in production unless `DOCS_ENABLED=true`                                                                                                                                                         |
| `GET /health/live`, `/health/ready`           | public, no secrets; failure details hidden in production                                                                                                                                             |

At the ingress, route only `/v1`, `/graphql` and `/notifications` (Socket.IO) publicly and let
Prometheus scrape the pods directly. A separate metrics listener is a [known gap](#known-gaps).

## Production checklist

- [ ] `NODE_ENV=production` (enables every guard above).
- [ ] Strong, distinct `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` from a secret store; the gateway
      and identity-service share the access secret.
- [ ] Real `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (the development placeholders are
      rejected at boot when `NODE_ENV=production`); webhook endpoint API version pinned in the
      Stripe dashboard.
- [ ] `TRUST_PROXY` = the load balancer's IPs/CIDRs; LB idle timeout < `HTTP_KEEP_ALIVE_TIMEOUT_MS`.
- [ ] `CORS_ORIGINS` = your frontend origins only.
- [ ] gRPC: `GRPC_TLS_CERT_PATH`/`_KEY_PATH`/`_CA_PATH` (mTLS), or a mesh + `GRPC_ALLOW_INSECURE=true`;
      NetworkPolicy so only the gateway reaches 50051; `GRPC_REFLECTION` off.
- [ ] `METRICS_BEARER_TOKEN` set; `/metrics`, `/docs`, `/openapi.*` not routed publicly;
      `DOCS_ENABLED`, `GRAPHQL_SANDBOX`, `GRAPHQL_INTROSPECTION` left off.
- [ ] Redis with auth + TLS (`rediss://`), Kafka with `KAFKA_SSL` + SASL, Cassandra and SMTP
      credentials, S3/GCS credentials scoped to the bucket (`GCS_KEY_FILE` or workload identity).
- [ ] `DATABASE_RUN_MIGRATIONS=false` and migrations run as a release job (see [DOCKER.md](DOCKER.md#bootstrap-jobs--migrations)).
- [ ] `UV_THREADPOOL_SIZE` ≤ container CPU limit; `CLUSTER_WORKERS=1` under Kubernetes.
- [ ] Proxy-level limit on WebSocket frame size (graphql-ws, Socket.IO).
- [ ] First admin promoted manually; review `files:manage` and `billing:read-all` holders.
- [ ] Nothing from `docker-compose.yml` reused as is: it ships known credentials, plaintext Kafka,
      password-less Redis and anonymous Grafana by design ([DOCKER.md](DOCKER.md#what-is-local-only-dont-ship-this-compose-file)).

## Known gaps

- `/metrics` is served on the API port; a separate metrics listener is a planned follow-up.
- No admin seed or bootstrap command (manual SQL above).
- Integration events are published after commit, with no transactional outbox: a crash between
  commit and publish loses the event (not a security issue, but an audit-trail one).
- WebSocket revocation is enforced by the per-message guard and a 30 s sweep, not instantly.
