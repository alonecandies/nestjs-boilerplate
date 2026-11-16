import { Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { authConfig } from '@platform/config';
import { CreateTenantHandler } from './application/commands/create-tenant/create-tenant.handler.js';
import { LoginHandler } from './application/commands/login/login.handler.js';
import { LogoutHandler } from './application/commands/logout/logout.handler.js';
import { PurgeExpiredSessionsHandler } from './application/commands/purge-expired-sessions/purge-expired-sessions.handler.js';
import { RefreshSessionHandler } from './application/commands/refresh-session/refresh-session.handler.js';
import { RegisterUserHandler } from './application/commands/register-user/register-user.handler.js';
import { RenameTenantHandler } from './application/commands/rename-tenant/rename-tenant.handler.js';
import { StaffSwitchInHandler } from './application/commands/staff-switch-in/staff-switch-in.handler.js';
import { StaffSwitchOutHandler } from './application/commands/staff-switch-out/staff-switch-out.handler.js';
import { SwitchTenantHandler } from './application/commands/switch-tenant/switch-tenant.handler.js';
import { UserRegisteredRelay } from './application/event-handlers/user-registered.relay.js';
import { AuditEventsRepository } from './application/persistence/audit-events.repository.js';
import { InvitationsRepository } from './application/persistence/invitations.repository.js';
import { MembershipsRepository } from './application/persistence/memberships.repository.js';
import { SessionsRepository } from './application/persistence/sessions.repository.js';
import { TenantsRepository } from './application/persistence/tenants.repository.js';
import { TransactionRunner } from './application/persistence/transaction-runner.js';
import { UsersRepository } from './application/persistence/users.repository.js';
import { GetUserByIdHandler } from './application/queries/get-user-by-id/get-user-by-id.handler.js';
import { GetUsersByIdsHandler } from './application/queries/get-users-by-ids/get-users-by-ids.handler.js';
import { ListMyTenantsHandler } from './application/queries/list-my-tenants/list-my-tenants.handler.js';
import { ListUsersHandler } from './application/queries/list-users/list-users.handler.js';
import { PersonalWorkspaces } from './application/services/personal-workspaces.service.js';
import { SessionTokensService } from './application/services/session-tokens.service.js';
import { TenantAuditLog } from './application/services/tenant-audit-log.service.js';
import { TenantSelection } from './application/services/tenant-selection.service.js';
import { DrizzleAuditEventsRepository } from './infrastructure/persistence/drizzle-audit-events.repository.js';
import { DrizzleInvitationsRepository } from './infrastructure/persistence/drizzle-invitations.repository.js';
import { DrizzleMembershipsRepository } from './infrastructure/persistence/drizzle-memberships.repository.js';
import { DrizzleSessionsRepository } from './infrastructure/persistence/drizzle-sessions.repository.js';
import { DrizzleTenantsRepository } from './infrastructure/persistence/drizzle-tenants.repository.js';
import { DrizzleTransactionRunner } from './infrastructure/persistence/drizzle-transaction.runner.js';
import { DrizzleUsersRepository } from './infrastructure/persistence/drizzle-users.repository.js';
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
  StaffSwitchInHandler,
  StaffSwitchOutHandler,
  PurgeExpiredSessionsHandler,
];

export const IDENTITY_QUERY_HANDLERS = [
  GetUserByIdHandler,
  GetUsersByIdsHandler,
  ListUsersHandler,
  ListMyTenantsHandler,
];

export const IDENTITY_EVENT_HANDLERS = [UserRegisteredRelay];

/** Persistence bindings (the only place that knows it is Drizzle/Postgres). */
const PERSISTENCE: Provider[] = [
  { provide: UsersRepository, useClass: DrizzleUsersRepository },
  { provide: SessionsRepository, useClass: DrizzleSessionsRepository },
  { provide: TenantsRepository, useClass: DrizzleTenantsRepository },
  { provide: MembershipsRepository, useClass: DrizzleMembershipsRepository },
  { provide: InvitationsRepository, useClass: DrizzleInvitationsRepository },
  { provide: AuditEventsRepository, useClass: DrizzleAuditEventsRepository },
  { provide: TransactionRunner, useClass: DrizzleTransactionRunner },
];

/**
 * The identity core: CQRS handlers, the Kafka relay, repositories, the session purge cron and
 * identity's security services: `PasswordHasher` (`password` namespace) and `TokenIssuer` (its own
 * `JwtModule`; `auth` + `refreshToken` namespaces).
 * Imported by the monolith (next to `IdentityApiModule.forLocal()`) and identity-service
 * (through `IdentityGrpcModule`). Expects the app-level global modules: `CqrsModule.forRoot()`,
 * `DatabaseModule.forRootAsync({ schema: identitySchema, migrations: [identityMigrations] })`
 * (Drizzle + transactional CLS plugin), `RedisModule` (denylist, locks), `AuthModule` (the
 * access-token denylist), `KafkaProducerModule` and — for the cron — `ScheduleModule.forRoot()`.
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
    JwtModule.register({}),
  ],
  providers: [
    ...IDENTITY_COMMAND_HANDLERS,
    ...IDENTITY_QUERY_HANDLERS,
    ...IDENTITY_EVENT_HANDLERS,
    ...PERSISTENCE,
    PasswordHasher,
    TokenIssuer,
    SessionTokensService,
    PersonalWorkspaces,
    TenantSelection,
    TenantAuditLog,
    PurgeExpiredSessionsCron,
  ],
})
export class IdentityCoreModule {}
