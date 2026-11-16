import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CHARGE_DRAFT, LEDGER_TEST_TENANT as TENANT } from '../../../test/ledger-fixtures.js';
import { ledgerAccountId, ledgerEntryId, ledgerPayloadHash, toEpochMicros } from './ledger.ids.js';
import { PLATFORM_TENANT_ID } from './ledger.types.js';

/** Pinned forever: changing the namespace, the id inputs or the canonical form re-keys the ledger. */
const CANONICAL =
  '{"kind":"charge","lines":[{"accountId":"a713bc9c-7bfa-5292-bb07-c457419d8212","credit":"0","currency":"usd","debit":"2500"},{"accountId":"8b802315-548b-502c-9be0-a1d41b52aecf","credit":"2500","currency":"usd","debit":"0"},{"accountId":"7d92ee01-4ffa-5c83-8232-404f697c9460","credit":"0","currency":"usd","debit":"103"},{"accountId":"a713bc9c-7bfa-5292-bb07-c457419d8212","credit":"103","currency":"usd","debit":"0"}],"occurredAtUs":"1794182400000000","paymentId":"0192f0c1-0000-7000-8000-0000000000aa","presentment":{"amount":"2500","currency":"usd"},"sourceKey":"stripe:txn:txn_1","stripeObject":"ch_1","tenantId":"0192f0c1-0000-7000-8000-000000000001"}';

describe('ledger ids and hash', () => {
  it('derives deterministic uuidv5 ids', () => {
    expect(ledgerEntryId('stripe:txn:txn_1')).toBe('34963174-7910-51ca-a20a-690a08315957');
    expect(ledgerAccountId(PLATFORM_TENANT_ID, 'asset:stripe_balance', 'usd')).toBe(
      'a713bc9c-7bfa-5292-bb07-c457419d8212',
    );
    expect(ledgerAccountId(TENANT, 'revenue:checkout', 'usd')).toBe(
      '8b802315-548b-502c-9be0-a1d41b52aecf',
    );
  });

  it('hashes the canonical JSON (sorted keys, bigints as strings, recordedAt excluded)', () => {
    expect(ledgerPayloadHash(CHARGE_DRAFT)).toBe(
      createHash('sha256').update(CANONICAL).digest('hex'),
    );
    expect(ledgerPayloadHash(CHARGE_DRAFT)).toBe(
      '1764943fe2e39a5a9ac6b072deb88461d9c0d99ea244f7ab548487e139aba4e6',
    );
  });

  it('changes the hash for any money, account, order or tenant change', () => {
    const base = ledgerPayloadHash(CHARGE_DRAFT);
    const [a, b, c, d] = CHARGE_DRAFT.lines;
    if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error();
    expect(
      ledgerPayloadHash({
        ...CHARGE_DRAFT,
        lines: [a, b, { ...c, debit: 104n }, { ...d, credit: 104n }],
      }),
    ).not.toBe(base);
    expect(ledgerPayloadHash({ ...CHARGE_DRAFT, lines: [b, a, c, d] })).not.toBe(base);
    expect(ledgerPayloadHash({ ...CHARGE_DRAFT, tenantId: PLATFORM_TENANT_ID })).not.toBe(base);
  });

  it('converts dates to epoch microseconds', () => {
    expect(toEpochMicros(new Date('2026-11-09T00:00:00.001Z'))).toBe(1_794_182_400_001_000n);
  });
});
