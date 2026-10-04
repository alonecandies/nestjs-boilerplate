# @app/auth

JWT authentication and RBAC for HTTP, GraphQL and WebSocket handlers:

- access tokens are verified locally at every service (no RPC per request)
- refresh tokens are signed with their own secret
- a Redis access-token denylist handles revocation
- passwords are hashed with Argon2id
- roles map to permissions, enforced by guards and decorators

## Public API

| Export                                                                                                                                                                              | Kind                    | Purpose                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthModule.forRootAsync({ globalGuards? })`                                                                                                                                        | global module           | `JwtModule`, `PassportModule`, `TokenService`, `PasswordHasher`, `AccessTokenDenylist`, `JwtStrategy`. When `globalGuards` (default `true`) is set, it registers `APP_GUARD`s in the order `JwtAuthGuard` → `RolesGuard` → `PermissionsGuard`. Requires `RedisModule`. |
| `Role`, `ROLE_VALUES`, `isRole` / `Permission`, `PERMISSION_VALUES`, `isPermission`                                                                                                 | enums                   | String values are persisted and sent over gRPC; never rename them.                                                                                                                                                                                                     |
| `ROLE_PERMISSIONS`, `resolvePermissions(roles)`, `hasPermissions(granted, required, mode = 'all')`                                                                                  | RBAC                    | The matrix from blueprint §5. Resolution returns canonical order and ignores unknown roles.                                                                                                                                                                            |
| `@Roles(...roles)`, `@RequirePermissions(...p)`, `@RequireAnyPermission(...p)`, `@Auth(...p)`                                                                                       | decorators              | Handler-level metadata overrides class-level. `@Roles` matches any of the roles.                                                                                                                                                                                       |
| `@CurrentUser(field?)`                                                                                                                                                              | param decorator         | Returns the `AuthUser` (or one of its fields) for http, graphql and ws; 401 when absent.                                                                                                                                                                               |
| `TokenService`                                                                                                                                                                      | service                 | `issueAccessToken(user)` → `{ token, jti, expiresIn, exp }`; `issueRefreshToken({ userId, sessionId })` → `{ token, expiresAt }`; `verifyAccessToken` / `verifyRefreshToken` → claims; `toAuthUser(claims)`; `verificationSettings`.                                   |
| `AccessTokenDenylist`                                                                                                                                                               | service                 | `deny(jti, expEpochSec)` and `isDenied(jti)`. Keys are `{prefix}:auth:denylist:{jti}` with TTL = remaining lifetime + 5 s. It fails closed (503) and is a no-op when disabled.                                                                                         |
| `PasswordHasher`                                                                                                                                                                    | service                 | `hash(plain)`, `verify(hash, plain)` (never throws), `verifyDummy(plain)` (equalises login timing for unknown users), `needsRehash(hash)`.                                                                                                                             |
| `JwtStrategy`                                                                                                                                                                       | passport strategy `jwt` | Bearer extraction, HS256 + iss/aud/exp with 5 s tolerance, then the `typ` check, then the denylist. Returns `AuthUser`.                                                                                                                                                |
| `JwtAuthGuard`                                                                                                                                                                      | guard                   | Passes `rpc` and `@Public()`. For `ws`, requires a non-expired `socket.data.user`. Runs passport for http/graphql.                                                                                                                                                     |
| `RolesGuard`, `PermissionsGuard`, `LocalAuthGuard`                                                                                                                                  | guards                  | `LocalAuthGuard` runs the `local` strategy, which @app/identity implements.                                                                                                                                                                                            |
| `authenticateSocket(tokens, denylist, token)`, `extractSocketToken(handshake)`, `extractBearerToken(v)`                                                                             | WS helpers              | Authenticate once in `handleConnection`, then store the user in `socket.data.user`.                                                                                                                                                                                    |
| `parseAccessTokenClaims`, `parseRefreshTokenClaims`, `toAuthUser`, `isAuthUser`, `requireAuthUser`, `toUnauthenticated`                                                             | helpers                 | Claim validation and error mapping.                                                                                                                                                                                                                                    |
| `AuthUser`, `AccessTokenClaims`, `RefreshTokenClaims`, `AccessTokenSubject`, `IssuedAccessToken`, `IssuedRefreshToken`, `TokenType`, `PermissionRequirement`, `PermissionMatchMode` | types                   |                                                                                                                                                                                                                                                                        |
| `AuthErrorCode`, `ROLES_KEY`, `PERMISSIONS_KEY`, `JWT_STRATEGY`, `LOCAL_STRATEGY`, `JWT_ALGORITHM`, `JWT_CLOCK_TOLERANCE_SEC`, `MAX_PASSWORD_LENGTH`                                | constants               |                                                                                                                                                                                                                                                                        |
| `makeAuthUser(overrides?)`                                                                                                                                                          | test util               | A valid regular user. Permissions are resolved from the roles.                                                                                                                                                                                                         |

## Usage

```ts
// edge app (gateway / monolith)
imports: [RedisModule.forRootAsync(), AuthModule.forRootAsync(), AppThrottlerModule.forRootAsync()]

