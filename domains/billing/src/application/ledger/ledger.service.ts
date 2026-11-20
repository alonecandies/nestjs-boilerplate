import { Injectable } from '@nestjs/common';
import { getPrincipal, isPlatformTenantId, SystemContext } from '@platform/common';
import { LedgerTenantMismatchException } from '../../domain/billing.errors.js';
import {
  type LedgerBalance,
  type LedgerEntry,
  type LedgerEntryDraft,
  type LedgerPostOutcome,
  PLATFORM_TENANT_ID,
} from '../../domain/ledger/ledger.types.js';
import { LedgerPort } from '../ports/ledger.port.js';

/**
 * The only caller of `LedgerPort.post`, `getEntry` and `balances` (outbox plan, "Ledger tenant
 * rule"; LG §5: immudb has no RLS, so tenancy is enforced here):
 * - with a CLS principal, a draft must be of `principal.tenantId` (never `PLATFORM_TENANT_ID`; its
 *   lines may still use platform-owned accounts, W0 `assertBalanced`), and reads use that tenant;
 * - inside `SystemContext` (no principal), any tenant may post, the platform's included, and reads
 *   use `PLATFORM_TENANT_ID`;
 * - with neither, everything is refused.
 * A principal nested inside `SystemContext` ends it (`SystemContext.isActive()` is false), so it is
 * judged as a principal. Refusals happen before the port is called.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly ledger: LedgerPort) {}

  /**
   * @throws LedgerTenantMismatchException (LEDGER_TENANT_MISMATCH, 403) by the rule above
   * @throws LedgerDisabledException (LEDGER_DISABLED, 503) while the ledger is disabled
   */
  post(draft: LedgerEntryDraft): Promise<LedgerPostOutcome> {
    const principal = getPrincipal();
    if (principal !== undefined) {
      if (principal.tenantId === null || draft.tenantId !== principal.tenantId) {
        return refuse('tenant-differs');
      }
      // createPrincipal never admits the platform tenant; checked again, cheaply.
      if (isPlatformTenantId(draft.tenantId)) return refuse('tenant-differs');
      return this.ledger.post(draft);
    }
    if (SystemContext.isActive()) return this.ledger.post(draft);
    return refuse('no-principal-or-system-context');
  }

  /** The entry of the context's tenant, or null (another tenant's entry is null too). */
  async getEntry(entryId: string): Promise<LedgerEntry | null> {
    return this.ledger.getEntry(contextTenant(), entryId);
  }

  /** The context tenant's account balances, optionally in one currency. */
  async balances(currency?: string): Promise<readonly LedgerBalance[]> {
    return this.ledger.balances(contextTenant(), currency);
  }
}

/** The principal's tenant, or the platform's inside `SystemContext`. */
function contextTenant(): string {
  const principal = getPrincipal();
  if (principal !== undefined) {
    if (principal.tenantId === null) throw new LedgerTenantMismatchException('tenant-differs');
    return principal.tenantId;
  }
  if (SystemContext.isActive()) return PLATFORM_TENANT_ID;
  throw new LedgerTenantMismatchException('no-principal-or-system-context');
}

function refuse(
  reason: ConstructorParameters<typeof LedgerTenantMismatchException>[0],
): Promise<never> {
  return Promise.reject(new LedgerTenantMismatchException(reason));
}
