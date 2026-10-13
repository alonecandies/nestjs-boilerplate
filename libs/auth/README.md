# @platform/auth

JWT authentication and RBAC for HTTP, GraphQL and WebSocket handlers:

- access tokens are verified locally at every service (no RPC per request)
- tokens are issued by the identity context (`TokenIssuer`); this package only verifies them
- `@platform/auth/testing` signs access tokens for tests
- a Redis access-token denylist handles revocation
- roles map to permissions, enforced by guards and decorators

## Public API

| Export                                                                                                                                                                              | Kind                    | Purpose                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthModule.forRootAsync({ globalGuards? })`                                                                                                                                        | global module           | `JwtModule`, `PassportModule`, `TokenService`, `AccessTokenDenylist`, `JwtStrategy`. When `globalGuards` (default `true`) is set, it registers `APP_GUARD`s in the order `JwtAuthGuard` → `RolesGuard` → `PermissionsGuard`. Requires `RedisModule`.                                                |
| `Role`, `ROLE_VALUES`, `isRole` / `Permission`, `PERMISSION_VALUES`, `isPermission`                                                                                                 | enums                   | String values are persisted and sent over gRPC; never rename them.                                                                                                                                                                                                                                  |
| `ROLE_PERMISSIONS`, `resolvePermissions(roles)`, `hasPermissions(granted, required, mode = 'all')`                                                                                  | RBAC                    | The matrix from blueprint §5. Resolution returns canonical order and ignores unknown roles.                                                                                                                                                                                                         |
| `@Roles(...roles)`, `@RequirePermissions(...p)`, `@RequireAnyPermission(...p)`, `@Auth(...p)`                                                                                       | decorators              | Handler-level metadata overrides class-level. `@Roles` matches any of the roles.                                                                                                                                                                                                                    |
| `@CurrentUser(field?)`                                                                                                                                                              | param decorator         | Returns the `AuthUser` (or one of its fields) for http, graphql and ws; 401 when absent.                                                                                                                                                                                                            |
| `TokenService`                                                                                                                                                                      | service                 | `verifyAccessToken(token)` → claims (signature, `iss`/`aud`, `exp` ± 5 s, `typ`; denylist not checked); `toAuthUser(claims)`; `verificationSettings`. Verification only.                                                                                                                            |
| `AccessTokenDenylist`                                                                                                                                                               | service                 | `deny(jti, expEpochSec)` and `isDenied(jti)`. Keys are `{prefix}:auth:denylist:{jti}` with TTL = remaining lifetime + 5 s. It fails closed (503 on error or after 250 ms) and is a no-op when disabled.                                                                                             |
| `JwtStrategy`                                                                                                                                                                       | passport strategy `jwt` | Bearer extraction, HS256 + iss/aud/exp with 5 s tolerance, then the `typ` check, then the denylist. Returns `AuthUser`.                                                                                                                                                                             |
| `JwtAuthGuard`                                                                                                                                                                      | guard                   | Passes `rpc` and `@Public()`. For `ws`, requires a non-expired `socket.data.user`. Runs passport for http/graphql.                                                                                                                                                                                  |
| `RolesGuard`, `PermissionsGuard`, `LocalAuthGuard`                                                                                                                                  | guards                  | `LocalAuthGuard` runs the `local` strategy, which @domain/identity implements.                                                                                                                                                                                                                      |
| `authenticateSocket(tokens, denylist, token)`, `extractSocketToken(handshake)`, `extractBearerToken(v)`                                                                             | WS helpers              | Authenticate once in `handleConnection`, then store the user in `socket.data.user`.                                                                                                                                                                                                                 |
| `parseAccessTokenClaims`, `parseRefreshTokenClaims`, `toAuthUser`, `isAuthUser`, `requireAuthUser`, `toUnauthenticated`                                                             | helpers                 | Claim validation and error mapping. The refresh-claim parser is shared with the issuer, so the `typ` cross-check lives in one place.                                                                                                                                                                |
| `AuthUser`, `AccessTokenClaims`, `RefreshTokenClaims`, `AccessTokenSubject`, `IssuedAccessToken`, `IssuedRefreshToken`, `TokenType`, `PermissionRequirement`, `PermissionMatchMode` | types                   |                                                                                                                                                                                                                                                                                                     |
| `AuthErrorCode`, `ROLES_KEY`, `PERMISSIONS_KEY`, `JWT_STRATEGY`, `LOCAL_STRATEGY`, `JWT_ALGORITHM`, `JWT_CLOCK_TOLERANCE_SEC`                                                       | constants               |                                                                                                                                                                                                                                                                                                     |
| `makeAuthUser(overrides?)`                                                                                                                                                          | test util               | A valid regular user. Permissions are resolved from the roles.                                                                                                                                                                                                                                      |
| `signTestAccessToken(claims, { config? })` (subpath `@platform/auth/testing`)                                                                                                       | test util               | Signs an access token exactly like the production issuer (HS256, `iss`/`aud`, `typ`, uuidv7 `jti`) with `config`, by default the `auth` namespace of `process.env`. Platform and domain specs authenticate with it instead of minting through a service. (`makeAuthUser` stays on the root export.) |

## Usage

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

These variables come from the `auth` namespace of `@platform/config`:

- `JWT_ACCESS_SECRET`: at least 32 characters. The dev default is rejected in production.
- `JWT_ACCESS_TTL_SEC`: default 900.
- `JWT_ISSUER` and `JWT_AUDIENCE`: default `nestjs-boilerplate`.
- `AUTH_DENYLIST_ENABLED`: default `true`.

`JWT_REFRESH_SECRET`/`JWT_REFRESH_TTL_SEC` belong to the identity context's `refreshToken` namespace: verifying processes such as the gateway never load them.

The Redis keys use the `redis` namespace (`REDIS_KEY_PREFIX`). Password hashing (Argon2id) belongs to the identity context, with its own `password` namespace (`ARGON2_*`).

## Gotchas

- **401 codes.** `MISSING_TOKEN`, `INVALID_TOKEN`, `TOKEN_EXPIRED` (clients should refresh), `TOKEN_REVOKED` and `MISSING_CREDENTIALS`. Permission failures are 403 `FORBIDDEN`, with `details.requiredRoles` or `details.requiredPermissions`.
- **Token types.** Access and refresh tokens use different secrets and a `typ` claim, so one can never be replayed as the other. Issuers (and `signTestAccessToken`) write `iat` and `exp` into the payload, so never add `expiresIn` to `JwtModule` sign defaults (jsonwebtoken rejects both).
- **Unknown roles in a token are dropped, not rejected.** This supports rolling deploys with least privilege.
- **`rpc` handlers bypass all three guards.** Services trust the edge. User context travels as gRPC metadata.
- **WebSockets** are authenticated once, at the handshake. `JwtAuthGuard` then only checks that `socket.data.user` exists and is not expired. Revocation is not re-checked per message, so disconnect sockets on logout if you need that.
- **`@CurrentUser()` throws 401 on `@Public()` routes without a user.** Read `req.user` yourself when authentication is optional.
- **Swagger.** `@nestjs/swagger` is not a dependency. Add `@ApiBearerAuth()` in presentation code.
