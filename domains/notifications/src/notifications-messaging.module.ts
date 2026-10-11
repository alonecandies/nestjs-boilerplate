import { Module } from '@nestjs/common';
import { NotificationsCoreModule } from './notifications-core.module.js';
import { BillingEventsConsumer } from './presentation/messaging/billing-events.consumer.js';
import { IdentityEventsConsumer } from './presentation/messaging/identity-events.consumer.js';

/**
 * Inbound integration events (monolith, notifications-service): `identity.user-registered.v1` →
 * welcome, `billing.payment-succeeded.v1` → receipt. The app connects the consumer with
 * `connectKafkaConsumer(app, { groupId })`; the topics and their `.dlq` must exist.
 */
@Module({
  imports: [NotificationsCoreModule],
  controllers: [IdentityEventsConsumer, BillingEventsConsumer],
})
export class NotificationsMessagingModule {}
