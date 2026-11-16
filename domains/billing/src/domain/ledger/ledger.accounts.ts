import { ledgerAccountId } from './ledger.ids.js';
import { LEDGER_CHART, type LedgerAccountCode, PLATFORM_TENANT_ID } from './ledger.types.js';

const CODES = Object.keys(LEDGER_CHART) as LedgerAccountCode[];

/** Which chart account an id is, for `tenantId` (tenant accounts) or the platform, in `currency`. */
export function resolveLedgerAccount(
  accountId: string,
  tenantId: string,
  currency: string,
): LedgerAccountCode | null {
  for (const code of CODES) {
    const owner = LEDGER_CHART[code].owner === 'platform' ? PLATFORM_TENANT_ID : tenantId;
    if (ledgerAccountId(owner, code, currency) === accountId) return code;
  }
  return null;
}
