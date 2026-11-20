import { describe, expect, it } from 'vitest';
import { CHARGE_DRAFT } from '../../test/ledger-fixtures.js';
import { LedgerVerificationFailedException } from '../domain/ledger/ledger.errors.js';
import { IN_MEMORY_LEDGER_DATABASE, InMemoryLedger } from './in-memory-ledger.js';
import { describeLedgerContract } from './ledger.contract.test.js';

describeLedgerContract('InMemoryLedger', async () => ({ ledger: new InMemoryLedger() }));

describe('InMemoryLedger', () => {
  it('refuses a trusted state ahead of the ledger', async () => {
    const ledger = new InMemoryLedger();
    await expect(
      ledger.advanceTrustedState({ database: 'in-memory', txId: 5n, txHash: new Uint8Array(32) }),
    ).rejects.toBeInstanceOf(LedgerVerificationFailedException);
  });

  it('a rewrite of an entry is a new transaction: earlier states stay consistent', async () => {
    const ledger = new InMemoryLedger();
    const posted = await ledger.post(CHARGE_DRAFT);
    const first = await ledger.advanceTrustedState(null);
    ledger.tamper(posted.entryId, (entry) => ({ ...entry, stripeObjectId: 'ch_rewritten' }));
    const next = await ledger.advanceTrustedState(first);
    expect(next).toMatchObject({ database: IN_MEMORY_LEDGER_DATABASE, txId: 2n });
  });

  it('forkHistory: no earlier state is consistent any more, the empty one still is', async () => {
    const ledger = new InMemoryLedger();
    const posted = await ledger.post(CHARGE_DRAFT);
    const trusted = await ledger.advanceTrustedState(null);
    ledger.forkHistory();
    await expect(ledger.advanceTrustedState(trusted)).rejects.toMatchObject({
      reason: 'no valid consistency proof from tx 1 to tx 1',
    });
    await expect(
      ledger.verifyEntry(posted.entryId, posted.payloadHash, trusted),
    ).rejects.toBeInstanceOf(LedgerVerificationFailedException);
    const empty = { database: IN_MEMORY_LEDGER_DATABASE, txId: 0n, txHash: new Uint8Array(32) };
    const forked = await ledger.advanceTrustedState(empty);
    expect([...forked.txHash]).not.toEqual([...trusted.txHash]);
    await expect(
      ledger.verifyEntry(posted.entryId, posted.payloadHash, forked),
    ).resolves.toBeUndefined();
  });
});
