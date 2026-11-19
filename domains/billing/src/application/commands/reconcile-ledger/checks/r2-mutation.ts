import { Injectable } from '@nestjs/common';
import { PLATFORM_TENANT_ID } from '@platform/common';
import type { LedgerDiscrepancyInput } from '../../../../domain/ledger/ledger-discrepancy.js';
import { LedgerPort } from '../../../ports/ledger.port.js';
import type { ReconciliationCheck, ReconciliationContext } from '../reconcile-ledger.command.js';

/**
 * R2, no ledger row was ever rewritten (ledger design §4): the application user can only INSERT,
 * so any row with a revision above 1 (`LedgerPort.findMutations`) was updated or deleted by
 * someone else → `ledger_row_mutated` under the platform tenant, source key `<table>:<id>`. The
 * revision is part of the finding, so a further rewrite of the same row is a new finding. The scan
 * is not bounded by the window (a rewrite of an old row matters as much); the ledger design keeps
 * making it incremental (`SINCE TX`) for later.
 */
@Injectable()
export class R2MutationCheck implements ReconciliationCheck {
  readonly name = 'R2';

  constructor(private readonly ledger: LedgerPort) {}

  async run(ctx: ReconciliationContext): Promise<readonly LedgerDiscrepancyInput[]> {
    return (await this.ledger.findMutations()).map((row) => ({
      tenantId: PLATFORM_TENANT_ID,
      kind: 'ledger_row_mutated',
      sourceKey: `${row.table}:${row.id}`,
      expected: { rev: '1' },
      actual: { rev: row.rev.toString() },
      detectedBy: this.name,
      runId: ctx.runId,
    }));
  }
}
