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
