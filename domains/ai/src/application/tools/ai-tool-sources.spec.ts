import type { ListPaymentsRequest, PaymentList } from '@domain/billing-contracts';
import type { User } from '@domain/identity-contracts';
import type { ListNotificationsRequest, NotificationPage } from '@domain/notifications-contracts';
import { describe, expect, it, vi } from 'vitest';
import { AiToolSources, OwnerPortsAiToolSources } from './ai-tool-sources.js';

const TENANT = '0198f0a0-0000-7000-8000-000000000001';
const USER_ID = '0198f0a0-0000-7000-8000-0000000000a1';

function setup() {
  const user = { id: USER_ID } as User;
  const notifications = { items: [], nextCursor: null } as unknown as NotificationPage;
  const payments = { items: [], nextCursor: null } as unknown as PaymentList;
  const owners = {
    users: { getUser: vi.fn((_id: string) => Promise.resolve(user)) },
    notifications: {
      list: vi.fn((_input: ListNotificationsRequest) => Promise.resolve(notifications)),
    },
    billing: { listPayments: vi.fn((_input: ListPaymentsRequest) => Promise.resolve(payments)) },
  };
  const sources = new OwnerPortsAiToolSources(owners.users, owners.notifications, owners.billing);
  return { sources, owners, user, notifications, payments };
}

describe('OwnerPortsAiToolSources', () => {
  it('is an AiToolSources', () => {
    expect(setup().sources).toBeInstanceOf(AiToolSources);
  });

  it('getUser passes the id to UsersPort.getUser and returns its promise', async () => {
    const { sources, owners, user } = setup();
    const pending = Promise.resolve(user);
    owners.users.getUser.mockReturnValueOnce(pending);

    const result = sources.getUser(USER_ID);

    expect(result).toBe(pending);
    expect(owners.users.getUser).toHaveBeenCalledExactlyOnceWith(USER_ID);
    await expect(result).resolves.toBe(user);
  });

  it('listNotifications passes the input through to NotificationsPort.list', async () => {
    const { sources, owners, notifications } = setup();
    const input = { tenantId: TENANT, userId: USER_ID, limit: 5 } as ListNotificationsRequest;
    const pending = Promise.resolve(notifications);
    owners.notifications.list.mockReturnValueOnce(pending);

    const result = sources.listNotifications(input);

    expect(result).toBe(pending);
    expect(owners.notifications.list).toHaveBeenCalledExactlyOnceWith(input);
    expect(owners.notifications.list.mock.calls[0]?.[0]).toBe(input);
  });

  it('listPayments passes the input through to BillingPort.listPayments', async () => {
    const { sources, owners, payments } = setup();
    const input = { tenantId: TENANT, userId: USER_ID, limit: 5 } as ListPaymentsRequest;
    const pending = Promise.resolve(payments);
    owners.billing.listPayments.mockReturnValueOnce(pending);

    const result = sources.listPayments(input);

    expect(result).toBe(pending);
    expect(owners.billing.listPayments).toHaveBeenCalledExactlyOnceWith(input);
    expect(owners.billing.listPayments.mock.calls[0]?.[0]).toBe(input);
  });

  it('forwards an owner rejection unchanged', async () => {
    const { sources, owners } = setup();
    const failure = new Error('owner down');
    owners.billing.listPayments.mockRejectedValueOnce(failure);

    await expect(sources.listPayments({} as ListPaymentsRequest)).rejects.toBe(failure);
  });

  it('calls each owner as a method, so a class-based port keeps its this', async () => {
    class ClassUsers {
      readonly seen: string[] = [];
      getUser(id: string): Promise<User> {
        this.seen.push(id);
        return Promise.resolve({ id } as User);
      }
    }
    const users = new ClassUsers();
    const { owners } = setup();
    const sources = new OwnerPortsAiToolSources(users, owners.notifications, owners.billing);

    await expect(sources.getUser(USER_ID)).resolves.toMatchObject({ id: USER_ID });
    expect(users.seen).toEqual([USER_ID]);
  });
});
