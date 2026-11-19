import { Command } from '@nestjs/cqrs';
import type { LedgerEntryDraft, LedgerPostOutcome } from '../../../domain/ledger/ledger.types.js';

/**
 * Posts one ledger entry through `LedgerService` (the ledger tenant rule) and records its
 * receipts; resolves with the post's outcome. Runs as the posting message's principal or inside
 * `SystemContext` (`LedgerPostingConsumer`).
 */
export class PostLedgerEntryCommand extends Command<LedgerPostOutcome> {
  constructor(readonly draft: LedgerEntryDraft) {
    super();
  }
}
