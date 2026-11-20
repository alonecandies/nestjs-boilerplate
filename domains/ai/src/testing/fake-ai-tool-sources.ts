import type { ListPaymentsRequest, Payment, PaymentList } from '@domain/billing-contracts';
import type { User } from '@domain/identity-contracts';
import type {
  ListNotificationsRequest,
  Notification,
  NotificationPage,
} from '@domain/notifications-contracts';
import {
  EntityNotFoundException,
  generateId,
  getPrincipal,
  PermissionDeniedException,
  type Principal,
  requirePrincipal,
} from '@platform/common';
import { AiToolSources } from '../application/tools/ai-tool-sources.js';

interface Owner {
  readonly tenantId: string;
  readonly userId: string;
}

/** One call a spec can assert on: the method, its input, and the principal it ran under. */
export interface FakeAiToolSourcesCall {
  readonly method: 'getUser' | 'listNotifications' | 'listPayments';
  readonly input: unknown;
  readonly principal: Principal | undefined;
}

const AT = new Date('2026-11-20T10:00:00.000Z');

/**
 * `AiToolSources` in memory, with the owners' own checks: `getUser` finds only the principal's
 * own row (the runtime pool under row-local RLS), `listNotifications` only the principal's inbox
 * (inbox actor, 403 otherwise) and `listPayments` only the principal's payments with `userId`
 * set. Records every call with the principal it ran under; `failWith` makes every call throw.
 */
export class FakeAiToolSources extends AiToolSources {
  readonly calls: FakeAiToolSourcesCall[] = [];
  private readonly users = new Map<string, User>();
  private readonly notifications: Notification[] = [];
  private readonly payments: Payment[] = [];
  private failure: Error | undefined;

  addUser(owner: Owner, fields: Partial<User> = {}): User {
    const user: User = {
      id: owner.userId,
      email: `${owner.userId}@example.com`,
      displayName: 'User',
      roles: [],
      createdAt: AT,
      updatedAt: AT,
      ...fields,
    };
    this.users.set(user.id, user);
    return user;
  }

  addNotification(owner: Owner, fields: Partial<Notification> = {}): Notification {
    const notification: Notification = {
      id: generateId(),
      type: 'system',
      title: 'Notice',
      body: '',
      read: false,
      data: {},
      createdAt: AT,
      ...owner,
      ...fields,
    };
    this.notifications.unshift(notification);
    return notification;
  }

  addPayment(owner: Owner, fields: Partial<Payment> = {}): Payment {
    const payment: Payment = {
      id: generateId(),
      status: 'succeeded',
      amountTotal: '1000',
      currency: 'usd',
      priceId: 'price_test',
      quantity: 1,
      stripeCheckoutSessionId: 'cs_test',
      createdAt: AT,
      updatedAt: AT,
      ...owner,
      ...fields,
    };
    this.payments.unshift(payment);
    return payment;
  }

  /** Every later call throws `error`. */
  failWith(error: Error): void {
    this.failure = error;
  }

  override async getUser(id: string): Promise<User> {
    const principal = this.record('getUser', id);
    const user = principal.userId === id ? this.users.get(id) : undefined;
    if (user === undefined) throw new EntityNotFoundException('User', id);
    return user;
  }

  override async listNotifications(input: ListNotificationsRequest): Promise<NotificationPage> {
    const principal = this.record('listNotifications', input);
    if (principal.tenantId !== input.tenantId || principal.userId !== input.userId) {
      throw new PermissionDeniedException('Not your inbox', { code: 'TENANT_MISMATCH' });
    }
    const own = this.notifications.filter(
      (n) => n.tenantId === input.tenantId && n.userId === input.userId,
    );
    return {
      items: own.slice(0, input.limit),
      ...(own.length > input.limit ? { nextPageState: 'more' } : {}),
    };
  }

  override async listPayments(input: ListPaymentsRequest): Promise<PaymentList> {
    const principal = this.record('listPayments', input);
    if (principal.tenantId !== input.tenantId || principal.userId !== input.userId) {
      throw new PermissionDeniedException('Not your payments');
    }
    const own = this.payments.filter(
      (p) => p.tenantId === input.tenantId && p.userId === input.userId,
    );
    return {
      items: own.slice(0, input.limit),
      ...(own.length > input.limit ? { nextCursor: 'more' } : {}),
    };
  }

  private record(method: FakeAiToolSourcesCall['method'], input: unknown): Principal {
    this.calls.push({ method, input, principal: getPrincipal() });
    if (this.failure !== undefined) throw this.failure;
    return requirePrincipal();
  }
}
