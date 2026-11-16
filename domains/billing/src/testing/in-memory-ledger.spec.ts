import { describe, expect, it } from 'vitest';
import { LedgerVerificationFailedException } from '../domain/ledger/ledger.errors.js';
import { InMemoryLedger } from './in-memory-ledger.js';
import { describeLedgerContract } from './ledger.contract.test.js';

describeLedgerContract('InMemoryLedger', async () => ({ ledger: new InMemoryLedger() }));

describe('InMemoryLedger', () => {
  it('refuses a trusted state ahead of the ledger', async () => {
    const ledger = new InMemoryLedger();
    await expect(
      ledger.advanceTrustedState({ database: 'in-memory', txId: 5n, txHash: new Uint8Array(32) }),
    ).rejects.toBeInstanceOf(LedgerVerificationFailedException);
  });
});
