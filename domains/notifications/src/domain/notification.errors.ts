import {
  DomainValidationException,
  EntityNotFoundException,
  PermissionDeniedException,
  type ValidationIssue,
} from '@platform/common';

/**
 * 404 `NOTIFICATION_NOT_FOUND`: the notification does not exist in THIS (tenant, user) inbox.
 * Another inbox's notification id gives the same answer, so ids cannot be probed across inboxes.
 */
export class NotificationNotFoundException extends EntityNotFoundException {
  constructor(notificationId: string) {
    super('Notification', notificationId, { code: 'NOTIFICATION_NOT_FOUND' });
  }
}

/**
 * 403 `TENANT_MISMATCH`: the request names an inbox, a (tenant, user) pair, that is not the
 * caller principal's own.
 */
export class InboxTenantMismatchException extends PermissionDeniedException {
  constructor() {
    super('The inbox does not belong to your active workspace', { code: 'TENANT_MISMATCH' });
  }
}

/** 422 `INVALID_NOTIFICATION`: a notification violates the inbox invariants (empty title…). */
export class InvalidNotificationException extends DomainValidationException {
  constructor(issues: readonly ValidationIssue[]) {
    super('Invalid notification', { code: 'INVALID_NOTIFICATION', issues });
  }
}
