import { ImmudbError, type ImmudbTx } from '@platform/immudb';
import { type RecordedStatement, RecordingImmudbClient } from '@platform/immudb/testing';
import { describe, expect, it } from 'vitest';
import { CHARGE_DRAFT } from '../../../test/ledger-fixtures.js';
import {
  LedgerUnbalancedException,
  LedgerVerificationFailedException,
} from '../../domain/ledger/ledger.errors.js';
import { ledgerEntryId, ledgerPayloadHash } from '../../domain/ledger/ledger.ids.js';
import { ImmudbLedgerAdapter, LEDGER_SQL, LEDGER_TENANT_READS } from './immudb-ledger.adapter.js';

const ENTRY_ID = ledgerEntryId(CHARGE_DRAFT.sourceKey);
const HASH = ledgerPayloadHash(CHARGE_DRAFT);
const TRUSTED = { database: 'ledger', txId: 9n, txHash: new Uint8Array(32) };

describe('ImmudbLedgerAdapter', () => {
  it('posts accounts, the entry and its postings in one transaction', async () => {
    const client = new RecordingImmudbClient();
    const outcome = await new ImmudbLedgerAdapter(client).post(CHARGE_DRAFT);
    expect(outcome).toEqual({
      status: 'posted',
      entryId: ENTRY_ID,
      payloadHash: HASH,
      immudbTxId: 1n,
    });
    const sql = client.statements.map((s) => s.sql);
    expect(sql[0]).toBe(LEDGER_SQL.selectEntryHash);
    expect(sql.filter((s) => s === LEDGER_SQL.selectAccount)).toHaveLength(3);
    expect(sql.filter((s) => s === LEDGER_SQL.insertAccount)).toHaveLength(3);
    expect(sql.filter((s) => s === LEDGER_SQL.insertEntry)).toHaveLength(1);
    const postings = client.statements.filter((s) => s.sql === LEDGER_SQL.insertPosting);
    expect(postings.map((s) => [s.params['line'], s.params['debit'], s.params['credit']])).toEqual([
      [1n, 2_500n, 0n],
      [2n, 0n, 2_500n],
      [3n, 103n, 0n],
      [4n, 0n, 103n],
    ]);
    expect(postings.every((s) => s.params['tenant_id'] === CHARGE_DRAFT.tenantId)).toBe(true);
    const entry = client.statements.find((s) => s.sql === LEDGER_SQL.insertEntry);
    expect(entry?.params).toMatchObject({
      id: ENTRY_ID,
      payload_hash: HASH,
      payment_id: CHARGE_DRAFT.paymentId,
      presentment_amount: 2_500n,
      occurred_at_us: 1_794_182_400_000_000n,
      schema_version: 1n,
    });
  });

  it('replays the same hash and reports a different one as a conflict, writing nothing', async () => {
    for (const [stored, status] of [
      [HASH, 'replayed'],
      ['f'.repeat(64), 'conflict'],
    ] as const) {
      const client = new RecordingImmudbClient((s: RecordedStatement) =>
        s.sql === LEDGER_SQL.selectEntryHash ? [{ payload_hash: stored }] : [],
      );
      await expect(new ImmudbLedgerAdapter(client).post(CHARGE_DRAFT)).resolves.toMatchObject({
        status,
      });
      expect(client.statements.filter((s) => s.kind === 'exec')).toEqual([]);
    }
  });

  it('retries a read conflict in a new transaction', async () => {
    class FlakyClient extends RecordingImmudbClient {
      private failures = 1;
      override async readWrite<T>(
        work: (tx: ImmudbTx) => Promise<T>,
      ): Promise<{ result: T; txId: bigint | null }> {
        if (this.failures-- > 0) throw new ImmudbError('read-conflict', 'tx read conflict');
        return super.readWrite(work);
      }
    }
    await expect(
      new ImmudbLedgerAdapter(new FlakyClient()).post(CHARGE_DRAFT),
    ).resolves.toMatchObject({
      status: 'posted',
    });
  });

  it('rejects an invalid draft before any statement', async () => {
    const client = new RecordingImmudbClient();
    await expect(
      new ImmudbLedgerAdapter(client).post({
        ...CHARGE_DRAFT,
        lines: CHARGE_DRAFT.lines.slice(0, 1),
      }),
    ).rejects.toBeInstanceOf(LedgerUnbalancedException);
    expect(client.statements).toEqual([]);
  });

  it('every tenant read is scoped by tenant_id = @tenant', () => {
    expect(LEDGER_TENANT_READS.length).toBeGreaterThan(0);
    for (const key of LEDGER_TENANT_READS) expect(LEDGER_SQL[key]).toContain('tenant_id = @tenant');
  });

  it('verifies an entry row and its payload hash', async () => {
    const ok = new RecordingImmudbClient((s) =>
      s.kind === 'verify' ? [{ id: ENTRY_ID, payload_hash: HASH }] : [],
    );
    await expect(
      new ImmudbLedgerAdapter(ok).verifyEntry(ENTRY_ID, HASH, TRUSTED),
    ).resolves.toBeUndefined();
    expect(ok.statements[0]).toMatchObject({
      sql: 'verifiedRow ledger_entries',
      params: { pk0: ENTRY_ID },
    });
    await expect(
      new ImmudbLedgerAdapter(ok).verifyEntry(ENTRY_ID, '0'.repeat(64), TRUSTED),
    ).rejects.toBeInstanceOf(LedgerVerificationFailedException);
    const missing = new RecordingImmudbClient();
    await expect(
      new ImmudbLedgerAdapter(missing).verifyEntry(ENTRY_ID, HASH, TRUSTED),
    ).rejects.toBeInstanceOf(LedgerVerificationFailedException);
  });
});
