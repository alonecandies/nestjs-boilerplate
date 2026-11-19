import type { LedgerConfig } from '@domain/billing';
import type { INestApplication, INestMicroservice } from '@nestjs/common';
import { connectKafkaConsumer } from '@platform/transport';
import { BILLING_CONSUMER_GROUP } from './billing-service.constants.js';

/**
 * billing-service's only Kafka consumer (`billing.ledger-posting.v1` → `LedgerPostingConsumer`,
 * registered by `BillingMessagingModule`): connected in group `billing-service` while
 * `LEDGER_ENABLED=true`, never otherwise (the service then joins no group). Called by `main.ts`
 * after `connectGrpcServer` and before `startAllMicroservices`; `connect` is the e2e spec's seam.
 */
export function connectLedgerConsumer(
  app: INestApplication,
  ledger: Pick<LedgerConfig, 'enabled'>,
  connect: typeof connectKafkaConsumer = connectKafkaConsumer,
): INestMicroservice | undefined {
  if (!ledger.enabled) return undefined;
  return connect(app, { groupId: BILLING_CONSUMER_GROUP });
}
