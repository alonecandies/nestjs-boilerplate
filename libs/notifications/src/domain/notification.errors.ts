import {
  DomainValidationException,
  EntityNotFoundException,
  type ValidationIssue,
} from '@app/common';

/**
 * 404 `NOTIFICATION_NOT_FOUND`: the notification does not exist in THIS user's inbox. Another
 * user's notification id gives the same answer, so ids cannot be probed across inboxes.
 */
export class NotificationNotFoundException extends EntityNotFoundException {
  constructor(notificationId: string) {
    super('Notification', notificationId, { code: 'NOTIFICATION_NOT_FOUND' });
  }
}

/** 422 `INVALID_NOTIFICATION`: a notification violates the inbox invariants (empty title…). */
export class InvalidNotificationException extends DomainValidationException {
  constructor(issues: readonly ValidationIssue[]) {
    super('Invalid notification', { code: 'INVALID_NOTIFICATION', issues });
  }
}
