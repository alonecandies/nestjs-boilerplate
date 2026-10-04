import { z } from 'zod';

/** Notification kinds. The gRPC `Notification.type` field carries the same values as a string. */
export const NOTIFICATION_TYPES = ['welcome', 'payment_receipt', 'digest', 'system'] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Payload of `notifications.notification-created.v1`: consumed by edges to push to sockets/subscriptions. */
export const notificationCreatedPayload = z.object({
  notificationId: z.uuid(),
  userId: z.uuid(),
  type: z.enum(NOTIFICATION_TYPES),
  title: z.string(),
  body: z.string(),
  data: z.record(z.string(), z.string()),
  createdAt: z.iso.datetime(),
});

export type NotificationCreatedPayload = z.infer<typeof notificationCreatedPayload>;
