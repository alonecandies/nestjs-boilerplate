import type { ValidationIssue } from '@app/common';
import { AggregateRoot } from '@nestjs/cqrs';
import { isEmpty, size, trim } from 'lodash-es';
import { NotificationCreatedEvent } from './events/notification-created.event.js';
import { InvalidNotificationException } from './notification.errors.js';
import {
  isNotificationKind,
  type NewNotificationProps,
  NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_DATA_MAX_ENTRIES,
  NOTIFICATION_TITLE_MAX_LENGTH,
  type NotificationProps,
} from './notification.types.js';

function validate(props: NewNotificationProps): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isNotificationKind(props.type)) issues.push({ path: 'type', message: 'Unknown type' });
  if (isEmpty(trim(props.title))) issues.push({ path: 'title', message: 'Title is required' });
  if (props.title.length > NOTIFICATION_TITLE_MAX_LENGTH) {
    issues.push({ path: 'title', message: `At most ${NOTIFICATION_TITLE_MAX_LENGTH} characters` });
  }
  if (props.body.length > NOTIFICATION_BODY_MAX_LENGTH) {
    issues.push({ path: 'body', message: `At most ${NOTIFICATION_BODY_MAX_LENGTH} characters` });
  }
  if (size(props.data) > NOTIFICATION_DATA_MAX_ENTRIES) {
    issues.push({ path: 'data', message: `At most ${NOTIFICATION_DATA_MAX_ENTRIES} entries` });
  }
  if (Number.isNaN(props.createdAt.getTime())) {
    issues.push({ path: 'createdAt', message: 'Invalid date' });
  }
  return issues;
}

/**
 * One entry of a user's inbox. Created unread; the only state change is being marked read
 * (idempotent). Notifications are immutable otherwise and expire with the table TTL (90 days).
 */
export class NotificationEntity extends AggregateRoot {
  private constructor(private props: NotificationProps) {
    super();
  }

  /** A new, unread notification; raises `NotificationCreatedEvent` (published on `commit()`). */
  static create(props: NewNotificationProps): NotificationEntity {
    const issues = validate(props);
    if (issues.length > 0) throw new InvalidNotificationException(issues);
    const entity = new NotificationEntity({ ...props, data: { ...props.data }, read: false });
    entity.apply(new NotificationCreatedEvent(entity.toSnapshot()));
    return entity;
  }

  /** Rehydrates persisted state (no events). */
  static restore(props: NotificationProps): NotificationEntity {
    return new NotificationEntity({ ...props, data: { ...props.data } });
  }

  get id(): string {
    return this.props.id;
  }

  get userId(): string {
    return this.props.userId;
  }

  get isRead(): boolean {
    return this.props.read;
  }

  /** Marks the notification read. Returns `false` when it already was (no-op). */
  markRead(): boolean {
    if (this.props.read) return false;
    this.props = { ...this.props, read: true };
    return true;
  }

  /** A defensive copy — callers can never mutate the aggregate's state. */
  toSnapshot(): NotificationProps {
    return { ...this.props, data: { ...this.props.data } };
  }
}
