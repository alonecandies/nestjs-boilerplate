/**
 * @platform/auth — JWT access-token verification (passport-jwt, HS256, verified locally at every
 * service), the Redis access-token denylist and RBAC (roles → permissions, guards, decorators) for
 * HTTP, GraphQL and WebSocket handlers. Tokens are issued by the context that owns sessions; tests
 * sign them with `@platform/auth/testing`.
 */
export {
  AuthErrorCode,
  JWT_ALGORITHM,
  JWT_CLOCK_TOLERANCE_SEC,
  JWT_STRATEGY,
  LOCAL_STRATEGY,
  PERMISSIONS_KEY,
  RbacErrorCode,
  ROLES_KEY,
  STAFF_ONLY_KEY,
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
export { StaffOnly } from './decorators/staff-only.decorator.js';
export { requireAuthUser } from './guards/current-auth-user.js';
export { JwtAuthGuard } from './guards/jwt-auth.guard.js';
export { LocalAuthGuard } from './guards/local-auth.guard.js';
export { PermissionsGuard } from './guards/permissions.guard.js';
export { RolesGuard } from './guards/roles.guard.js';
export { StaffOnlyGuard } from './guards/staff-only.guard.js';
export { hasPermissions, type PermissionMatchMode } from './rbac/permission-match.js';
export { RbacModule } from './rbac/rbac.module.js';
export { RbacRegistry } from './rbac/rbac.registry.js';
export {
  defineRbacFeature,
  isPermissionName,
  PERMISSION_PATTERN,
  type RbacFeature,
} from './rbac/rbac-feature.js';
export { RbacVocabularyCheck } from './rbac/rbac-vocabulary.check.js';
export { JwtStrategy } from './strategies/jwt.strategy.js';
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
