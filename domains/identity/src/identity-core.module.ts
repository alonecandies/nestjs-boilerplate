import { Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { authConfig } from '@platform/config';
import { LoginHandler } from './application/commands/login/login.handler.js';
import { LogoutHandler } from './application/commands/logout/logout.handler.js';
import { PurgeExpiredSessionsHandler } from './application/commands/purge-expired-sessions/purge-expired-sessions.handler.js';
import { RefreshSessionHandler } from './application/commands/refresh-session/refresh-session.handler.js';
import { RegisterUserHandler } from './application/commands/register-user/register-user.handler.js';
import { UpdateUserRolesHandler } from './application/commands/update-user-roles/update-user-roles.handler.js';
import { UserRegisteredRelay } from './application/event-handlers/user-registered.relay.js';
import { UserRolesChangedAuditHandler } from './application/event-handlers/user-roles-changed-audit.handler.js';
import { SessionsRepository } from './application/persistence/sessions.repository.js';
import { TransactionRunner } from './application/persistence/transaction-runner.js';
import { UsersRepository } from './application/persistence/users.repository.js';
import { GetUserByIdHandler } from './application/queries/get-user-by-id/get-user-by-id.handler.js';
import { GetUsersByIdsHandler } from './application/queries/get-users-by-ids/get-users-by-ids.handler.js';
import { ListUsersHandler } from './application/queries/list-users/list-users.handler.js';
import { SessionTokensService } from './application/services/session-tokens.service.js';
import { DrizzleSessionsRepository } from './infrastructure/persistence/drizzle-sessions.repository.js';
import { DrizzleTransactionRunner } from './infrastructure/persistence/drizzle-transaction.runner.js';
import { DrizzleUsersRepository } from './infrastructure/persistence/drizzle-users.repository.js';
import { PurgeExpiredSessionsCron } from './infrastructure/scheduling/purge-expired-sessions.cron.js';
import { passwordConfig } from './infrastructure/security/password.config.js';
import { PasswordHasher } from './infrastructure/security/password-hasher.service.js';
import { refreshTokenConfig } from './infrastructure/security/refresh-token.config.js';
import { TokenIssuer } from './infrastructure/security/token-issuer.service.js';

export const IDENTITY_COMMAND_HANDLERS = [
  RegisterUserHandler,
  LoginHandler,
  RefreshSessionHandler,
  LogoutHandler,
  UpdateUserRolesHandler,
  PurgeExpiredSessionsHandler,
];

export const IDENTITY_QUERY_HANDLERS = [GetUserByIdHandler, GetUsersByIdsHandler, ListUsersHandler];

export const IDENTITY_EVENT_HANDLERS = [UserRegisteredRelay, UserRolesChangedAuditHandler];

/** Persistence bindings (the only place that knows it is Drizzle/Postgres). */
const PERSISTENCE: Provider[] = [
  { provide: UsersRepository, useClass: DrizzleUsersRepository },
  { provide: SessionsRepository, useClass: DrizzleSessionsRepository },
  { provide: TransactionRunner, useClass: DrizzleTransactionRunner },
];

/**
 * The identity core: CQRS handlers, the Kafka relay, repositories, the session purge cron and
 * identity's security services: `PasswordHasher` (`password` namespace) and `TokenIssuer` (its own
 * `JwtModule`; `auth` + `refreshToken` namespaces).
 * Imported by the monolith (through `IdentityApiModule.forLocal()`) and identity-service
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
    PurgeExpiredSessionsCron,
  ],
})
export class IdentityCoreModule {}
