import { AccessTokenDenylist, TokenService } from '@app/auth';
import { type AppConfig, appConfig, type GraphqlConfig, graphqlConfig } from '@app/config';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { type DynamicModule, Module, type ModuleMetadata } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { type BuildSchemaOptions, GraphQLModule } from '@nestjs/graphql';
import { createApolloDriverConfig } from './apollo-config.factory.js';
import {
  createGraphqlWsAuthHandlers,
  createSubscriptionAuthenticator,
} from './auth/subscription-auth.js';
import { DataLoaderRegistry } from './loaders/data-loader.registry.js';
import { GraphqlLoadersModule } from './loaders/graphql-loaders.module.js';
import { ComplexityPlugin } from './plugins/complexity.plugin.js';
import { ErrorRequestIdPlugin } from './plugins/error-request-id.plugin.js';

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
 */
@Module({})
export class AppGraphqlModule {
  static forRootAsync(options: AppGraphqlModuleOptions = {}): DynamicModule {
    return {
      module: AppGraphqlModule,
      global: true,
      imports: [
        ConfigModule.forFeature(graphqlConfig),
        GraphqlLoadersModule,
        GraphQLModule.forRootAsync<ApolloDriverConfig>({
          driver: ApolloDriver,
          imports: [
            ConfigModule.forFeature(graphqlConfig),
            GraphqlLoadersModule,
            ...(options.imports ?? []),
          ],
          inject: [
            graphqlConfig.KEY,
            appConfig.KEY,
            DataLoaderRegistry,
            TokenService,
            AccessTokenDenylist,
          ],
          useFactory: (
            graphql: GraphqlConfig,
            app: AppConfig,
            loaders: DataLoaderRegistry,
            tokens: TokenService,
            denylist: AccessTokenDenylist,
          ): ApolloDriverConfig =>
            createApolloDriverConfig({
              graphql,
              app,
              loaders,
              wsAuth: createGraphqlWsAuthHandlers(
                createSubscriptionAuthenticator(tokens, denylist),
                {
                  requireAuth: options.requireSubscriptionAuth ?? true,
                },
              ),
              buildSchemaOptions: options.buildSchemaOptions,
            }),
        }),
      ],
      providers: [ComplexityPlugin, ErrorRequestIdPlugin],
      exports: [GraphqlLoadersModule],
    };
  }
}
