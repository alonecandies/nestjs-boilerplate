import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { PLATFORM_TENANT_ID, SystemContext } from '@platform/common';
import { AppConfigModule } from '@platform/config';
import { IMMUDB_TEST_IMAGE, ImmudbClient, ImmudbModule } from '@platform/immudb';
import { sql } from 'drizzle-orm';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { R5VerificationCheck } from '../src/application/commands/reconcile-ledger/checks/r5-verification.js';
import { ReconciliationCheckFailure } from '../src/application/commands/reconcile-ledger/reconcile-ledger.command.js';
import type { LedgerEntryRef } from '../src/application/repositories/ledger-receipts.repository.js';
import type { LedgerEntryDraft } from '../src/domain/ledger/ledger.types.js';
import type { LedgerDiscrepancyInput } from '../src/domain/ledger/ledger-discrepancy.js';
import { billingLedgerMigrations } from '../src/infrastructure/ledger/billing-ledger.migrations.js';
import { ImmudbLedgerAdapter } from '../src/infrastructure/ledger/immudb-ledger.adapter.js';
import { DrizzleLedgerSystemRepository } from '../src/infrastructure/persistence/drizzle-ledger.system-repository.js';
import { type BillingDatabase, startBillingDatabase } from './billing-database.js';
import { CHARGE_DRAFT, LEDGER_TEST_TENANT as TENANT_A } from './ledger-fixtures.js';

/*
 * Reconciliation R5 (outbox plan Task 17, L-14, D3) against real proofs: immudb 1.11.2 started
 * with `--signingKey` (a P-256 key pair generated here; its public key pinned in the client, as
 * IMMUDB_SERVER_SIGNING_PUBLIC_KEY does) and the trusted state in Citus 14.2 (local execution off)
 * through the real `DrizzleLedgerSystemRepository` on the app_system pool. The check runs on its
 * own (the handler's run status is covered by r5-verification.spec.ts): a failed proof is the
 * `ReconciliationCheckFailure` the handler turns into a `failed` run.
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project billing:int ledger-verification
 */

const TENANT_B = '0197d500-0000-7000-8000-0000000000b0';
const DATABASE = 'ledger_verify_it';
const HOUR = 3_600_000;

const pem = (key: KeyObject): string => key.export({ type: 'spki', format: 'pem' }).toString();
const base64 = (text: string): string => Buffer.from(text).toString('base64');

async function startImmudb(signingKeyPem?: string): Promise<StartedTestContainer> {
  let container = new GenericContainer(IMMUDB_TEST_IMAGE)
    .withEnvironment({ IMMUDB_PGSQL_SERVER: 'false' })
    .withExposedPorts(3322, 9497)
    .withWaitStrategy(Wait.forHttp('/readyz', 9497));
  if (signingKeyPem !== undefined) {
    // SEC1 "EC PRIVATE KEY" PEM, as immudb's pkg/signer/ecdsa.go parses it.
    container = container
      .withCopyContentToContainer([
        { content: signingKeyPem, target: '/keys/signing.key', mode: 0o644 },
      ])
      .withCommand(['--signingKey=/keys/signing.key']);
  }
  return container.start();
}

