import { BILLING_GRPC_PACKAGE } from '@domain/billing-contracts';
import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
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
   * client URL (`BILLING_GRPC_URL`) is read when `forRemote()` is called.
   */
  static forRemote(): DynamicModule {
    const target = {
      spec: BILLING_GRPC_PACKAGE,
      // Read when the module is defined: a client target cannot come from DI.
      url: billingGrpcClientConfig.parse().url,
    };
    return {
      module: BillingApiModule,
      imports: [GrpcClientsModule.register(target), RbacModule.forFeature(BILLING_RBAC)],
      ...presentation(BillingGrpcAdapter),
    };
  }
}
