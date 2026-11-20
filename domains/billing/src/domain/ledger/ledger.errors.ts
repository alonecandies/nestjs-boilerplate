import { BusinessRuleViolationException, ExternalServiceException } from '@platform/common';
import { BillingErrorCode } from '../../billing.constants.js';

/** A draft that violates the double-entry rules: a programming error, never retried. */
export class LedgerUnbalancedException extends BusinessRuleViolationException {
  constructor(
    readonly sourceKey: string,
    readonly problems: readonly string[],
  ) {
    super(`Ledger entry ${sourceKey} is invalid: ${problems.join('; ')}`, {
      code: BillingErrorCode.LEDGER_ENTRY_INVALID,
      details: { sourceKey, problems: [...problems] },
    });
  }
}

/** A ledger row did not verify against the trusted state (tamper evidence; page someone). */
export class LedgerVerificationFailedException extends ExternalServiceException {
  /** Why it failed (no PII: tx ids, hashes, the proof that did not hold); R5 stores it. */
  readonly reason: string;

  constructor(entryId: string, reason: string, cause?: unknown) {
    super(`Ledger entry ${entryId} failed verification: ${reason}`, {
      code: BillingErrorCode.LEDGER_VERIFICATION_FAILED,
      cause,
      details: { entryId },
    });
    this.reason = reason;
  }
}
