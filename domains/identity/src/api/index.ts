/**
 * @domain/identity/api — the edge surface of the identity context: `IdentityApiModule`
 * (`forRemote()` for the gateway; `forLocal()` for the monolith, which also imports
 * `IdentityCoreModule` from `@domain/identity`), the `AuthPort` / `UsersPort` ports, the gRPC client
 * config and the GraphQL / REST types the apps compose with. Its import graph reaches no core module,
 * persistence or security file (`node scripts/check-api-subpaths.mjs`), so an app that imports only
 * this entry ships without them (assemble-image file tracing).
 */
export { AuthPort } from '../application/ports/auth.port.js';
export { UsersPort } from '../application/ports/users.port.js';
export {
  IDENTITY_LIMITS,
  IdentityErrorCode,
  USER_CACHE_TTL_MS,
  USERS_LOADER,
  userCacheKey,
} from '../identity.constants.js';
export { IDENTITY_RBAC, IdentityPermission } from '../identity.permissions.js';
export { IdentityApiModule } from '../identity-api.module.js';
export {
  type IdentityGrpcClientConfig,
  identityGrpcClientConfig,
  identityGrpcClientEnvSchema,
} from '../infrastructure/adapters/grpc/identity-grpc-client.config.js';
export { AuthPayloadModel } from '../presentation/graphql/models/auth-payload.model.js';
export { UserModel } from '../presentation/graphql/models/user.model.js';
export { UserConnectionModel } from '../presentation/graphql/models/user-connection.model.js';
export { RoleEnum } from '../presentation/graphql/role.enum.js';
// Loads the `GraphqlLoaders['users']` augmentation for every importer of this entry.
export { UsersLoaderRegistrar } from '../presentation/graphql/users-loader.registrar.js';
export { UserResponse } from '../presentation/http/responses/user.response.js';
// The credential rate-limit policy config (loaded by IdentityApiModule; the env-example specs
// validate this namespace too).
export {
  type IdentityRateLimitConfig,
  identityRateLimitConfig,
} from '../presentation/rate-limit/identity-rate-limit.config.js';
