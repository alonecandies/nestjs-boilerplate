import { AiToolSources } from '@domain/ai';
import { BillingPort } from '@domain/billing';
import { UsersPort } from '@domain/identity';
import { NotificationsPort } from '@domain/notifications';
import { type DynamicModule, Injectable, Module } from '@nestjs/common';

type Sources = AiToolSources;

/**
 * The ai chat tools' reads, composed here from the owners' existing ports so that ai imports no
 * other domain (like `Payment.user`). Each call runs in the request's context, as the caller.
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
 * Binds `AiToolSources` globally (read by `AiCoreModule`'s `AiChatTools`). `ports` are the very
 * `IdentityApiModule.forLocal()`, `NotificationsApiModule.forLocal()` and
 * `BillingApiModule.forLocal()` objects the app imports: Nest keys a dynamic module by reference,
 * so importing the same objects here reuses those modules (no second set of controllers).
 */
@Module({})
export class AiToolSourcesModule {
  static forRoot(ports: readonly DynamicModule[]): DynamicModule {
    return {
      module: AiToolSourcesModule,
      global: true,
      imports: [...ports],
      providers: [{ provide: AiToolSources, useClass: PortsAiToolSources }],
      exports: [AiToolSources],
    };
  }
}
