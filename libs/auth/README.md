# @platform/auth

JWT authentication and RBAC for HTTP, GraphQL and WebSocket handlers:

- access tokens are verified locally at every service (no RPC per request)
- tokens are issued by the domain that signs users in; this package only verifies them
- `@platform/auth/testing` signs access tokens for tests
- a Redis access-token denylist handles revocation
- roles map to permissions, enforced by guards and decorators

## Public API

| Export                                                                                                                                                                              | Kind                    | Purpose                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthModule.forRootAsync({ globalGuards? })`                                                                                                                                        | global module           | `JwtModule`, `PassportModule`, `TokenService`, `AccessTokenDenylist`, `JwtStrategy`. When `globalGuards` (default `true`) is set, it registers `APP_GUARD`s in the order `JwtAuthGuard` → `RolesGuard` → `PermissionsGuard`. Requires `RedisModule`.                                                                    |
| `RbacModule.forRoot()` / `RbacModule.forFeature(feature)`                                                                                                                           | modules                 | `forRoot()` (global, imported by `AuthModule.forRootAsync()`) holds `RbacRegistry` and `RbacVocabularyCheck`; each domain imports `forFeature(<X>_RBAC)` to register its vocabulary.                                                                                                                                    |
| `RbacRegistry`, `defineRbacFeature(feature)`, `RbacVocabularyCheck`, `isPermissionName`, `PERMISSION_PATTERN`                                                                       | RBAC                    | `defineRbacFeature` validates and freezes a vocabulary (`<resource>:<action>` names, default grants per tenant role). `RbacRegistry.resolve(roles)` returns the sorted union of grants through owner ⊇ admin ⊇ member. The check fails the boot when a `@RequirePermissions` name is undeclared.                        |
| `hasPermissions(granted, required, mode = 'all')`                                                                                                                                   | RBAC                    | `'all'` needs every permission, `'any'` at least one.                                                                                                                                                                                                                                                                   |
| `@Roles(...roles)`, `@StaffOnly()`, `@RequirePermissions(...p)`, `@RequireAnyPermission(...p)`, `@Auth(...p)`                                                                       | decorators              | Handler-level metadata overrides class-level. `@Roles` matches any of the tenant roles with the hierarchy owner ⊇ admin ⊇ member; use it for owner-only rules. `@StaffOnly()` admits only platform-staff switch-in tokens (403 `STAFF_ONLY`).                                                                           |
| `@CurrentUser(field?)`                                                                                                                                                              | param decorator         | Returns the `AuthUser` (or one of its fields) for http, graphql and ws; 401 when absent.                                                                                                                                                                                                                                |
| `TokenService`                                                                                                                                                                      | service                 | `verifyAccessToken(token)` → claims (signature, `iss`/`aud`, `exp` ± 5 s, `typ`; denylist not checked); `toAuthUser(claims)`; `verificationSettings`. Verification only.                                                                                                                                                |
| `AccessTokenDenylist`                                                                                                                                                               | service                 | `deny(jti, expEpochSec)` and `isDenied(jti)`. Keys are `{prefix}:auth:denylist:{jti}` with TTL = remaining lifetime + 5 s. It fails closed (503 on error or after 250 ms) and is a no-op when disabled.                                                                                                                 |
| `JwtStrategy`                                                                                                                                                                       | passport strategy `jwt` | Bearer extraction, HS256 + iss/aud/exp with 5 s tolerance, then the `typ` check, then the denylist. Returns `AuthUser`.                                                                                                                                                                                                 |
| `JwtAuthGuard`                                                                                                                                                                      | guard                   | Passes `rpc` and `@Public()`. For `ws`, requires a non-expired `socket.data.user`. Runs passport for http/graphql.                                                                                                                                                                                                      |
| `principalOf(user)`                                                                                                                                                                 | helper                  | The CLS principal (`{ userId, tenantId, roles, staff }`) of an `AuthUser`.                                                                                                                                                                                                                                              |
| `PrincipalContextInterceptor`                                                                                                                                                       | interceptor             | Registered with the global guards (`APP_INTERCEPTOR`); writes the principal for Socket.IO and graphql-ws.                                                                                                                                                                                                               |
| `RolesGuard`, `StaffOnlyGuard`, `PermissionsGuard`, `LocalAuthGuard`                                                                                                                | guards                  | `LocalAuthGuard` runs the `local` strategy, which the consuming domain implements.                                                                                                                                                                                                                                      |
| `RevocationSweeper(denylist, { name, intervalMs })`, `RevocableSession`                                                                                                             | WS revocation           | One per transport and replica. `track({ jti, end })` returns an idempotent untrack function; `sweep()` checks each distinct `jti` once, ends and untracks the revoked sessions and never overlaps itself (a denylist error keeps every session and logs one warning); `start()`/`stop()` run it on an unref'd interval. |
| `authenticateSocket(tokens, denylist, token)`, `extractSocketToken(handshake)`, `extractBearerToken(v)`                                                                             | WS helpers              | Authenticate once per handshake in namespace middleware (`afterInit` + `namespace.use`), then store the user in `socket.data.user`.                                                                                                                                                                                     |
| `parseAccessTokenClaims`, `parseRefreshTokenClaims`, `toAuthUser`, `isAuthUser`, `requireAuthUser`, `toUnauthenticated`                                                             | helpers                 | Claim validation and error mapping. The refresh-claim parser is shared with the issuer, so the `typ` cross-check lives in one place.                                                                                                                                                                                    |
| `AuthUser`, `AccessTokenClaims`, `RefreshTokenClaims`, `AccessTokenSubject`, `IssuedAccessToken`, `IssuedRefreshToken`, `TokenType`, `PermissionRequirement`, `PermissionMatchMode` | types                   |                                                                                                                                                                                                                                                                                                                         |
| `AuthErrorCode`, `RbacErrorCode`, `ROLES_KEY`, `STAFF_ONLY_KEY`, `PERMISSIONS_KEY`, `JWT_STRATEGY`, `LOCAL_STRATEGY`, `JWT_ALGORITHM`, `JWT_CLOCK_TOLERANCE_SEC`                    | constants               |                                                                                                                                                                                                                                                                                                                         |
| `makeAuthUser(overrides?, rbac?)` (subpath `@platform/auth/testing`)                                                                                                                | test util               | A valid regular user (pass an `RbacRegistry` to resolve permissions). `createTestRbacRegistry(...features)` and `TEST_RBAC_FEATURE` live in the same subpath.                                                                                                                                                           |
| `signTestAccessToken(claims, { config? })` (subpath `@platform/auth/testing`)                                                                                                       | test util               | Signs an access token exactly like the production issuer (HS256, `iss`/`aud`, `typ`, uuidv7 `jti`) with `config`, by default the `auth` namespace of `process.env`. Platform and domain specs authenticate with it instead of minting through a service.                                                                |

## Usage

Handlers read the caller with `getPrincipal()` / `requirePrincipal()` from `@platform/common`; `JwtAuthGuard` writes it for HTTP and GraphQL over HTTP.

```ts
// edge app (gateway / monolith)
imports: [RedisModule.forRootAsync(), AuthModule.forRootAsync(), AppThrottlerModule.forRootAsync()]

