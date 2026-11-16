/**
 * @domain/identity — the identity bounded context: users, registration, login (argon2id + access /
 * refresh JWTs), refresh-token rotation with reuse detection, logout (denylist), RBAC role
 * administration; REST + GraphQL + gRPC presentation over CQRS, hexagonal ports per topology.
 *
 * Entry points: `@domain/identity/api` (edge surface, re-exported here), this root entry (adds core,
 * persistence, commands, queries and domain types) and `@domain/identity/testing` (fakes, tests only).
 * Wiring: `IdentityCoreModule` (handlers, repositories, relay, cron), `IdentityGrpcModule`
 * (identity-service), `IdentityCoreModule` + `IdentityApiModule.forLocal()` (monolith),
 * `IdentityApiModule.forRemote()` from `@domain/identity/api` (gateway). `identitySchema` and the
 * migration set `identityMigrations` go into `DatabaseModule.forRootAsync({ schema, migrations })`.
 */

// The edge surface (also `@domain/identity/api`).
export * from './api/index.js';
// Application: commands/queries (for other in-process callers), persistence ports.
export { LoginCommand } from './application/commands/login/login.command.js';
export { LogoutCommand } from './application/commands/logout/logout.command.js';
export { PurgeExpiredSessionsCommand } from './application/commands/purge-expired-sessions/purge-expired-sessions.command.js';
export { RefreshSessionCommand } from './application/commands/refresh-session/refresh-session.command.js';
export { RegisterUserCommand } from './application/commands/register-user/register-user.command.js';
export { UpdateUserRolesCommand } from './application/commands/update-user-roles/update-user-roles.command.js';
export type {
  MembershipRecord,
  NewMembership,
  TenantMembership,
} from './application/persistence/memberships.repository.js';
export { MembershipsRepository } from './application/persistence/memberships.repository.js';
export type {
  NewSession,
  RotateSessionInput,
  SessionRecord,
} from './application/persistence/sessions.repository.js';
export { SessionsRepository } from './application/persistence/sessions.repository.js';
export type { NewTenant, TenantRecord } from './application/persistence/tenants.repository.js';
export { TenantsRepository } from './application/persistence/tenants.repository.js';
export { TransactionRunner } from './application/persistence/transaction-runner.js';
export type { ListUsersCriteria, UserRecord } from './application/persistence/users.repository.js';
export { UsersRepository } from './application/persistence/users.repository.js';
export { GetUserByIdQuery } from './application/queries/get-user-by-id/get-user-by-id.query.js';
export { GetUsersByIdsQuery } from './application/queries/get-users-by-ids/get-users-by-ids.query.js';
export { ListUsersQuery } from './application/queries/list-users/list-users.query.js';
// Domain.
export { normalizeEmail } from './domain/email.js';
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
  MembershipAlreadyExistsException,
  RefreshTokenReuseDetectedException,
  SessionExpiredException,
  TenantSlugTakenException,
} from './domain/identity.errors.js';
export { TENANT_ROLE_VALUES } from './domain/tenant-role.js';
export {
  deriveTenantSlug,
  personalWorkspaceName,
  slugify,
  TENANT_SLUG_PATTERN,
} from './domain/tenant-slug.js';
export { UserAggregate, type UserSnapshot } from './domain/user.aggregate.js';
export { isUserRole, USER_ROLES, type UserRole } from './domain/user-role.js';
// Modules.
export {
  IDENTITY_COMMAND_HANDLERS,
  IDENTITY_EVENT_HANDLERS,
  IDENTITY_QUERY_HANDLERS,
  IdentityCoreModule,
} from './identity-core.module.js';
export { IdentityGrpcModule } from './identity-grpc.module.js';
// Infrastructure: the Drizzle schema and the migration set for DatabaseModule / drizzle-kit.
export { identityMigrations } from './infrastructure/persistence/identity.migrations.js';
export {
  type IdentitySchema,
  identitySchema,
  memberships,
  sessions,
  sessionsRelations,
  tenantRole,
  tenants,
  userRole,
  users,
  usersRelations,
} from './infrastructure/persistence/identity.schema.js';
// Infrastructure: config namespaces the identity-service and monolith env-example specs validate.
// PasswordHasher and TokenIssuer stay internal (TokenIssuer is on ./testing for test signers).
export { type PasswordConfig, passwordConfig } from './infrastructure/security/password.config.js';
export {
  type RefreshTokenConfig,
  refreshTokenConfig,
} from './infrastructure/security/refresh-token.config.js';
