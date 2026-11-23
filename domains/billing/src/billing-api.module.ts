import { BILLING_GRPC_PACKAGE } from '@domain/billing-contracts';
import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RbacModule } from '@platform/auth';
import { GrpcClientsModule } from '@platform/transport';
import { BillingPort } from './application/ports/billing.port.js';
import { BILLING_RBAC } from './billing.permissions.js';
import { BillingGrpcAdapter } from './infrastructure/adapters/grpc/billing-grpc.adapter.js';
import { billingGrpcClientConfig } from './infrastructure/adapters/grpc/billing-grpc-client.config.js';
import { BillingLocalAdapter } from './infrastructure/adapters/local/billing-local.adapter.js';
import { BillingResolver } from './presentation/graphql/billing.resolver.js';
import { BillingController } from './presentation/http/billing.controller.js';

const presentation = (
  adapter: Type<BillingPort>,
): Pick<DynamicModule, 'controllers' | 'providers' | 'exports'> => {
  const port: Provider = { provide: BillingPort, useClass: adapter };
  return {
    controllers: [BillingController],
    providers: [BillingResolver, port],
    exports: [BillingPort],
  };
};

/**
 * The edge API of billing (REST `/v1/billing`, GraphQL `payments` / `createCheckoutSession`).
 * The presentation classes are identical in both topologies; only the `BillingPort` binding differs.
 *
 * App requirements: global auth guards (`AuthModule.forRootAsync()`), `provideCommonEnhancers*()`
 * (both validation pipes + problem+json filter), `AppGraphqlModule.forRootAsync()` and an HTTP app
 * created with `rawBody: true` for the Stripe webhook. `Payment.user` is not billing's: the apps
 * compose it (`PaymentUserFieldResolver`) over identity's `users` DataLoader.
 */
@Module({})
export class BillingApiModule {
  /** Monolith: ports → CQRS buses in-process. The app imports `BillingCoreModule` itself. */
  static forLocal(): DynamicModule {
    return {
      module: BillingApiModule,
      imports: [RbacModule.forFeature(BILLING_RBAC)],
      ...presentation(BillingLocalAdapter),
    };
  }

  /**
   * Gateway: ports → `billing.v1.BillingService` over gRPC (deadline + circuit breaker). The
   * client URL (`BILLING_GRPC_URL`) and the deadline of the Stripe-backed calls
   * (`BILLING_GRPC_STRIPE_DEADLINE_MS`, also the channel's service-config deadline, so grpc-js does
   * not end a checkout at `GRPC_DEADLINE_MS`) are read when `forRemote()` is called. The adapter
   * still cuts `ListPayments` at `GRPC_DEADLINE_MS`.
   */
  static forRemote(): DynamicModule {
    // Read when the module is defined: a client target cannot come from DI.
    const client = billingGrpcClientConfig.parse();
    const grpc = GrpcClientsModule.register(
      { spec: BILLING_GRPC_PACKAGE, url: client.url },
      { client: { deadlineMs: client.stripeDeadlineMs } },
    );
    return {
      module: BillingApiModule,
      imports: [
        grpc,
        ConfigModule.forFeature(billingGrpcClientConfig),
        RbacModule.forFeature(BILLING_RBAC),
      ],
      ...presentation(BillingGrpcAdapter),
    };
  }
}
