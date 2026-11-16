import { LedgerUnbalancedException } from './ledger.errors.js';
import { LEDGER_CHART, type LedgerEntryDraft, PLATFORM_TENANT_ID } from './ledger.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURRENCY = /^[a-z]{3}$/;

/**
 * The double-entry rules, checked in TypeScript before any I/O (immudb enforces no CHECK): at least
 * two lines, each with exactly one positive side, lowercase ISO currencies, accounts owned by the
 * entry tenant or the platform as the chart says, and Σdebit = Σcredit per currency.
 */
export function assertBalanced(draft: LedgerEntryDraft): void {
  const problems: string[] = [];
  if (draft.sourceKey.length === 0 || draft.sourceKey.length > 128) {
    problems.push('sourceKey must be 1-128 characters');
  }
  if (!UUID.test(draft.tenantId)) problems.push('tenantId must be a lowercase UUID');
  if (draft.paymentId !== null && !UUID.test(draft.paymentId)) {
    problems.push('paymentId must be a lowercase UUID or null');
  }
  if (
    draft.stripeObjectId !== null &&
    (draft.stripeObjectId.length === 0 || draft.stripeObjectId.length > 64)
  ) {
    problems.push('stripeObjectId must be 1-64 characters or null');
  }
  if (
    draft.presentment !== null &&
    (draft.presentment.amount < 0n || !CURRENCY.test(draft.presentment.currency))
  ) {
    problems.push('presentment must have a non-negative amount and a lowercase ISO 4217 currency');
  }
  if (draft.lines.length < 2) problems.push('an entry needs at least 2 lines');
  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  draft.lines.forEach((line, i) => {
    const at = `line ${i + 1}`;
    if (line.debit < 0n || line.credit < 0n) problems.push(`${at}: negative amount`);
    if (line.debit > 0n === line.credit > 0n) {
      problems.push(`${at}: exactly one of debit or credit must be > 0`);
    }
    if (!CURRENCY.test(line.currency)) {
      problems.push(`${at}: currency must be a lowercase ISO 4217 code`);
    }
    const owner = LEDGER_CHART[line.account].owner;
    if (owner === 'platform' && line.accountOwnerTenantId !== PLATFORM_TENANT_ID) {
      problems.push(`${at}: ${line.account} must be owned by the platform`);
    }
    if (owner === 'tenant' && line.accountOwnerTenantId !== draft.tenantId) {
      problems.push(`${at}: ${line.account} must be owned by the entry tenant`);
    }
    const total = totals.get(line.currency) ?? { debit: 0n, credit: 0n };
    totals.set(line.currency, {
      debit: total.debit + line.debit,
      credit: total.credit + line.credit,
    });
  });
  for (const [currency, { debit, credit }] of totals) {
    if (debit !== credit) problems.push(`${currency}: debit ${debit} ≠ credit ${credit}`);
  }
  if (problems.length > 0) throw new LedgerUnbalancedException(draft.sourceKey, problems);
}
