import { NOTIFICATION_CREATED_EVENT, NOTIFICATION_TYPES } from '@domain/notifications-contracts';
import { parseEventEnvelope } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { makeNotificationProps } from '../../../test/support/fixtures.js';
import { NOTIFICATION_KINDS } from '../../domain/notification.types.js';
import {
  KIND_BY_TYPE,
  notificationFromCreatedPayload,
  toNotificationContract,
  toNotificationCreatedPayload,
  toNotificationPage,
} from './notification.mapper.js';

describe('notification mapper', () => {
  it('keeps the domain kinds and the contract types identical', () => {
    expect([...NOTIFICATION_KINDS].sort()).toEqual([...NOTIFICATION_TYPES].sort());
    expect(Object.keys(KIND_BY_TYPE).sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it('maps domain state to the gRPC contract (copying data)', () => {
    const props = makeNotificationProps({ type: 'payment_receipt', read: true });
    const contract = toNotificationContract(props);
    expect(contract).toEqual({
      id: props.id,
      userId: props.userId,
      type: 'payment_receipt',
      title: props.title,
      body: props.body,
      read: true,
      data: props.data,
      createdAt: props.createdAt,
    });
    expect(contract.data).not.toBe(props.data);
  });

  it('omits nextPageState on the last page, like the proto `optional`', () => {
    const props = makeNotificationProps();
    expect(toNotificationPage({ items: [props], pageState: null })).toEqual({
      items: [toNotificationContract(props)],
    });
    expect(toNotificationPage({ items: [], pageState: 'ab01' })).toEqual({
      items: [],
      nextPageState: 'ab01',
    });
  });

  it("builds a Kafka payload that validates against NOTIFICATION_CREATED_EVENT's envelope schema", () => {
    const props = makeNotificationProps();
    const payload = toNotificationCreatedPayload(props);
    expect(payload.createdAt).toBe(props.createdAt.toISOString());
    const envelope = {
      id: props.id,
      type: NOTIFICATION_CREATED_EVENT.topic,
      version: 1,
      occurredAt: props.createdAt.toISOString(),
      source: 'test',
      payload,
    };
    expect(parseEventEnvelope(NOTIFICATION_CREATED_EVENT, envelope).payload).toEqual(payload);
  });

  it('round-trips a Kafka payload back into an unread contract notification', () => {
    const props = makeNotificationProps();
    expect(notificationFromCreatedPayload(toNotificationCreatedPayload(props))).toEqual(
      toNotificationContract(props),
    );
  });
});
