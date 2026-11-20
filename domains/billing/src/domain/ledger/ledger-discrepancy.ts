import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { canonicalJson } from './ledger.ids.js';
import { LEDGER_NAMESPACE } from './ledger.types.js';

/** What a reconciliation check or the posting consumer found (ledger design §4, plan delta 6). */
export type LedgerDiscrepancyKind =
  | 'unbalanced_entry'
  | 'unbalanced_currency'
  | 'ledger_row_mutated'
  | 'payment_without_entry'
  | 'entry_without_payment'
  | 'amount_mismatch'
  | 'tenant_mismatch'
  | 'status_mismatch'
  | 'missing_entry'
  | 'stripe_amount_mismatch'
  | 'fee_unavailable'
  | 'tenant_unresolved'
  | 'verification_failed'
  | 'post_conflict'
  | 'resolved';

/** Who found it: a reconciliation check (R1-R5) or the posting consumer. */
export type LedgerDetector = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'consumer';

/**
 * One finding for `billing.ledger_discrepancies`, under the tenant it concerns (the platform's for
 * ledger-wide findings). Amounts are decimal strings; no PII in `expected` or `actual`.
 */
export interface LedgerDiscrepancyInput {
  readonly tenantId: string;
  readonly kind: LedgerDiscrepancyKind;
  readonly sourceKey: string;
  readonly expected: Readonly<Record<string, string | number | null>>;
  readonly actual: Readonly<Record<string, string | number | null>>;
  readonly detectedBy: LedgerDetector;
  readonly runId: string | null;
}

/**
 * The deterministic id of a finding:
 * `uuidv5(LEDGER_NAMESPACE, 'discrepancy:' + kind + ':' + sourceKey + ':' + sha256(canonicalJson({ expected, actual })))`.
 * The same finding from an overlapping window, a rerun or another detector gets the same id, so it is
 * appended once (resolved or not); the tenant, detector and run are not part of it.
 */
export function ledgerDiscrepancyId(
  input: Pick<LedgerDiscrepancyInput, 'kind' | 'sourceKey' | 'expected' | 'actual'>,
): string {
  const digest = createHash('sha256')
    .update(canonicalJson({ expected: input.expected, actual: input.actual }))
    .digest('hex');
  return uuidv5(`discrepancy:${input.kind}:${input.sourceKey}:${digest}`, LEDGER_NAMESPACE);
}
