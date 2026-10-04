import { BillingGrpcModule, billingSchema } from '@app/billing';
import { CorrelationIdMiddleware, provideCommonEnhancersAsync } from '@app/common';
import { type AppConfig, AppConfigModule, appConfig, grpcConfig } from '@app/config';
import { DatabaseHealthIndicator, DatabaseModule } from '@app/database';
import { ObservabilityModule } from '@app/observability';
import { StripeModule } from '@app/payments';
import { RedisHealthIndicator, RedisModule } from '@app/redis';
import { KafkaHealthIndicator, KafkaProducerModule } from '@app/transport';
import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';

/**
 * billing-service: `billing.v1.BillingService` over gRPC (served by `connectGrpcServer` in
 * main.ts) — Stripe Checkout sessions, signature-verified idempotent webhooks (the gateway forwards
 * the raw bytes + `Stripe-Signature`), the payments ledger in Postgres — producing
 * `billing.payment-succeeded.v1`. The HTTP port only serves `/health/*` and `/metrics`.
 */
@Module({
  imports: [
    AppConfigModule.forRoot(),
    // The gRPC server namespace (GRPC_URL, message limits) read by `connectGrpcServer` in main.ts:
    // validated at boot like every other namespace, and resolvable from the app container.
    ConfigModule.forFeature(grpcConfig),
    ObservabilityModule.forRoot({
      healthContributors: [DatabaseHealthIndicator, RedisHealthIndicator, KafkaHealthIndicator],
    }),
    CqrsModule.forRoot(),
    // Migrations run at boot when DATABASE_RUN_MIGRATIONS=true (advisory-locked). Also provides
    // the transactional CLS plugin behind the webhook handler's @Transactional().
    DatabaseModule.forRootAsync({ schema: billingSchema }),
    RedisModule.forRootAsync(),
    KafkaProducerModule.forRootAsync(),
    // The Stripe client (secret key, retries, timeout) + webhook signature verification.
    StripeModule.forRootAsync(),
    BillingGrpcModule,
  ],
  providers: [
    // With `inheritAppConfig: true` these APP_* enhancers also wrap the gRPC handlers; each of
    // them branches on the context type (the gRPC error mapping is controller-scoped).
    ...provideCommonEnhancersAsync({
      inject: [appConfig.KEY],
      useFactory: (app: AppConfig) => ({ exposeInternalErrors: !app.isProduction }),
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
