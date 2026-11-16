import { IDENTITY_GRPC_PACKAGE } from '@domain/identity-contracts';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { RbacModule } from '@platform/auth';
import { GraphqlLoadersModule } from '@platform/graphql';
import { GrpcClientsModule, type GrpcClientsModuleOptions } from '@platform/transport';
import { AuthPort } from './application/ports/auth.port.js';
import { MembersPort } from './application/ports/members.port.js';
import { TenantsPort } from './application/ports/tenants.port.js';
import { UsersPort } from './application/ports/users.port.js';
import { IDENTITY_RBAC } from './identity.permissions.js';
import { AuthGrpcAdapter } from './infrastructure/adapters/grpc/auth-grpc.adapter.js';
import { IdentityGrpcCaller } from './infrastructure/adapters/grpc/identity-grpc.caller.js';
import { identityGrpcClientConfig } from './infrastructure/adapters/grpc/identity-grpc-client.config.js';
import { UsersGrpcAdapter } from './infrastructure/adapters/grpc/users-grpc.adapter.js';
import { AuthLocalAdapter } from './infrastructure/adapters/local/auth-local.adapter.js';
import { MembersLocalAdapter } from './infrastructure/adapters/local/members-local.adapter.js';
import { TenantsLocalAdapter } from './infrastructure/adapters/local/tenants-local.adapter.js';
import { UsersLocalAdapter } from './infrastructure/adapters/local/users-local.adapter.js';
import { AuthResolver } from './presentation/graphql/auth.resolver.js';
import { UsersResolver } from './presentation/graphql/users.resolver.js';
import { UsersLoaderRegistrar } from './presentation/graphql/users-loader.registrar.js';
import { AuthController } from './presentation/http/auth.controller.js';
import { MembersController } from './presentation/http/members.controller.js';
import { StaffController } from './presentation/http/staff.controller.js';
import { LocalStrategy } from './presentation/http/strategies/local.strategy.js';
import { TenantsController } from './presentation/http/tenants.controller.js';
import { UsersController } from './presentation/http/users.controller.js';
import { IdentityRateLimitModule } from './presentation/rate-limit/identity-rate-limit.js';
import { UserReadCache } from './presentation/shared/user-read.cache.js';

/** Topology-independent presentation: the same classes in the monolith and the gateway. */
const CONTROLLERS = [AuthController, UsersController, StaffController];
const PRESENTATION: Provider[] = [
  LocalStrategy,
  UserReadCache,
  UsersResolver,
  AuthResolver,
  UsersLoaderRegistrar,
];
const PORT_EXPORTS = [AuthPort, UsersPort];
/** Tenancy endpoints: local-only until the gRPC adapter exists (`forRemote()` gains them in Task 11). */
const TENANCY_CONTROLLERS = [TenantsController, MembersController];

/**
 * Edge API of the identity context: REST (`/v1/auth`, `/v1/users`), GraphQL (me, user, users,
 * register, login, refreshTokens), the passport-local strategy and the `users`
 * DataLoader. Presentation depends only on `AuthPort` / `UsersPort`; the binding decides the
 * topology:
 * - `forLocal()` (monolith): ports → CommandBus/QueryBus. The app imports `IdentityCoreModule` itself
 *   (from `@domain/identity`): this module is part of `@domain/identity/api`, which never reaches core code.
 * - `forRemote()` (gateway): ports → gRPC clients of identity-service (deadline + breaker). The
 *   client URL (`IDENTITY_GRPC_URL`) is read when `forRemote()` is called.
 *
 * Expects the app-level global modules: `AuthModule` (guards, TokenService), `AppCacheModule`
 * (`AppCacheService` for `user:{id}`), `AppThrottlerModule` (`@RateLimit` policies) and
 * `AppGraphqlModule` (only if GraphQL is served — resolvers are inert without it).
 */
@Module({})
export class IdentityApiModule {
  static forLocal(): DynamicModule {
    return {
      module: IdentityApiModule,
      imports: [
        GraphqlLoadersModule,
        IdentityRateLimitModule,
        RbacModule.forFeature(IDENTITY_RBAC),
      ],
      controllers: [...CONTROLLERS, ...TENANCY_CONTROLLERS],
      providers: [
        ...PRESENTATION,
        { provide: AuthPort, useClass: AuthLocalAdapter },
        { provide: UsersPort, useClass: UsersLocalAdapter },
        { provide: TenantsPort, useClass: TenantsLocalAdapter },
        { provide: MembersPort, useClass: MembersLocalAdapter },
      ],
      exports: [...PORT_EXPORTS, TenantsPort, MembersPort],
    };
  }

  static forRemote(options: GrpcClientsModuleOptions = {}): DynamicModule {
    const target = {
      spec: IDENTITY_GRPC_PACKAGE,
      // Read when the module is defined: a client target cannot come from DI.
      url: identityGrpcClientConfig.parse().url,
    };
    return {
      module: IdentityApiModule,
      imports: [
        GrpcClientsModule.register(target, options),
        GraphqlLoadersModule,
        IdentityRateLimitModule,
        RbacModule.forFeature(IDENTITY_RBAC),
      ],
      controllers: CONTROLLERS,
      providers: [
        ...PRESENTATION,
        IdentityGrpcCaller,
        { provide: AuthPort, useClass: AuthGrpcAdapter },
        { provide: UsersPort, useClass: UsersGrpcAdapter },
      ],
      exports: PORT_EXPORTS,
    };
  }
}
