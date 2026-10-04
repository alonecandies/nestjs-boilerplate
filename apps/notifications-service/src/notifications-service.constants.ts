/**
 * Kafka consumer group of the inbound integration events (`identity.user-registered.v1`,
 * `billing.payment-succeeded.v1`). Pinned in code rather than derived from the `KAFKA_GROUP_ID` /
 * `SERVICE_NAME` defaults: every replica must share it (one delivery per event across the
 * service), and a renamed group has no committed offsets, so it would start at the latest offset
 * (`fromBeginning: false`) and silently skip everything published in between.
 */
export const NOTIFICATIONS_CONSUMER_GROUP = 'notifications-service';
