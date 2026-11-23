import type { ListPaymentsRequest, PaymentList } from '@domain/billing-contracts';
import type { User } from '@domain/identity-contracts';
import type { ListNotificationsRequest, NotificationPage } from '@domain/notifications-contracts';

/**
 * What the chat tools read: a slice of the owning domains' existing ports, bound by the
 * composition root to `UsersPort.getUser`, `NotificationsPort.list` and `BillingPort.listPayments`
 * (ai depends on their contracts only, like `Payment.user`). Every call runs in the request's CLS
 * context, i.e. as the caller's principal, and the owners' own checks apply (runtime pool under
 * RLS, inbox actor, own payments): never a system context.
 *
 * Optional in `AiCoreModule`: without a binding the model is offered no tools.
 */
export abstract class AiToolSources {
  /** `UsersPort.getUser(id)` with no tenant scope: the caller's own row (row-local RLS). */
  abstract getUser(id: string): Promise<User>;

  /** `NotificationsPort.list`: the (tenant, user) inbox, which must be the caller's. */
  abstract listNotifications(input: ListNotificationsRequest): Promise<NotificationPage>;

  /** `BillingPort.listPayments` with `userId` set: the caller's own payments in the tenant. */
  abstract listPayments(input: ListPaymentsRequest): Promise<PaymentList>;
}

/**
 * The owners' ports as the tools read them, typed structurally: ai imports no other domain, so the
 * composition root passes in the real `UsersPort`, `NotificationsPort` and `BillingPort` and `tsc`
 * checks each against the slice below.
 */
export interface AiToolOwnerPorts {
  readonly users: { getUser(id: string): Promise<User> };
  readonly notifications: { list(input: ListNotificationsRequest): Promise<NotificationPage> };
  readonly billing: { listPayments(input: ListPaymentsRequest): Promise<PaymentList> };
}

/**
 * `AiToolSources` over the owners' ports: three one-line delegations, shared by the monolith (the
 * in-process adapters) and ai-service (the gRPC adapters). Each call runs in the request's CLS
 * context, as the caller; the owners' own checks apply.
 *
 * Not `@Injectable`: the parameter types are structural, which Nest cannot inject by type. Each app
 * builds it with a `useFactory` provider, `inject: [UsersPort, NotificationsPort, BillingPort]`.
 */
export class OwnerPortsAiToolSources extends AiToolSources {
  constructor(
    private readonly users: AiToolOwnerPorts['users'],
    private readonly notifications: AiToolOwnerPorts['notifications'],
    private readonly billing: AiToolOwnerPorts['billing'],
  ) {
    super();
  }

  override getUser(id: string): Promise<User> {
    return this.users.getUser(id);
  }

  override listNotifications(input: ListNotificationsRequest): Promise<NotificationPage> {
    return this.notifications.list(input);
  }

  override listPayments(input: ListPaymentsRequest): Promise<PaymentList> {
    return this.billing.listPayments(input);
  }
}
