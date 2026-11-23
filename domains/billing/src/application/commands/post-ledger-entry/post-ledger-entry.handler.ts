import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { isPlatformTenantId, SystemContext } from '@platform/common';
import { ledgerAccountId } from '../../../domain/ledger/ledger.ids.js';
import type { LedgerEntryDraft, LedgerPostOutcome } from '../../../domain/ledger/ledger.types.js';
import type { LedgerDiscrepancyInput } from '../../../domain/ledger/ledger-discrepancy.js';
import { LedgerService } from '../../ledger/ledger.service.js';
import { LedgerMetricsPort } from '../../ports/ledger-metrics.port.js';
import { LedgerSystemRepository } from '../../repositories/ledger.system-repository.js';
import {
  type LedgerAccountRef,
  type LedgerEntryRef,
  LedgerReceiptsRepository,
} from '../../repositories/ledger-receipts.repository.js';
import { PostLedgerEntryCommand } from './post-ledger-entry.command.js';

/** `SystemContext` reason of the platform-owned account rows of a principal's posting (delta 4). */
export const LEDGER_PLATFORM_ACCOUNTS_REASON = 'billing.ledger-platform-accounts';

/**
 * Posts one draft through `LedgerService` (the tenant rule, before any I/O) and records what the
 * outcome leaves in Postgres (outbox plan Task 13, "Outcomes"):
 * - `posted`: the ref with the immudb tx id, then the account rows;
 * - `replayed`: the ref with `immudbTxId: null` (the idempotent insert keeps an existing ref, so
 *   this only writes one when an earlier attempt failed after its post) and the account rows;
 * - `conflict`: one `post_conflict` finding carrying both payload hashes; no ref changes.
 * Where the receipts go: with a principal, the ref, the tenant-owned account rows and findings go
 * through `LedgerReceiptsRepository` (runtime pool, insert-only RLS), and the platform-owned
 * account rows through `LedgerSystemRepository.recordPlatformAccounts` in a nested
 * `SystemContext.run('billing.ledger-platform-accounts', …)`. Inside `SystemContext` every receipt
 * goes through `LedgerSystemRepository`; its account door takes platform rows only, so a
 * user-less tenant posting records the platform's rows and leaves the tenant's to its next
 * principal posting (the rows are a lookup cache of immudb account ids, nothing reads them yet).
 * Every write is idempotent and its own unit of work: a failure after the post rejects, and the
 * redelivery returns `replayed` and completes the receipts. Nothing here opens a transaction
 * around the immudb call.
 */
@CommandHandler(PostLedgerEntryCommand)
export class PostLedgerEntryHandler implements ICommandHandler<PostLedgerEntryCommand> {
  constructor(
    private readonly ledger: LedgerService,
    private readonly receipts: LedgerReceiptsRepository,
    private readonly system: LedgerSystemRepository,
    private readonly metrics: LedgerMetricsPort,
  ) {}

  async execute({ draft }: PostLedgerEntryCommand): Promise<LedgerPostOutcome> {
    const end = this.metrics.startPost();
    let outcome: LedgerPostOutcome;
    try {
      outcome = await this.ledger.post(draft);
    } finally {
      end();
    }
    this.metrics.posted(outcome.status);
    const asSystem = SystemContext.isActive();
    if (outcome.status === 'conflict') {
      const finding = postConflict(draft, outcome);
      const appended = asSystem
        ? (await this.system.appendDiscrepancies([finding])) > 0
        : await this.receipts.appendDiscrepancy(finding);
      if (appended) this.metrics.discrepancies('post_conflict');
      return outcome;
    }
    const ref: LedgerEntryRef = {
      tenantId: draft.tenantId,
      entryId: outcome.entryId,
      sourceKey: draft.sourceKey,
      payloadHash: outcome.payloadHash,
      immudbTxId: outcome.status === 'posted' ? outcome.immudbTxId : null,
      paymentId: draft.paymentId,
      kind: draft.kind,
      postedAt: new Date(),
    };
    const accounts = accountRows(draft);
    const platformAccounts = accounts.filter((row) => isPlatformTenantId(row.tenantId));
    if (asSystem) {
      await this.system.recordEntryRefs([ref]);
      if (platformAccounts.length > 0) await this.system.recordPlatformAccounts(platformAccounts);
      return outcome;
    }
    await this.receipts.recordEntryRef(ref);
    await this.receipts.recordAccounts(accounts.filter((row) => !isPlatformTenantId(row.tenantId)));
    if (platformAccounts.length > 0) {
      await SystemContext.run(LEDGER_PLATFORM_ACCOUNTS_REASON, () =>
        this.system.recordPlatformAccounts(platformAccounts),
      );
    }
    return outcome;
  }
}

/** The distinct `(owner, code, currency)` account rows of a draft's lines, in line order. */
function accountRows(draft: LedgerEntryDraft): LedgerAccountRef[] {
  const rows = new Map<string, LedgerAccountRef>();
  for (const line of draft.lines) {
    const immudbAccountId = ledgerAccountId(line.accountOwnerTenantId, line.account, line.currency);
    if (rows.has(immudbAccountId)) continue;
    rows.set(immudbAccountId, {
      tenantId: line.accountOwnerTenantId,
      code: line.account,
      currency: line.currency,
      immudbAccountId,
    });
  }
  return [...rows.values()];
}

function postConflict(
  draft: LedgerEntryDraft,
  outcome: Extract<LedgerPostOutcome, { status: 'conflict' }>,
): LedgerDiscrepancyInput {
  return {
    tenantId: draft.tenantId,
    kind: 'post_conflict',
    sourceKey: draft.sourceKey,
    expected: { entryId: outcome.entryId, payloadHash: outcome.existingPayloadHash },
    actual: { entryId: outcome.entryId, payloadHash: outcome.payloadHash },
    detectedBy: 'consumer',
    runId: null,
  };
}
