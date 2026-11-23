import { AiToolSources, OwnerPortsAiToolSources } from '@domain/ai';
import { BillingGrpcAdapter, BillingPort, billingGrpcClientConfig } from '@domain/billing/api';
import { BILLING_GRPC_PACKAGE } from '@domain/billing-contracts';
import {
  IdentityGrpcCaller,
  identityGrpcClientConfig,
  UsersGrpcAdapter,
  UsersPort,
} from '@domain/identity/api';
import { IDENTITY_GRPC_PACKAGE } from '@domain/identity-contracts';
import {
  NOTIFICATIONS_RBAC,
  NotificationsGrpcAdapter,
  NotificationsPort,
  notificationsGrpcClientConfig,
} from '@domain/notifications/api';
import { NOTIFICATIONS_GRPC_PACKAGE } from '@domain/notifications-contracts';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RbacModule } from '@platform/auth';
import { GrpcClientsModule } from '@platform/transport';

/**
 * Binds `AiToolSources` globally (read by `AiCoreModule`'s `AiChatTools`) to ai's
 * `OwnerPortsAiToolSources` over the owners' ports bound to their gRPC adapters (identity-,
 * notifications- and billing-service), so that ai imports no other domain. Each call runs in the
 * turn's CLS context: the caller's principal (adopted from the gateway's metadata) travels on to
 * the owning service, which applies its own checks. Ports only: no controller or resolver of the
 * owners is served here. The targets (`IDENTITY_GRPC_URL`, `NOTIFICATIONS_GRPC_URL`,
 * `BILLING_GRPC_URL`) are read when `forRoot()` is called; channels connect on the first tool
 * call. `NOTIFICATIONS_RBAC` makes `notifications:read` (the inbox tool's permission) resolvable
 * from the caller's roles in this process. The billing tool only lists payments, so the billing
 * channel keeps `GRPC_DEADLINE_MS`; `billingGrpcClient` is loaded because `BillingGrpcAdapter`
 * injects it (the Stripe-backed calls' deadline, unused here).
 */
@Module({})
export class AiToolSourcesModule {
  static forRoot(): DynamicModule {
    return {
      module: AiToolSourcesModule,
      global: true,
      imports: [
        GrpcClientsModule.register({
          spec: IDENTITY_GRPC_PACKAGE,
          url: identityGrpcClientConfig.parse().url,
        }),
        GrpcClientsModule.register({
          spec: NOTIFICATIONS_GRPC_PACKAGE,
          url: notificationsGrpcClientConfig.parse().url,
        }),
        GrpcClientsModule.register({
          spec: BILLING_GRPC_PACKAGE,
          url: billingGrpcClientConfig.parse().url,
        }),
        ConfigModule.forFeature(billingGrpcClientConfig),
        RbacModule.forFeature(NOTIFICATIONS_RBAC),
      ],
      providers: [
        IdentityGrpcCaller,
        { provide: UsersPort, useClass: UsersGrpcAdapter },
        { provide: NotificationsPort, useClass: NotificationsGrpcAdapter },
        { provide: BillingPort, useClass: BillingGrpcAdapter },
        {
          provide: AiToolSources,
          useFactory: (users: UsersPort, notifications: NotificationsPort, billing: BillingPort) =>
            new OwnerPortsAiToolSources(users, notifications, billing),
          inject: [UsersPort, NotificationsPort, BillingPort],
        },
      ],
      exports: [AiToolSources],
    };
  }
}
