import { AiToolSources, OwnerPortsAiToolSources } from '@domain/ai';
import { BillingPort } from '@domain/billing';
import { UsersPort } from '@domain/identity';
import { NotificationsPort } from '@domain/notifications';
import { type DynamicModule, Module } from '@nestjs/common';

/**
 * Binds `AiToolSources` globally (read by `AiCoreModule`'s `AiChatTools`) to ai's
 * `OwnerPortsAiToolSources` over the owners' ports, so that ai imports no other domain (like
 * `Payment.user`); each call runs in the request's context, as the caller. `ports` are the very
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
      providers: [
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
