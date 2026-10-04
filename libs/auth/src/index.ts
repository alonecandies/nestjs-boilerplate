/**
 * @app/auth — JWT authentication (passport-jwt, HS256, verified locally at every service),
 * refresh tokens, the Redis access-token denylist, Argon2id password hashing and RBAC
 * (roles → permissions, guards, decorators) for HTTP, GraphQL and WebSocket handlers.
 */
export {
  AuthErrorCode,
  JWT_ALGORITHM,
  JWT_CLOCK_TOLERANCE_SEC,
  JWT_STRATEGY,
  LOCAL_STRATEGY,
  MAX_PASSWORD_LENGTH,
  PERMISSIONS_KEY,
  ROLES_KEY,
} from './auth.constants.js';
export { AuthModule, type AuthModuleSetup, createJwtModuleOptions } from './auth.module.js';
export { Auth } from './decorators/auth.decorator.js';
export { CurrentUser } from './decorators/current-user.decorator.js';
export {
  type PermissionRequirement,
  RequireAnyPermission,
  RequirePermissions,
} from './decorators/require-permissions.decorator.js';
export { Roles } from './decorators/roles.decorator.js';
export { requireAuthUser } from './guards/current-auth-user.js';
export { JwtAuthGuard } from './guards/jwt-auth.guard.js';
export { LocalAuthGuard } from './guards/local-auth.guard.js';
export { PermissionsGuard } from './guards/permissions.guard.js';
export { RolesGuard } from './guards/roles.guard.js';
export { PasswordHasher } from './password/password-hasher.service.js';
export { isPermission, PERMISSION_VALUES, Permission } from './rbac/permission.enum.js';
export { isRole, ROLE_VALUES, Role } from './rbac/role.enum.js';
export {
  hasPermissions,
  type PermissionMatchMode,
  ROLE_PERMISSIONS,
  resolvePermissions,
} from './rbac/role-permissions.js';
export { JwtStrategy } from './strategies/jwt.strategy.js';
export { makeAuthUser } from './testing/auth-test.utils.js';
export { AccessTokenDenylist } from './tokens/access-token-denylist.service.js';
export {
  type JwtVerificationSettings,
  TokenService,
  toUnauthenticated,
} from './tokens/token.service.js';
export {
  isAuthUser,
  parseAccessTokenClaims,
  parseRefreshTokenClaims,
  toAuthUser,
} from './tokens/token-claims.js';
export type {
  AccessTokenClaims,
  AccessTokenSubject,
  AuthUser,
  IssuedAccessToken,
  IssuedRefreshToken,
  RefreshTokenClaims,
  TokenType,
} from './types/auth-user.js';
export {
  authenticateSocket,
  extractBearerToken,
  extractSocketToken,
  type HandshakeLike,
} from './ws/socket-auth.js';
