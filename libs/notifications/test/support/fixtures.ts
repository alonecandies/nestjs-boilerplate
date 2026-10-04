import { generateId } from '@app/common';
import type { Notification, NotificationPage } from '@app/contracts';
import type { Mocked } from '@app/testing';
import { vi } from 'vitest';
import type { NotificationsPort } from '../../src/application/ports/notifications.port.js';
import type { NotificationProps } from '../../src/domain/notification.types.js';

export const USER_ID = '01920000-0000-7000-8000-000000000001';
export const OTHER_USER_ID = '01920000-0000-7000-8000-000000000002';
export const CREATED_AT = new Date('2026-09-29T08:00:00.000Z');

export function makeNotificationProps(
  overrides: Partial<NotificationProps> = {},
): NotificationProps {
  return {
    id: generateId(),
    userId: USER_ID,
    type: 'system',
    title: 'Hello',
    body: 'World',
    data: { link: '/inbox' },
    read: false,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

export function makeContractNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: generateId(),
    userId: USER_ID,
    type: 'welcome',
    title: 'Welcome aboard!',
    body: 'Hi Ada',
    read: false,
    data: {},
    createdAt: CREATED_AT,
    ...overrides,
  };
}

export function makeNotificationPage(
  items: Notification[] = [makeContractNotification()],
  nextPageState?: string,
): NotificationPage {
  return nextPageState === undefined ? { items } : { items, nextPageState };
}

/**
 * A plain-object fake port (not a Proxy): Nest's GraphQL explorer inspects every provider's
 * `constructor`/prototype, which a Proxy-based auto-mock does not have.
 */
export function createFakePort(): Mocked<NotificationsPort> {
  return {
    list: vi.fn<NotificationsPort['list']>(),
    markRead: vi.fn<NotificationsPort['markRead']>(),
  };
}

/**
 * A class-typed view of a `createMock()` mock, for constructor injection in unit tests: TS does
 * not accept `Mocked<T>` where `T` is a class with private members (CommandBus, MailService, …).
 */
export function asClass<T extends object>(mock: Mocked<T>): T {
  return mock as unknown as T;
}
