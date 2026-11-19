import { generateId } from '@platform/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { draftFromBalanceTransaction } from '../application/ledger/posting-rules.js';
import type { LedgerPort } from '../application/ports/ledger.port.js';
import {
  LedgerUnbalancedException,
  LedgerVerificationFailedException,
} from '../domain/ledger/ledger.errors.js';
import { ledgerEntryId, ledgerPayloadHash, toEpochMicros } from '../domain/ledger/ledger.ids.js';
import type { LedgerEntryDraft } from '../domain/ledger/ledger.types.js';

export interface LedgerUnderTest {
  readonly ledger: LedgerPort;
  readonly close?: () => Promise<void>;
}

/**
 * The behaviour every LedgerPort implementation shares (spec 6.4): run by the in-memory fake's unit
 * spec and by the immudb adapter's int spec. Each test uses fresh tenant and source ids, so a shared
 * database works.
 */
export function describeLedgerContract(name: string, make: () => Promise<LedgerUnderTest>): void {
  describe(`LedgerPort contract: ${name}`, () => {
    let subject: LedgerUnderTest;
    let tenantId: string;
    let txnId: string;

    const charge = (amount = 2_500, fee = 103): LedgerEntryDraft => {
      const draft = draftFromBalanceTransaction(
        {
          id: txnId,
          amount,
          fee,
          currency: 'usd',
          created: 1_794_182_400,
          reporting_category: 'charge',
          source: 'ch_contract',
        },
        {
          tenantId,
          paymentId: generateId(),
          presentment: { amount: BigInt(amount), currency: 'usd' },
        },
      );
      if (draft === null) throw new Error('charge posts nothing');
      return draft;
    };

    beforeEach(async () => {
      subject = await make();
      tenantId = generateId();
      txnId = `txn_${generateId().replaceAll('-', '')}`;
    });

    afterEach(async () => {
      await subject.close?.();
    });

    it('posts once, then replays the same draft and flags a different one as a conflict', async () => {
      const draft = charge();
      const posted = await subject.ledger.post(draft);
      expect(posted).toMatchObject({
        status: 'posted',
        entryId: ledgerEntryId(draft.sourceKey),
        payloadHash: ledgerPayloadHash(draft),
      });
      expect(posted.status === 'posted' && posted.immudbTxId > 0n).toBe(true);
      await expect(subject.ledger.post(draft)).resolves.toEqual({
        status: 'replayed',
        entryId: posted.entryId,
        payloadHash: posted.payloadHash,
      });
      const changed = charge(2_400);
      await expect(subject.ledger.post(changed)).resolves.toEqual({
        status: 'conflict',
        entryId: posted.entryId,
        payloadHash: ledgerPayloadHash(changed),
        existingPayloadHash: posted.payloadHash,
      });
      await expect(subject.ledger.getEntry(tenantId, posted.entryId)).resolves.toMatchObject({
        payloadHash: posted.payloadHash,
      });
    });

    it('rejects an unbalanced draft before writing anything', async () => {
      const draft = charge();
      const [first, ...rest] = draft.lines;
      if (first === undefined) throw new Error('no lines');
      const unbalanced = { ...draft, lines: [{ ...first, debit: first.debit + 1n }, ...rest] };
      await expect(subject.ledger.post(unbalanced)).rejects.toBeInstanceOf(
        LedgerUnbalancedException,
      );
      await expect(
        subject.ledger.getEntry(tenantId, ledgerEntryId(draft.sourceKey)),
      ).resolves.toBeNull();
    });

    it('lets exactly one of several concurrent posts of an entry win', async () => {
      const draft = charge();
      const outcomes = await Promise.all([1, 2, 3].map(() => subject.ledger.post(draft)));
      expect(outcomes.filter((o) => o.status === 'posted')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'replayed')).toHaveLength(2);
    });

    it('reads an entry only for its own tenant, with its postings in line order', async () => {
      const draft = charge();
      const posted = await subject.ledger.post(draft);
      const entry = await subject.ledger.getEntry(tenantId, posted.entryId);
      expect(entry).toMatchObject({
        id: posted.entryId,
        sourceKey: draft.sourceKey,
        tenantId,
        kind: 'charge',
        paymentId: draft.paymentId,
        stripeObjectId: 'ch_contract',
        presentment: { amount: 2_500n, currency: 'usd' },
        occurredAt: draft.occurredAt,
      });
      expect(entry?.postings.map((p) => [p.line, p.debit, p.credit])).toEqual([
        [1, 2_500n, 0n],
        [2, 0n, 2_500n],
        [3, 103n, 0n],
        [4, 0n, 103n],
      ]);
      await expect(subject.ledger.getEntry(generateId(), posted.entryId)).resolves.toBeNull();
    });

    it('sums balances per account for a tenant', async () => {
      await subject.ledger.post(charge());
      const balances = await subject.ledger.balances(tenantId, 'usd');
      const byAccount = Object.fromEntries(
        balances.map((b) => [b.account ?? b.accountId, [b.debit, b.credit]]),
      );
      expect(byAccount).toEqual({
        'asset:stripe_balance': [2_500n, 103n],
        'revenue:checkout': [0n, 2_500n],
        'expense:stripe_fees': [103n, 0n],
      });
      await expect(subject.ledger.balances(generateId())).resolves.toEqual([]);
    });

    it('finds nothing unbalanced or mutated and balances every currency globally', async () => {
      await subject.ledger.post(charge());
      const window = { fromUs: 0n, toUs: toEpochMicros(new Date(Date.now() + 60_000)) };
      await expect(subject.ledger.findUnbalanced(window)).resolves.toEqual([]);
      for (const total of await subject.ledger.totalsByCurrency()) {
        expect(total.debit).toBe(total.credit);
      }
      await expect(subject.ledger.findMutations()).resolves.toEqual([]);
    });

    it('verifies a posted entry against an advanced trusted state', async () => {
      const first = await subject.ledger.advanceTrustedState(null);
      const posted = await subject.ledger.post(charge());
      const trusted = await subject.ledger.advanceTrustedState(first);
      expect(trusted.txId).toBeGreaterThanOrEqual(first.txId);
      await expect(
        subject.ledger.verifyEntry(posted.entryId, posted.payloadHash, trusted),
      ).resolves.toBeUndefined();
      await expect(
        subject.ledger.verifyEntry(posted.entryId, '0'.repeat(64), trusted),
      ).rejects.toBeInstanceOf(LedgerVerificationFailedException);
      // A trusted state the store never reached (rolled back or forked) fails closed in both.
      await expect(
        subject.ledger.verifyEntry(posted.entryId, posted.payloadHash, {
          ...trusted,
          txId: trusted.txId + 1_000n,
        }),
      ).rejects.toBeInstanceOf(LedgerVerificationFailedException);
    });

    it('reports its current state, which the next advance proves and returns', async () => {
      const posted = await subject.ledger.post(charge());
      const current = await subject.ledger.currentState();
      expect(posted.status === 'posted' && current.txId >= posted.immudbTxId).toBe(true);
      expect(current.txHash).toHaveLength(32);
      const advanced = await subject.ledger.advanceTrustedState(current);
      expect(advanced).toMatchObject({ database: current.database, txId: current.txId });
      expect([...advanced.txHash]).toEqual([...current.txHash]);
      // The same tx id under another hash is not the same history.
      await expect(
        subject.ledger.advanceTrustedState({
          ...current,
          txHash: current.txHash.map((b, i) => (i === 0 ? b ^ 1 : b)),
        }),
      ).rejects.toBeInstanceOf(LedgerVerificationFailedException);
    });
  });
}
