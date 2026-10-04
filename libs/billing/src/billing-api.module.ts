import { GrpcClientsModule } from '@app/transport';
import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { BillingPort } from './application/ports/billing.port.js';
import { BillingCoreModule } from './billing-core.module.js';
import { BillingGrpcAdapter } from './infrastructure/adapters/grpc/billing-grpc.adapter.js';
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
 * (both validation pipes + problem+json filter), `AppGraphqlModule.forRootAsync()` plus identity's
 * API module (it registers the `users` DataLoader behind `Payment.user`), and an HTTP app created
 * with `rawBody: true` for the Stripe webhook.
 */
@Module({})
export class BillingApiModule {
  /** Monolith: ports → CQRS buses in-process (imports `BillingCoreModule`). */
  static forLocal(): DynamicModule {
    return {
      module: BillingApiModule,
      imports: [BillingCoreModule],
      ...presentation(BillingLocalAdapter),
    };
  }

  /** Gateway: ports → `billing.v1.BillingService` over gRPC (deadline + circuit breaker). */
  static forRemote(): DynamicModule {
    return {
      module: BillingApiModule,
      imports: [GrpcClientsModule.register(['billing'])],
      ...presentation(BillingGrpcAdapter),
    };
  }
}
