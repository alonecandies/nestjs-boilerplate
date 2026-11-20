import { AiToolSources } from '@domain/ai';
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
import { type DynamicModule, Injectable, Module } from '@nestjs/common';
import { RbacModule } from '@platform/auth';
import { GrpcClientsModule } from '@platform/transport';

type Sources = AiToolSources;

/**
 * The ai chat tools' reads in ai-service, composed from the owners' ports bound to their gRPC
 * adapters (identity-, notifications- and billing-service), so that ai imports no other domain.
 * Each call runs in the turn's CLS context: the caller's principal (adopted from the gateway's
 * metadata) travels on to the owning service, which applies its own checks.
 */
@Injectable()
export class PortsAiToolSources extends AiToolSources {
  constructor(
    private readonly users: UsersPort,
    private readonly notifications: NotificationsPort,
    private readonly billing: BillingPort,
  ) {
    super();
  }

  override getUser(id: string): ReturnType<Sources['getUser']> {
    return this.users.getUser(id);
  }

  override listNotifications(
    input: Parameters<Sources['listNotifications']>[0],
  ): ReturnType<Sources['listNotifications']> {
    return this.notifications.list(input);
  }

  override listPayments(
    input: Parameters<Sources['listPayments']>[0],
  ): ReturnType<Sources['listPayments']> {
    return this.billing.listPayments(input);
  }
}

/**
 * Binds `AiToolSources` globally (read by `AiCoreModule`'s `AiChatTools`) over gRPC clients of the
 * three owners: ports only, no controller or resolver of theirs is served here. The targets
 * (`IDENTITY_GRPC_URL`, `NOTIFICATIONS_GRPC_URL`, `BILLING_GRPC_URL`) are read when `forRoot()` is
 * called; channels connect on the first tool call. `NOTIFICATIONS_RBAC` makes `notifications:read`
 * (the inbox tool's permission) resolvable from the caller's roles in this process.
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
        RbacModule.forFeature(NOTIFICATIONS_RBAC),
      ],
      providers: [
        IdentityGrpcCaller,
        { provide: UsersPort, useClass: UsersGrpcAdapter },
        { provide: NotificationsPort, useClass: NotificationsGrpcAdapter },
        { provide: BillingPort, useClass: BillingGrpcAdapter },
        { provide: AiToolSources, useClass: PortsAiToolSources },
      ],
      exports: [AiToolSources],
    };
  }
}
