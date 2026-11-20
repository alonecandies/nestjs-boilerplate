/**
 * Consumer group of billing-service's Kafka consumer: `billing.ledger-posting.v1` →
 * `LedgerPostingConsumer`, connected by `main.ts` only while `LEDGER_ENABLED=true`. Fixed, like
 * the monolith's: the group must not depend on how `SERVICE_NAME` or `KAFKA_GROUP_ID` are set, or
 * a renamed service would re-read the topic from its start.
 */
export const BILLING_CONSUMER_GROUP = 'billing-service';
