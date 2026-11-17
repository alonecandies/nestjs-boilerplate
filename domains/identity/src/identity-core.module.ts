import { Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { authConfig, mailConfig } from '@platform/config';
import { OutboxModule } from '@platform/outbox';
import { AcceptInvitationHandler } from './application/commands/accept-invitation/accept-invitation.handler.js';
import { CreateInvitationHandler } from './application/commands/create-invitation/create-invitation.handler.js';
import { CreateTenantHandler } from './application/commands/create-tenant/create-tenant.handler.js';
import { LeaveTenantHandler } from './application/commands/leave-tenant/leave-tenant.handler.js';
import { LoginHandler } from './application/commands/login/login.handler.js';
import { LogoutHandler } from './application/commands/logout/logout.handler.js';
import { PurgeExpiredSessionsHandler } from './application/commands/purge-expired-sessions/purge-expired-sessions.handler.js';
import { RefreshSessionHandler } from './application/commands/refresh-session/refresh-session.handler.js';
import { RegisterUserHandler } from './application/commands/register-user/register-user.handler.js';
import { RemoveMemberHandler } from './application/commands/remove-member/remove-member.handler.js';
import { RenameTenantHandler } from './application/commands/rename-tenant/rename-tenant.handler.js';
import { StaffSwitchInHandler } from './application/commands/staff-switch-in/staff-switch-in.handler.js';
import { StaffSwitchOutHandler } from './application/commands/staff-switch-out/staff-switch-out.handler.js';
import { SwitchTenantHandler } from './application/commands/switch-tenant/switch-tenant.handler.js';
import { UpdateMemberRolesHandler } from './application/commands/update-member-roles/update-member-roles.handler.js';
import { AuditEventsRepository } from './application/persistence/audit-events.repository.js';
import { InvitationsRepository } from './application/persistence/invitations.repository.js';
import { InvitationsSystemRepository } from './application/persistence/invitations.system-repository.js';
import { MembershipsRepository } from './application/persistence/memberships.repository.js';
import { MembershipsSystemRepository } from './application/persistence/memberships.system-repository.js';
import { SessionsRepository } from './application/persistence/sessions.repository.js';
import { SessionsSystemRepository } from './application/persistence/sessions.system-repository.js';
import { TenantsRepository } from './application/persistence/tenants.repository.js';
import { TransactionRunner } from './application/persistence/transaction-runner.js';
import { UsersRepository } from './application/persistence/users.repository.js';
import { UsersSystemRepository } from './application/persistence/users.system-repository.js';
import { InvitationMailer } from './application/ports/invitation-mailer.port.js';
import { GetUserByIdHandler } from './application/queries/get-user-by-id/get-user-by-id.handler.js';
import { GetUsersByIdsHandler } from './application/queries/get-users-by-ids/get-users-by-ids.handler.js';
import { ListMembersHandler } from './application/queries/list-members/list-members.handler.js';
import { ListMyTenantsHandler } from './application/queries/list-my-tenants/list-my-tenants.handler.js';
import { ListUsersHandler } from './application/queries/list-users/list-users.handler.js';
import { IdentityIntegrationEvents } from './application/services/identity-integration-events.service.js';
import { InvitationAcceptance } from './application/services/invitation-acceptance.elevated.js';
import { MembershipActivity } from './application/services/membership-activity.elevated.js';
import { PersonalWorkspaces } from './application/services/personal-workspaces.service.js';
import { SessionTokensService } from './application/services/session-tokens.service.js';
import { TenantAuditLog } from './application/services/tenant-audit-log.service.js';
import { TenantBootstrap } from './application/services/tenant-bootstrap.elevated.js';
import { TenantSelection } from './application/services/tenant-selection.service.js';
import { QueuedInvitationMailer } from './infrastructure/mail/queued-invitation.mailer.js';
import { DrizzleAuditEventsRepository } from './infrastructure/persistence/drizzle-audit-events.repository.js';
import { DrizzleInvitationsRepository } from './infrastructure/persistence/drizzle-invitations.repository.js';
import { DrizzleInvitationsSystemRepository } from './infrastructure/persistence/drizzle-invitations.system-repository.js';
import { DrizzleMembershipsRepository } from './infrastructure/persistence/drizzle-memberships.repository.js';
import { DrizzleMembershipsSystemRepository } from './infrastructure/persistence/drizzle-memberships.system-repository.js';
import { IdentityOutboxSystemRepository } from './infrastructure/persistence/drizzle-outbox.system-repository.js';
import { DrizzleSessionsRepository } from './infrastructure/persistence/drizzle-sessions.repository.js';
import { DrizzleSessionsSystemRepository } from './infrastructure/persistence/drizzle-sessions.system-repository.js';
import { DrizzleTenantsRepository } from './infrastructure/persistence/drizzle-tenants.repository.js';
import { DrizzleTransactionRunner } from './infrastructure/persistence/drizzle-transaction.runner.js';
import { DrizzleUsersRepository } from './infrastructure/persistence/drizzle-users.repository.js';
import { DrizzleUsersSystemRepository } from './infrastructure/persistence/drizzle-users.system-repository.js';
import { IDENTITY_OUTBOX, IdentityOutbox } from './infrastructure/persistence/identity-outbox.js';
import { PurgeExpiredSessionsCron } from './infrastructure/scheduling/purge-expired-sessions.cron.js';
import { passwordConfig } from './infrastructure/security/password.config.js';
import { PasswordHasher } from './infrastructure/security/password-hasher.service.js';
import { refreshTokenConfig } from './infrastructure/security/refresh-token.config.js';
import { staffSwitchInConfig } from './infrastructure/security/staff-switch-in.config.js';
import { TokenIssuer } from './infrastructure/security/token-issuer.service.js';

export const IDENTITY_COMMAND_HANDLERS = [
  RegisterUserHandler,
  LoginHandler,
  RefreshSessionHandler,
  LogoutHandler,
  SwitchTenantHandler,
  CreateTenantHandler,
  RenameTenantHandler,
  UpdateMemberRolesHandler,
  RemoveMemberHandler,
  LeaveTenantHandler,
  CreateInvitationHandler,
  AcceptInvitationHandler,
  StaffSwitchInHandler,
  StaffSwitchOutHandler,
  PurgeExpiredSessionsHandler,
];

export const IDENTITY_QUERY_HANDLERS = [
  GetUserByIdHandler,
  GetUsersByIdsHandler,
  ListUsersHandler,
  ListMyTenantsHandler,
  ListMembersHandler,
];

/**
 * Persistence bindings (the only place that knows it is Drizzle/Postgres): the runtime ports
 * (app_runtime, under RLS) and the system ports (app_system, by identity's named system methods).
 */
const PERSISTENCE: Provider[] = [
  { provide: UsersRepository, useClass: DrizzleUsersRepository },
  { provide: SessionsRepository, useClass: DrizzleSessionsRepository },
  { provide: TenantsRepository, useClass: DrizzleTenantsRepository },
  { provide: MembershipsRepository, useClass: DrizzleMembershipsRepository },
  { provide: InvitationsRepository, useClass: DrizzleInvitationsRepository },
  { provide: AuditEventsRepository, useClass: DrizzleAuditEventsRepository },
  { provide: TransactionRunner, useClass: DrizzleTransactionRunner },
  { provide: UsersSystemRepository, useClass: DrizzleUsersSystemRepository },
  { provide: MembershipsSystemRepository, useClass: DrizzleMembershipsSystemRepository },
  { provide: InvitationsSystemRepository, useClass: DrizzleInvitationsSystemRepository },
  { provide: SessionsSystemRepository, useClass: DrizzleSessionsSystemRepository },
];

/**
 * The identity core: CQRS handlers, repositories, the session purge cron, identity's security
 * services (`PasswordHasher`: `password` namespace; `TokenIssuer`: its own `JwtModule`, `auth` +
 * `refreshToken` namespaces) and identity's outbox (`OutboxModule.forFeature`: the
 * `IdentityOutbox` writer the handlers enqueue integration events with, in their unit of work, and
 * the relay that publishes `identity.outbox` to Kafka; `outbox` namespace).
 * Imported by the monolith (next to `IdentityApiModule.forLocal()`) and identity-service
 * (through `IdentityGrpcModule`). Expects the app-level global modules: `CqrsModule.forRoot()`,
 * `DatabaseModule.forRootAsync({ schema: identitySchema, migrations: [identityMigrations] })`
 * (Drizzle + transactional CLS plugin; the relay needs the system pool), `RedisModule` (denylist,
 * locks: the relay's leader lock), `AuthModule` (the access-token denylist), `KafkaProducerModule`, `AppMailerModule` (`MailService`: invitations are
 * queued; only the processes that run `MailProcessor` deliver them) and — for the cron —
 * `ScheduleModule.forRoot()`.
 */
@Module({
  imports: [
    ConfigModule.forFeature(passwordConfig),
    // TokenIssuer: the access-token settings stay in the platform `auth` namespace (every verifier
    // reads them); the refresh secret and TTL are identity's own. Every sign/verify call passes
    // its secret, algorithm, iss and aud, so this JwtModule carries no defaults.
    ConfigModule.forFeature(authConfig),
    ConfigModule.forFeature(refreshTokenConfig),
    ConfigModule.forFeature(staffSwitchInConfig),
    // CreateInvitationHandler reads `appUrl` (MAIL_APP_URL) for the accept link.
    ConfigModule.forFeature(mailConfig),
    JwtModule.register({}),
    OutboxModule.forFeature({
      feature: IDENTITY_OUTBOX,
      writer: IdentityOutbox,
      systemRepository: IdentityOutboxSystemRepository,
    }),
  ],
  providers: [
    ...IDENTITY_COMMAND_HANDLERS,
    ...IDENTITY_QUERY_HANDLERS,
    ...PERSISTENCE,
    IdentityIntegrationEvents,
    PasswordHasher,
    TokenIssuer,
    SessionTokensService,
    { provide: InvitationMailer, useClass: QueuedInvitationMailer },
    PersonalWorkspaces,
    TenantSelection,
    TenantAuditLog,
    // Justified RLS elevation (spec §9), one service per reason: the only `*.elevated.ts` files.
    TenantBootstrap,
    InvitationAcceptance,
    MembershipActivity,
    PurgeExpiredSessionsCron,
  ],
})
export class IdentityCoreModule {}
