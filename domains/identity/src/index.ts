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
export { CreateTenantCommand } from './application/commands/create-tenant/create-tenant.command.js';
export { CreateTenantHandler } from './application/commands/create-tenant/create-tenant.handler.js';
export { LeaveTenantCommand } from './application/commands/leave-tenant/leave-tenant.command.js';
export { LeaveTenantHandler } from './application/commands/leave-tenant/leave-tenant.handler.js';
export { LoginCommand } from './application/commands/login/login.command.js';
export { LogoutCommand } from './application/commands/logout/logout.command.js';
export { PurgeExpiredSessionsCommand } from './application/commands/purge-expired-sessions/purge-expired-sessions.command.js';
export { RefreshSessionCommand } from './application/commands/refresh-session/refresh-session.command.js';
export { RegisterUserCommand } from './application/commands/register-user/register-user.command.js';
export { RemoveMemberCommand } from './application/commands/remove-member/remove-member.command.js';
export { RemoveMemberHandler } from './application/commands/remove-member/remove-member.handler.js';
export { RenameTenantCommand } from './application/commands/rename-tenant/rename-tenant.command.js';
export { RenameTenantHandler } from './application/commands/rename-tenant/rename-tenant.handler.js';
// Application: commands/queries (for other in-process callers), persistence ports.
export { StaffSwitchInCommand } from './application/commands/staff-switch-in/staff-switch-in.command.js';
export { StaffSwitchOutCommand } from './application/commands/staff-switch-out/staff-switch-out.command.js';
export { SwitchTenantCommand } from './application/commands/switch-tenant/switch-tenant.command.js';
export { UpdateMemberRolesCommand } from './application/commands/update-member-roles/update-member-roles.command.js';
export { UpdateMemberRolesHandler } from './application/commands/update-member-roles/update-member-roles.handler.js';
export { toMemberContract } from './application/mappers/member.mapper.js';
export {
  normalizeTenantName,
  toMyTenantContract,
  toTenantContract,
} from './application/mappers/tenancy.mapper.js';
export type {
  AuditEventRecord,
  AuditEventType,
  NewAuditEvent,
} from './application/persistence/audit-events.repository.js';
export {
  AUDIT_EVENT_TYPES,
  AuditEventsRepository,
} from './application/persistence/audit-events.repository.js';
export type {
  InvitationRecord,
  NewInvitation,
} from './application/persistence/invitations.repository.js';
export { InvitationsRepository } from './application/persistence/invitations.repository.js';
export type {
  MemberRecord,
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
export { ListMembersHandler } from './application/queries/list-members/list-members.handler.js';
export { ListMembersQuery } from './application/queries/list-members/list-members.query.js';
export { ListMyTenantsHandler } from './application/queries/list-my-tenants/list-my-tenants.handler.js';
export { ListMyTenantsQuery } from './application/queries/list-my-tenants/list-my-tenants.query.js';
export { ListUsersQuery } from './application/queries/list-users/list-users.query.js';
export { PersonalWorkspaces } from './application/services/personal-workspaces.service.js';
export {
  type OpenSessionInput,
  SessionTokensService,
} from './application/services/session-tokens.service.js';
export {
  actorTenantRoles,
  requireSelf,
  requireTenantActor,
} from './application/services/tenant-actor.js';
export {
  type TenantAuditEntry,
  TenantAuditLog,
} from './application/services/tenant-audit-log.service.js';
export { TenantSelection } from './application/services/tenant-selection.service.js';
// Domain.
export { normalizeEmail } from './domain/email.js';
export { UserRegisteredEvent } from './domain/events/user-registered.event.js';
export {
  EmailAlreadyTakenException,
  GlobalRolesRemovedException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
  InvalidRolesException,
  InvalidUserException,
  LastOwnerException,
  MembershipAlreadyExistsException,
  MembershipRevokedException,
  NotPlatformStaffException,
  OwnerRankRequiredException,
  RefreshTokenReuseDetectedException,
  SessionExpiredException,
  StaffTokenNotAllowedException,
  TenantAccessDeniedException,
  TenantSlugTakenException,
} from './domain/identity.errors.js';
export {
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_TOKEN_BYTES,
  INVITATION_TTL_MS,
} from './domain/invitation-token.js';
export {
  assertCanAssignRoles,
  assertCanRemove,
  parseTenantRoles,
} from './domain/member-roles.policy.js';
export { TENANT_ROLE_VALUES } from './domain/tenant-role.js';
export {
  deriveTenantSlug,
  personalWorkspaceName,
  slugify,
  TENANT_SLUG_PATTERN,
} from './domain/tenant-slug.js';
export { UserAggregate, type UserSnapshot } from './domain/user.aggregate.js';
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
  auditEvents,
  type IdentitySchema,
  identitySchema,
  invitations,
  memberships,
  sessions,
  sessionsRelations,
  tenantRole,
  tenants,
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
export {
  type StaffSwitchInConfig,
  staffSwitchInConfig,
} from './infrastructure/security/staff-switch-in.config.js';