const draft = (n: number, tenantId: string): LedgerEntryDraft => ({
  ...CHARGE_DRAFT,
  sourceKey: `stripe:txn:txn_verify_${n}`,
  tenantId,
  lines: CHARGE_DRAFT.lines.map((line) =>
    line.account === 'revenue:checkout' ? { ...line, accountOwnerTenantId: tenantId } : line,
  ),
});

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'Reconciliation R5 over immudb --signingKey and Citus',
  () => {
    const signing = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const signingPrivatePem = signing.privateKey.export({ type: 'sec1', format: 'pem' }).toString();
    const pinned = base64(pem(signing.publicKey));
    const otherKey = base64(pem(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey));

    let signed: StartedTestContainer | undefined;
    let plain: StartedTestContainer | undefined;
    let restarted: StartedTestContainer | undefined;
    let database: BillingDatabase | undefined;
    let system: DrizzleLedgerSystemRepository;
    const modules: TestingModule[] = [];
    let posted = 0;

    const db = () => database ?? expect.fail('no database');
    const asSystem = <T>(fn: () => Promise<T>) => SystemContext.run('billing.reconcile-ledger', fn);
    const window = () => ({
      runId: '0197d500-0000-7000-8000-00000000c0de',
      from: new Date(Date.now() - 72 * HOUR),
      to: new Date(Date.now() - 15 * 60_000),
    });

    /** The ledger adapter over an ImmudbModule booted on `container` (migrated when `migrate`). */
    const adapterOn = async (
      container: StartedTestContainer,
      options: { database?: string; key?: string; migrate?: boolean } = {},
    ): Promise<ImmudbLedgerAdapter> => {
      const env: Record<string, string | undefined> = {
        IMMUDB_ADDRESS: `${container.getHost()}:${container.getMappedPort(3322)}`,
        IMMUDB_DATABASE: options.database ?? DATABASE,
        IMMUDB_ADMIN_PASSWORD: 'immudb',
        IMMUDB_RUN_MIGRATIONS: options.migrate === true ? 'true' : 'false',
        IMMUDB_SERVER_SIGNING_PUBLIC_KEY: options.key,
      };
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const moduleRef = await Test.createTestingModule({
        imports: [
          AppConfigModule.forRoot(),
          ImmudbModule.forRootAsync({ migrations: [billingLedgerMigrations] }),
        ],
      }).compile();
      modules.push(moduleRef);
      return new ImmudbLedgerAdapter(moduleRef.get(ImmudbClient));
    };

    /** Posts entry `n` and records its receipt the way the consumer does (`posted`: its tx id). */
    const post = async (
      ledger: ImmudbLedgerAdapter,
      tenantId: string,
      options: { refHash?: string } = {},
    ): Promise<LedgerEntryRef> => {
      posted += 1;
      const entry = draft(posted, tenantId);
      const outcome = await ledger.post(entry);
      if (outcome.status !== 'posted') throw new Error(`entry ${posted}: ${outcome.status}`);
      const ref: LedgerEntryRef = {
        tenantId,
        entryId: outcome.entryId,
        sourceKey: entry.sourceKey,
        payloadHash: options.refHash ?? outcome.payloadHash,
        immudbTxId: outcome.immudbTxId,
        paymentId: null,
        kind: entry.kind,
        postedAt: new Date(),
      };
      await asSystem(() => system.recordEntryRefs([ref]));
      return ref;
    };

    const trustedRow = async (database = DATABASE) => {
      const rows = await db().superuser.execute<{ tx_id: string; tx_hash: Buffer }>(
        sql`select tx_id::text as tx_id, tx_hash from billing.ledger_trusted_state
            where database = ${database}`,
      );
      const [row] = [...rows];
      return row === undefined
        ? null
        : { txId: BigInt(row.tx_id), txHash: Buffer.from(row.tx_hash).toString('hex') };
    };

    /** Runs R5 expecting a failed proof; returns its one finding. */
    const failedProof = async (check: R5VerificationCheck): Promise<LedgerDiscrepancyInput> => {
      const failure = await asSystem(() => check.run(window())).then(
        () => expect.fail('R5 verified a state it should refuse'),
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ReconciliationCheckFailure);
      const { findings } = failure as ReconciliationCheckFailure;
      expect(findings).toHaveLength(1);
      return findings[0] ?? expect.fail('no finding');
    };

    beforeAll(async () => {
      [signed, plain, database] = await Promise.all([
        startImmudb(signingPrivatePem),
        startImmudb(),
        startBillingDatabase([DrizzleLedgerSystemRepository]),
      ]);
      system = database.app.get(DrizzleLedgerSystemRepository);
    }, 360_000);

    afterAll(async () => {
      for (const moduleRef of modules) await moduleRef.close();
      await database?.close();
      await Promise.all([signed?.stop(), plain?.stop(), restarted?.stop()]);
    });

    it('real proofs: the first state is stored, a later one advances it and the new refs verify', async () => {
      if (signed === undefined) throw new Error('container not started');
      const ledger = await adapterOn(signed, { key: pinned, migrate: true });
      const check = new R5VerificationCheck(ledger, system);
      const verifyEntry = vi.spyOn(ledger, 'verifyEntry');
      const a = await post(ledger, TENANT_A);
      const b = await post(ledger, TENANT_B);

      await expect(asSystem(() => check.run(window()))).resolves.toEqual([]);
      const first = await trustedRow();
      const current = await ledger.currentState();
      expect(first).toEqual({
        txId: current.txId,
        txHash: Buffer.from(current.txHash).toString('hex'),
      });
      expect(verifyEntry.mock.calls.map(([entryId]) => entryId).sort()).toEqual(
        [a.entryId, b.entryId].sort(),
      );
      verifyEntry.mockClear();

      const c = await post(ledger, TENANT_A);
      const forged = await post(ledger, TENANT_B, { refHash: 'f'.repeat(64) });
      const findings = await asSystem(() => check.run(window()));

      // Only the refs above the old tx id were verified, against the advanced state.
      expect(verifyEntry.mock.calls.map(([entryId]) => entryId).sort()).toEqual(
        [c.entryId, forged.entryId].sort(),
      );
      expect(findings).toEqual([
        expect.objectContaining({
          tenantId: TENANT_B,
          kind: 'verification_failed',
          sourceKey: `ledger_entries:${forged.entryId}`,
          detectedBy: 'R5',
        }),
      ]);
      const second = await trustedRow();
      expect(second?.txId).toBe((await ledger.currentState()).txId);
      expect(second?.txId ?? 0n).toBeGreaterThan(first?.txId ?? 0n);
    });

    it('an adapter pinned to another key: verification_failed and no advance', async () => {
      if (signed === undefined) throw new Error('container not started');
      const before = await trustedRow();
      const ledger = await adapterOn(signed, { key: otherKey });
      await post(await adapterOn(signed, { key: pinned }), TENANT_A);

      const finding = await failedProof(new R5VerificationCheck(ledger, system));

      expect(finding).toMatchObject({
        tenantId: PLATFORM_TENANT_ID,
        kind: 'verification_failed',
        sourceKey: `state:${DATABASE}`,
        expected: { txId: before?.txId.toString(), txHash: before?.txHash },
        actual: { reason: expect.stringContaining('signature') },
      });
      expect(await trustedRow()).toEqual(before);
    });

    it('a server without a signing key while one is pinned is refused, also on first use', async () => {
      if (plain === undefined) throw new Error('container not started');
      const database = 'ledger_unsigned_it';
      const ledger = await adapterOn(plain, { database, key: pinned, migrate: true });
      await post(ledger, TENANT_A);

      const finding = await failedProof(new R5VerificationCheck(ledger, system));

      expect(finding).toMatchObject({
        tenantId: PLATFORM_TENANT_ID,
        sourceKey: `state:${database}`,
        expected: { txId: null, txHash: null },
        actual: { reason: expect.stringContaining('signature') },
      });
      expect(await trustedRow(database)).toBeNull();
    });

    it('immudb restarted on an empty volume with the old trusted state in Postgres: verification_failed, no advance', async () => {
      const before = await trustedRow();
      if (before === null) throw new Error('no trusted state from the first test');
      await signed?.stop();
      signed = undefined;
      restarted = await startImmudb(signingPrivatePem);
      const ledger = await adapterOn(restarted, { key: pinned, migrate: true });
      // Rebuild a history at least as long as the old one: a fresh chain, not a shorter one.
      while ((await ledger.currentState()).txId <= before.txId) await post(ledger, TENANT_A);

      const finding = await failedProof(new R5VerificationCheck(ledger, system));

      expect(finding).toMatchObject({
        tenantId: PLATFORM_TENANT_ID,
        sourceKey: `state:${DATABASE}`,
        expected: { txId: before.txId.toString(), txHash: before.txHash },
      });
      expect(await trustedRow()).toEqual(before);
    });
  },
);
