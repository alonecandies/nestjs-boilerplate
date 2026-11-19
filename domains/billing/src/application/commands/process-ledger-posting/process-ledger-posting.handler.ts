import type { LedgerPostingRequestedPayload } from '@domain/billing-contracts';
import { Logger } from '@nestjs/common';
import { CommandBus, CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { SystemContext } from '@platform/common';
import type { LedgerDiscrepancyInput } from '../../../domain/ledger/ledger-discrepancy.js';
import { LedgerMetrics } from '../../../infrastructure/ledger/ledger-metrics.js';
import { type LedgerSource, StripeService } from '../../../infrastructure/stripe/stripe.service.js';
import { draftFromBalanceTransaction } from '../../ledger/posting-rules.js';
import { LedgerSystemRepository } from '../../repositories/ledger.system-repository.js';
import { LedgerReceiptsRepository } from '../../repositories/ledger-receipts.repository.js';
import { PostLedgerEntryCommand } from '../post-ledger-entry/post-ledger-entry.command.js';
import { ProcessLedgerPostingCommand } from './process-ledger-posting.command.js';

/** How often the handler asks Stripe while the object has no balance transaction yet. */
export const LEDGER_SOURCE_ATTEMPTS = 3;
/** The wait before the 2nd and 3rd attempt (exponential: 1 s, 2 s; ≈ 3 s per message at most). */
export const LEDGER_SOURCE_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000];

/**
 * One `billing.ledger-posting.v1` request → ledger entries (LG §2.4, outbox plan Task 13):
 * `StripeService.ledgerSource` (Stripe GETs; no unit of work is open here, and none is opened
 * around it) → per balance transaction `draftFromBalanceTransaction` with the request's tenant,
 * payment and the object's presentment (`null` when no money moves: nothing is posted) →
 * `PostLedgerEntryCommand` in order. The caller (`LedgerPostingConsumer`) set the principal or
 * `SystemContext`; each draft is judged by `LedgerService` there.
 * While Stripe has no balance transaction yet (async methods), it asks again, three attempts in
 * all, then appends one `fee_unavailable` finding (deterministic id: a redelivery adds no row)
 * and acknowledges; reconciliation R4 posts the transaction later. Stripe failures propagate.
 */
@CommandHandler(ProcessLedgerPostingCommand)
export class ProcessLedgerPostingHandler implements ICommandHandler<ProcessLedgerPostingCommand> {
  private readonly logger = new Logger(ProcessLedgerPostingHandler.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly stripe: StripeService,
    private readonly receipts: LedgerReceiptsRepository,
    private readonly system: LedgerSystemRepository,
  ) {}

  async execute({ request }: ProcessLedgerPostingCommand): Promise<void> {
    const source = await this.fetchSource(request);
    if (source === null) {
      await this.feeUnavailable(request);
      return;
    }
    for (const transaction of source.transactions) {
      const draft = draftFromBalanceTransaction(transaction, {
        tenantId: request.tenantId,
        paymentId: request.paymentId,
        presentment: source.presentment,
      });
      if (draft === null) continue;
      await this.commandBus.execute(new PostLedgerEntryCommand(draft));
    }
  }

  /** The object's balance transactions, or null when Stripe still has none after every attempt. */
  private async fetchSource(request: LedgerPostingRequestedPayload): Promise<LedgerSource | null> {
    for (let attempt = 1; ; attempt++) {
      const source = await this.stripe.ledgerSource(request.objectType, request.objectId);
      if (!source.pending) return source;
      if (attempt >= LEDGER_SOURCE_ATTEMPTS) return null;
      await wait(LEDGER_SOURCE_RETRY_DELAYS_MS[attempt - 1] ?? 0);
    }
  }

  private async feeUnavailable(request: LedgerPostingRequestedPayload): Promise<void> {
    const finding: LedgerDiscrepancyInput = {
      tenantId: request.tenantId,
      kind: 'fee_unavailable',
      sourceKey: `stripe:${request.objectType}:${request.objectId}`,
      expected: { balanceTransaction: 'available' },
      actual: { balanceTransaction: 'pending', stripeEventId: request.stripeEventId },
      detectedBy: 'consumer',
      runId: null,
    };
    const appended = SystemContext.isActive()
      ? (await this.system.appendDiscrepancies([finding])) > 0
      : await this.receipts.appendDiscrepancy(finding);
    if (appended) LedgerMetrics.discrepancies('fee_unavailable');
    this.logger.warn(
      `Stripe has no balance transaction for ${request.objectType} ${request.objectId} after ${LEDGER_SOURCE_ATTEMPTS} attempts: recorded fee_unavailable (R4 posts it later)`,
    );
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