// gRPC-only service: no global guards, just verification and the denylist
imports: [RedisModule.forRootAsync(), AuthModule.forRootAsync({ globalGuards: false })]

@Controller('users')
export class UsersController {
  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) { … }   // any authenticated user

  @Patch(':id/roles')
  @RequirePermissions('orders:approve') // declared by RbacModule.forFeature(ORDERS_RBAC)
  updateRoles(@CurrentUser('id') actorId: string) { … }
}

// WebSocket gateway: authenticate once per handshake in namespace middleware, so a refused
// socket never reaches handleConnection (as NotificationsGateway does).
afterInit(namespace: Namespace): void {
  namespace.use((socket, next) => {
    authenticateSocket(this.tokens, this.denylist, extractSocketToken(socket.handshake)).then(
      (user) => {
        socket.data.user = user;
        next();
      },
      (error: unknown) => {
        const problem = toProblemDetails(error, { exposeInternal: false });
        next(Object.assign(new Error(problem.detail ?? problem.title), { data: problem }));
      },
    );
  });
}
```

## Environment

These variables come from the `auth` namespace of `@platform/config`:

- `JWT_ACCESS_SECRET`: at least 32 characters. The dev default is rejected in production.
- `JWT_ACCESS_TTL_SEC`: default 900.
- `JWT_ISSUER` and `JWT_AUDIENCE`: default `nestjs-boilerplate`.
- `AUTH_DENYLIST_ENABLED`: default `true`.
- `WS_REVOCATION_SWEEP_INTERVAL_MS`: default 30000 (100..300000), the period of each WebSocket transport's `RevocationSweeper`.

`JWT_REFRESH_SECRET`/`JWT_REFRESH_TTL_SEC` belong to the token issuer's own `refreshToken` namespace: verifying processes such as the gateway never load them.

The Redis keys use the `redis` namespace (`REDIS_KEY_PREFIX`). Password hashing is not part of this package: the domain that stores credentials owns it, with its own `password` namespace.

## Gotchas

- **401 codes.** `MISSING_TOKEN`, `INVALID_TOKEN`, `TOKEN_EXPIRED` (clients should refresh), `TOKEN_REVOKED` and `MISSING_CREDENTIALS`. Permission failures are 403 `FORBIDDEN`, with `details.requiredRoles` or `details.requiredPermissions`.
- **Token types.** Access and refresh tokens use different secrets and a `typ` claim, so one can never be replayed as the other. Issuers (and `signTestAccessToken`) write `iat` and `exp` into the payload and pass their secret, algorithm, `iss` and `aud` per call, so never add `expiresIn` to `JwtModule` sign defaults (jsonwebtoken rejects both). `AuthModule`'s own `JwtModule` has no sign defaults at all: this package only verifies.
- **Unknown roles in a token are dropped, not rejected.** This supports rolling deploys with least privilege.
- **`rpc` handlers bypass all three guards.** Services trust the edge. User context travels as gRPC metadata.
- **WebSockets** are authenticated once, at the handshake. `JwtAuthGuard` then only checks that `socket.data.user` exists and is not expired; it does not re-check revocation. Track each socket in a `RevocationSweeper` (and untrack it on disconnect) so a revoked token's sockets close within the sweep interval; re-check the denylist per message where that is not soon enough.
- **`@CurrentUser()` throws 401 on `@Public()` routes without a user.** Read `req.user` yourself when authentication is optional.
- **Swagger.** `@nestjs/swagger` is not a dependency. Add `@ApiBearerAuth()` in presentation code.
