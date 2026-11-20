import { AiGrpcModule, aiSchema } from '@domain/ai';
import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { RbacModule } from '@platform/auth';
import { CorrelationIdMiddleware, provideCommonEnhancersAsync } from '@platform/common';
import { type AppConfig, AppConfigModule, appConfig, grpcConfig } from '@platform/config';
import { DatabaseHealthIndicator, DatabaseModule } from '@platform/database';
import { ObservabilityModule } from '@platform/observability';
import { DATABASE_MIGRATIONS } from './database.migrations.js';
import { AiToolSourcesModule } from './tools/ai-tool-sources.module.js';

/**
 * ai-service: `ai.v1.AiService` over gRPC (served by `connectGrpcServer` in main.ts) — the caller's
 * conversations and the chat turn, plain or server-streamed, over `@platform/ai` (OpenRouter; off
 * while `AI_ENABLED=false`, when every turn answers `AI_DISABLED`), with ai's tables in Postgres
 * under RLS. The HTTP port only serves `/health/*` (`/metrics` is on `METRICS_PORT`).
 *
 * The edge (REST, SSE, GraphQL, `ai:chat`, the `ai.chat` rate limit) is the gateway's
 * (`AiApiModule.forRemote()`); this service trusts the principal in the call metadata and the
 * handlers re-check tenant and user against it. The model's read-only tools call identity-,
 * notifications- and billing-service as the caller (`AiToolSourcesModule`). No Kafka, no Redis.
 */
@Module({
  imports: [
    AppConfigModule.forRoot(),
    // The gRPC server namespace (GRPC_URL, message limits) read by `connectGrpcServer` in main.ts:
    // validated at boot like every other namespace, and resolvable from the app container.
    ConfigModule.forFeature(grpcConfig),
    // Readiness = Postgres. OpenRouter is not a contributor: a model outage fails the chat turns
    // (502/504), it must not pull every replica out of rotation (nor must AI_ENABLED=false).
    ObservabilityModule.forRoot({ healthContributors: [DatabaseHealthIndicator] }),
    CqrsModule.forRoot(),
    // The RBAC registry: services recompute permissions from the roles in gRPC metadata (B2-23).
    RbacModule.forRoot(),
    // The platform set, then ai's history (DATABASE_MIGRATIONS, shared with migrate.ts), at boot
    // when DATABASE_RUN_MIGRATIONS=true (advisory-locked). Also provides the transactional CLS
    // plugin behind the handlers' units of work.
    DatabaseModule.forRootAsync({ schema: aiSchema, migrations: DATABASE_MIGRATIONS }),
    // The core (handlers, repositories, the model client) + ai.v1.AiService.
    AiGrpcModule,
    // The chat tools' sources: UsersPort, NotificationsPort and BillingPort over gRPC.
    AiToolSourcesModule.forRoot(),
  ],
  providers: [
    // With `inheritAppConfig: true` these APP_* enhancers also wrap the gRPC handlers; each of
    // them branches on the context type (the gRPC error mapping is controller-scoped).
    ...provideCommonEnhancersAsync({
      inject: [appConfig.KEY],
      useFactory: (app: AppConfig) => ({
        exposeInternalErrors: !app.isProduction,
        defaultTimeoutMs: app.handlerTimeoutMs,
      }),
    }),
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
