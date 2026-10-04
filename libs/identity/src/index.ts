/**
 * @app/identity — the identity bounded context: users, registration, login (argon2id + access /
 * refresh JWTs), refresh-token rotation with reuse detection, logout (denylist), RBAC role
 * administration; REST + GraphQL + gRPC presentation over CQRS, hexagonal ports per topology.
 *
 * Wiring: `IdentityCoreModule` (handlers, repositories, relay, cron), `IdentityGrpcModule`
 * (identity-service), `IdentityApiModule.forLocal()` (monolith) / `.forRemote()` (gateway).
 * `identitySchema` goes into `DatabaseModule.forRootAsync({ schema })`.
 */

// Application: ports, commands/queries (for other in-process callers), mappers.
export { LoginCommand } from './application/commands/login/login.command.js';
export { LogoutCommand } from './application/commands/logout/logout.command.js';
export { PurgeExpiredSessionsCommand } from './application/commands/purge-expired-sessions/purge-expired-sessions.command.js';
export { RefreshSessionCommand } from './application/commands/refresh-session/refresh-session.command.js';
export { RegisterUserCommand } from './application/commands/register-user/register-user.command.js';
export { UpdateUserRolesCommand } from './application/commands/update-user-roles/update-user-roles.command.js';
export type {
  NewSession,
  RotateSessionInput,
  SessionRecord,
} from './application/persistence/sessions.repository.js';
export { SessionsRepository } from './application/persistence/sessions.repository.js';
export { TransactionRunner } from './application/persistence/transaction-runner.js';
export type {
  ListUsersCriteria,
  UserRecord,
} from './application/persistence/users.repository.js';
export { UsersRepository } from './application/persistence/users.repository.js';
export { AuthPort } from './application/ports/auth.port.js';
export { UsersPort } from './application/ports/users.port.js';
export { GetUserByIdQuery } from './application/queries/get-user-by-id/get-user-by-id.query.js';
export { GetUsersByIdsQuery } from './application/queries/get-users-by-ids/get-users-by-ids.query.js';
export { ListUsersQuery } from './application/queries/list-users/list-users.query.js';
// Domain.
export { UserRegisteredEvent } from './domain/events/user-registered.event.js';
export { UserRolesChangedEvent } from './domain/events/user-roles-changed.event.js';
export {
  CannotRemoveLastAdminException,
  CannotRevokeOwnAdminRoleException,
  EmailAlreadyTakenException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
  InvalidRolesException,
  InvalidUserException,
  RefreshTokenReuseDetectedException,
  SessionExpiredException,
} from './domain/identity.errors.js';
export { UserAggregate, type UserSnapshot } from './domain/user.aggregate.js';
export { isUserRole, USER_ROLES, type UserRole } from './domain/user-role.js';
export {
  IDENTITY_LIMITS,
  IdentityErrorCode,
  USER_CACHE_TTL_MS,
  USERS_LOADER,
  userCacheKey,
} from './identity.constants.js';
// Modules.
export { IdentityApiModule } from './identity-api.module.js';
export {
  IDENTITY_COMMAND_HANDLERS,
  IDENTITY_EVENT_HANDLERS,
  IDENTITY_QUERY_HANDLERS,
  IdentityCoreModule,
} from './identity-core.module.js';
export { IdentityGrpcModule } from './identity-grpc.module.js';
// Infrastructure: the Drizzle schema for DatabaseModule / drizzle-kit.
export {
  type IdentitySchema,
  identitySchema,
  sessions,
  sessionsRelations,
  userRole,
  users,
  usersRelations,
} from './infrastructure/persistence/identity.schema.js';
// Presentation: GraphQL types other domains reference (billing's `Payment.user`).
export { AuthPayloadModel } from './presentation/graphql/models/auth-payload.model.js';
export { UserModel } from './presentation/graphql/models/user.model.js';
export { UserConnectionModel } from './presentation/graphql/models/user-connection.model.js';
export { RoleEnum } from './presentation/graphql/role.enum.js';
// Loads the `GraphqlLoaders['users']` augmentation for every importer of this package.
export { UsersLoaderRegistrar } from './presentation/graphql/users-loader.registrar.js';
export { UserResponse } from './presentation/http/responses/user.response.js';