// gRPC-only service: no global guards, just issue/verify/hash
imports: [RedisModule.forRootAsync(), AuthModule.forRootAsync({ globalGuards: false })]

@Controller('users')
export class UsersController {
  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) { … }   // any authenticated user

  @Patch(':id/roles')
  @RequirePermissions(Permission.UsersManageRoles)
  updateRoles(@CurrentUser('id') actorId: string) { … }
}

// WebSocket gateway
async handleConnection(client: Socket): Promise<void> {
  try {
    client.data.user = await authenticateSocket(this.tokens, this.denylist, extractSocketToken(client.handshake));
  } catch (error) {
    client.emit('exception', toProblemDetails(error, { exposeInternal: false }));
    client.disconnect(true);
  }
}
```

## Environment

These variables come from the `auth` namespace of `@app/config`:

- `JWT_ACCESS_SECRET`: at least 32 characters. The dev default is rejected in production.
- `JWT_ACCESS_TTL_SEC`: default 900.
- `JWT_REFRESH_SECRET`: must differ from the access secret in production.
- `JWT_REFRESH_TTL_SEC`: default 604800.
- `JWT_ISSUER` and `JWT_AUDIENCE`: default `nestjs-boilerplate`.
- `ARGON2_MEMORY_COST`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM`: default 19456, 2 and 1.
- `AUTH_DENYLIST_ENABLED`: default `true`.

The Redis keys use the `redis` namespace (`REDIS_KEY_PREFIX`). Set `UV_THREADPOOL_SIZE` (for example 16) as a process environment variable on login-heavy services, because Argon2 runs on the libuv threadpool.

## Gotchas

- **401 codes.** `MISSING_TOKEN`, `INVALID_TOKEN`, `TOKEN_EXPIRED` (clients should refresh), `TOKEN_REVOKED` and `MISSING_CREDENTIALS`. Permission failures are 403 `FORBIDDEN`, with `details.requiredRoles` or `details.requiredPermissions`.
- **Token types.** Access and refresh tokens use different secrets and a `typ` claim, so one can never be replayed as the other. `TokenService` writes `iat` and `exp` into the payload, so never add `expiresIn` to `JwtModule` sign defaults (jsonwebtoken rejects both).
- **Unknown roles in a token are dropped, not rejected.** This supports rolling deploys with least privilege.
- **`rpc` handlers bypass all three guards.** Services trust the edge. User context travels as gRPC metadata.
- **WebSockets** are authenticated once, at the handshake. `JwtAuthGuard` then only checks that `socket.data.user` exists and is not expired. Revocation is not re-checked per message, so disconnect sockets on logout if you need that.
- **`@CurrentUser()` throws 401 on `@Public()` routes without a user.** Read `req.user` yourself when authentication is optional.
- **Argon2 `Algorithm`.** `@node-rs/argon2`'s `Algorithm` is an ambient const enum with an empty runtime object, so hashing relies on the default (Argon2id) and `needsRehash` compares against the literal `2`.
- **Swagger.** `@nestjs/swagger` is not a dependency. Add `@ApiBearerAuth()` in presentation code.
