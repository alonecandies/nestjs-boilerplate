import type { LedgerPostingRequestedPayload } from '@domain/billing-contracts';
import { Command } from '@nestjs/cqrs';

/**
 * Turns one `billing.ledger-posting.v1` request into ledger entries, one per Stripe balance
 * transaction of its object. Runs as the message's principal or inside `SystemContext`.
 */
export class ProcessLedgerPostingCommand extends Command<void> {
  constructor(readonly request: LedgerPostingRequestedPayload) {
    super();
  }
}
