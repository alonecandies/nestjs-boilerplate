import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { type DynamicModule, Module, type ModuleMetadata } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { type BuildSchemaOptions, GraphQLModule } from '@nestjs/graphql';
import { AccessTokenDenylist, type RevocationSweeper, TokenService } from '@platform/auth';
import { createMaintenanceModeReader } from '@platform/common';
import {
  type AppConfig,
  appConfig,
  type GraphqlConfig,
  graphqlConfig,
  throttleConfig,
} from '@platform/config';
import { ConnectionCaps, createClientIpResolver } from '@platform/redis';
import { createApolloDriverConfig } from './apollo-config.factory.js';
import {
  GRAPHQL_WS_REVOCATION_SWEEPER,
  GraphqlWsRevocationModule,
} from './auth/graphql-ws-revocation.module.js';
import {
  createGraphqlWsAuthHandlers,
  createSubscriptionAuthenticator,
} from './auth/subscription-auth.js';
import { DataLoaderRegistry } from './loaders/data-loader.registry.js';
import { GraphqlLoadersModule } from './loaders/graphql-loaders.module.js';
import { ComplexityPlugin } from './plugins/complexity.plugin.js';
import { ErrorRequestIdPlugin } from './plugins/error-request-id.plugin.js';
import { OperationRateLimitPlugin } from './plugins/operation-rate-limit.plugin.js';
import { SandboxCspHook } from './sandbox/sandbox-csp.hook.js';
import {
  SubscriptionGuardBinder,
  SubscriptionGuardRef,
} from './subscriptions/subscription-guard.js';

export interface AppGraphqlModuleOptions {
  /** Extra modules the Apollo factory needs (rare: auth/config/loaders are already wired). */
  imports?: ModuleMetadata['imports'];
  /**
   * Refuse graphql-ws connections that carry no token. Default `true`: every subscription needs a
   * user, and an anonymous socket would hold memory with no expiry timer and no rate limit. Set
   * `false` only to serve public subscriptions: anonymous sockets are then accepted and each
   * subscription's guards decide. Invalid tokens are always refused.
   */
  requireSubscriptionAuth?: boolean;
  /** Merged into `buildSchemaOptions` (`dateScalarMode: 'isoDate'` by default). */
  buildSchemaOptions?: BuildSchemaOptions;
}

/**
 * Code-first Apollo Server 5 on Fastify: queries, mutations and graphql-ws subscriptions on
 * `GRAPHQL_PATH`, with complexity limiting, per-operation DataLoaders, the platform error format
 * and a request id on every error.
 *
 * It needs `AppConfigModule` and `AuthModule.forRootAsync()` (global `TokenService` /
 * `AccessTokenDenylist`) in the app. Resolvers are ordinary providers in any module.
 *
 * graphql-ws sockets are tracked by their token's `jti`; one `RevocationSweeper` (`graphql-ws`)
 * closes those whose token was revoked (4401 `Access token revoked`): at once on the denylist's
 * revocation announcement, else at its next sweep (every `WS_REVOCATION_SWEEP_INTERVAL_MS`). It
 * starts on application bootstrap and stops on shutdown.
 *
 * Maintenance: graphql-ws reads the app's `MAINTENANCE_MODE` switch (provided in the root module by
 * `provideCommonEnhancers*`) at run time, like the HTTP middleware; an app without one reads off.
 */
@Module({})
export class AppGraphqlModule {
  static forRootAsync(options: AppGraphqlModuleOptions = {}): DynamicModule {
    // Filled by SubscriptionGuardBinder once the schema exists (graphql-ws bypasses Apollo plugins).
    const subscriptionGuard = new SubscriptionGuardRef();
    return {
      module: AppGraphqlModule,
      global: true,
      imports: [
        ConfigModule.forFeature(graphqlConfig),
        ConfigModule.forFeature(throttleConfig),
        GraphqlLoadersModule,
        GraphQLModule.forRootAsync<ApolloDriverConfig>({
          driver: ApolloDriver,
          imports: [
            ConfigModule.forFeature(graphqlConfig),
            GraphqlLoadersModule,
            GraphqlWsRevocationModule,
            ...(options.imports ?? []),
          ],
          inject: [
            graphqlConfig.KEY,
            appConfig.KEY,
            DataLoaderRegistry,
            TokenService,
            AccessTokenDenylist,
            GRAPHQL_WS_REVOCATION_SWEEPER,
            { token: ConnectionCaps, optional: true },
            ModuleRef,
          ],
          useFactory: (
            graphql: GraphqlConfig,
            app: AppConfig,
            loaders: DataLoaderRegistry,
            tokens: TokenService,
            denylist: AccessTokenDenylist,
            sweeper: RevocationSweeper,
            caps: ConnectionCaps | undefined,
            moduleRef: ModuleRef,
          ): ApolloDriverConfig =>
            createApolloDriverConfig({
              graphql,
              app,
              loaders,
              wsAuth: createGraphqlWsAuthHandlers(
                createSubscriptionAuthenticator(tokens, denylist),
                {
                  requireAuth: options.requireSubscriptionAuth ?? true,
                  sweeper,
                  ...(caps ? { caps } : {}),
                  clientIp: createClientIpResolver(app.trustProxy),
                },
              ),
              buildSchemaOptions: options.buildSchemaOptions,
              subscriptionGuard,
              // The app's `MAINTENANCE_MODE` switch (root module), read at run time and not at
              // boot, so a function switch is followed as the HTTP middleware follows it.
              maintenanceMode: createMaintenanceModeReader(moduleRef),
            }),
        }),
      ],
      providers: [
        ComplexityPlugin,
        OperationRateLimitPlugin,
        ErrorRequestIdPlugin,
        SandboxCspHook,
        { provide: SubscriptionGuardRef, useValue: subscriptionGuard },
        SubscriptionGuardBinder,
      ],
      exports: [GraphqlLoadersModule],
    };
  }
}
