import { Injectable } from '@nestjs/common';
import { PLATFORM_TENANT_ID } from '@platform/common';
import { toEpochMicros } from '../../../../domain/ledger/ledger.ids.js';
import type { LedgerDiscrepancyInput } from '../../../../domain/ledger/ledger-discrepancy.js';
import { LedgerPort } from '../../../ports/ledger.port.js';
import type { ReconciliationCheck, ReconciliationContext } from '../reconcile-ledger.command.js';

/**
 * R1, the double-entry invariant re-read from the ledger itself (ledger design §2.5 step 5, §4):
 * - every entry recorded in the window has at least two postings and balances per currency
 *   (`LedgerPort.findUnbalanced`, bounded by the window) → `unbalanced_entry` under the entry's
 *   tenant, source key `ledger_entries:<entry id>`;
 * - debits equal credits per currency over the whole ledger (`totalsByCurrency`) →
 *   `unbalanced_currency` under the platform tenant, source key `currency:<currency>`.
 * The finding values are stable while the ledger is (only the difference is recorded for a
 * currency), so a rerun or an overlapping window yields the same discrepancy ids.
 */
@Injectable()
export class R1InvariantCheck implements ReconciliationCheck {
  readonly name = 'R1';

  constructor(private readonly ledger: LedgerPort) {}

  async run(ctx: ReconciliationContext): Promise<readonly LedgerDiscrepancyInput[]> {
    const meta = { detectedBy: this.name, runId: ctx.runId } as const;
    const found: LedgerDiscrepancyInput[] = [];
    const unbalanced = await this.ledger.findUnbalanced({
      fromUs: toEpochMicros(ctx.from),
      toUs: toEpochMicros(ctx.to),
    });
    for (const entry of unbalanced) {
      found.push({
        tenantId: entry.tenantId,
        kind: 'unbalanced_entry',
        sourceKey: `ledger_entries:${entry.entryId}`,
        ...(entry.currency === null
          ? { expected: { minPostings: 2 }, actual: { postings: entry.postings } }
          : {
              expected: { currency: entry.currency, difference: '0' },
              actual: {
                currency: entry.currency,
                debit: entry.debit.toString(),
                credit: entry.credit.toString(),
                postings: entry.postings,
              },
            }),
        ...meta,
      });
    }
    for (const total of await this.ledger.totalsByCurrency()) {
      if (total.debit === total.credit) continue;
      found.push({
        tenantId: PLATFORM_TENANT_ID,
        kind: 'unbalanced_currency',
        sourceKey: `currency:${total.currency}`,
        expected: { currency: total.currency, difference: '0' },
        actual: { currency: total.currency, difference: (total.debit - total.credit).toString() },
        ...meta,
      });
    }
    return found;
  }
}
