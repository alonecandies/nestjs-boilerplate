import { GraphqlLoadersModule } from '@app/graphql';
import { GrpcClientsModule, type GrpcClientsModuleOptions } from '@app/transport';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { AuthPort } from './application/ports/auth.port.js';
import { UsersPort } from './application/ports/users.port.js';
import { IdentityCoreModule } from './identity-core.module.js';
import { AuthGrpcAdapter } from './infrastructure/adapters/grpc/auth-grpc.adapter.js';
import { IdentityGrpcCaller } from './infrastructure/adapters/grpc/identity-grpc.caller.js';
import { UsersGrpcAdapter } from './infrastructure/adapters/grpc/users-grpc.adapter.js';
import { AuthLocalAdapter } from './infrastructure/adapters/local/auth-local.adapter.js';
import { UsersLocalAdapter } from './infrastructure/adapters/local/users-local.adapter.js';
import { AuthResolver } from './presentation/graphql/auth.resolver.js';
import { UsersResolver } from './presentation/graphql/users.resolver.js';
import { UsersLoaderRegistrar } from './presentation/graphql/users-loader.registrar.js';
import { AuthController } from './presentation/http/auth.controller.js';
import { LocalStrategy } from './presentation/http/strategies/local.strategy.js';
import { UsersController } from './presentation/http/users.controller.js';
import { UserReadCache } from './presentation/shared/user-read.cache.js';

/** Topology-independent presentation: the same classes in the monolith and the gateway. */
const CONTROLLERS = [AuthController, UsersController];
const PRESENTATION: Provider[] = [
  LocalStrategy,
  UserReadCache,
  UsersResolver,
  AuthResolver,
  UsersLoaderRegistrar,
];
const PORT_EXPORTS = [AuthPort, UsersPort];

/**
 * Edge API of the identity context: REST (`/v1/auth`, `/v1/users`), GraphQL (me, user, users,
 * register, login, refreshTokens, updateUserRoles), the passport-local strategy and the `users`
 * DataLoader. Presentation depends only on `AuthPort` / `UsersPort`; the binding decides the
 * topology:
 * - `forLocal()` (monolith): ports → CommandBus/QueryBus, imports `IdentityCoreModule`.
 * - `forRemote()` (gateway): ports → gRPC clients of identity-service (deadline + breaker).
 *
 * Expects the app-level global modules: `AuthModule` (guards, TokenService), `AppCacheModule`
 * (`AppCacheService` for `user:{id}`), `AppThrottlerModule` (`@AuthThrottle`) and
 * `AppGraphqlModule` (only if GraphQL is served — resolvers are inert without it).
 */
@Module({})
export class IdentityApiModule {
  static forLocal(): DynamicModule {
    return {
      module: IdentityApiModule,
      imports: [IdentityCoreModule, GraphqlLoadersModule],
      controllers: CONTROLLERS,
      providers: [
        ...PRESENTATION,
        { provide: AuthPort, useClass: AuthLocalAdapter },
        { provide: UsersPort, useClass: UsersLocalAdapter },
      ],
      exports: PORT_EXPORTS,
    };
  }

  static forRemote(options: GrpcClientsModuleOptions = {}): DynamicModule {
    return {
      module: IdentityApiModule,
      imports: [GrpcClientsModule.register(['identity'], options), GraphqlLoadersModule],
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
