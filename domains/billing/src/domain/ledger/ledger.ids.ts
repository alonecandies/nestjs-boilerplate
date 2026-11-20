import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { LEDGER_NAMESPACE, type LedgerAccountCode, type LedgerEntryDraft } from './ledger.types.js';

/** The idempotency key of an entry: same source → same id → a replay can never post twice. */
export function ledgerEntryId(sourceKey: string): string {
  return uuidv5(sourceKey, LEDGER_NAMESPACE);
}

export function ledgerAccountId(
  ownerTenantId: string,
  account: LedgerAccountCode,
  currency: string,
): string {
  return uuidv5(`account:${ownerTenantId}:${account}:${currency}`, LEDGER_NAMESPACE);
}

export function toEpochMicros(at: Date): bigint {
  return BigInt(at.getTime()) * 1_000n;
}

/**
 * Sorted keys at every level, bigints as decimal strings, no whitespace: the hashing input of
 * `ledgerPayloadHash` and `ledgerDiscrepancyId`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`cannot canonicalise a ${typeof value}`);
}

/** sha256 hex over the canonical entry (spec 2.5); `recordedAt` is excluded so replays match. */
export function ledgerPayloadHash(draft: LedgerEntryDraft): string {
  const payload = {
    sourceKey: draft.sourceKey,
    tenantId: draft.tenantId,
    kind: draft.kind,
    paymentId: draft.paymentId,
    stripeObject: draft.stripeObjectId,
    presentment: draft.presentment,
    occurredAtUs: toEpochMicros(draft.occurredAt),
    lines: draft.lines.map((line) => ({
      accountId: ledgerAccountId(line.accountOwnerTenantId, line.account, line.currency),
      currency: line.currency,
      debit: line.debit,
      credit: line.credit,
    })),
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}
