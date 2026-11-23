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

/**
 * The ledger client pins no server signing key (`IMMUDB_SERVER_SIGNING_PUBLIC_KEY[_FILE]`), so no
 * state can be proven signed: the re-anchor refuses (audit fixes OPS-1). Operator-facing only.
 */
export class LedgerSigningKeyNotPinnedException extends Error {
  override readonly name = 'LedgerSigningKeyNotPinnedException';

  constructor() {
    super('no immudb server signing key is pinned: set IMMUDB_SERVER_SIGNING_PUBLIC_KEY[_FILE]');
  }
}

/**
 * Why the ledger-reanchor command (or its `--reconcile-only` re-run) refused; it wrote nothing.
 * `reanchor-needed` is the re-run's: the current state does not extend the trusted one.
 */
export type LedgerReanchorRefusal =
  | 'ledger-disabled'
  | 'lost-from-not-past'
  | 'lost-from-in-grace'
  | 'signing-key-not-pinned'
  | 'signature-invalid'
  | 'other-database'
  | 'no-trusted-state'
  | 'nothing-lost'
  | 'trusted-state-changed'
  | 'reanchor-needed';

/**
 * The ledger-reanchor command refused (audit fixes OPS-1): an operator's error or a state that
 * needs no re-anchor, never a partial write. Operator-facing only (the CLI prints it).
 */
export class LedgerReanchorRefusedException extends Error {
  override readonly name = 'LedgerReanchorRefusedException';

  constructor(
    readonly refusal: LedgerReanchorRefusal,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
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
