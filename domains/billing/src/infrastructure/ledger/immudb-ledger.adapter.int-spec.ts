import { Test, type TestingModule } from '@nestjs/testing';
import { AppConfigModule } from '@platform/config';
import { IMMUDB_TEST_IMAGE, ImmudbClient, ImmudbModule } from '@platform/immudb';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CHARGE_DRAFT } from '../../../test/ledger-fixtures.js';
import { toEpochMicros } from '../../domain/ledger/ledger.ids.js';
import { describeLedgerContract } from '../../testing/ledger.contract.test.js';
import { billingLedgerMigrations } from './billing-ledger.migrations.js';
import { ImmudbLedgerAdapter } from './immudb-ledger.adapter.js';

describe.skipIf(process.env['INTEGRATION'] !== '1')('ImmudbLedgerAdapter on immudb 1.11.2', () => {
  let container: StartedTestContainer | undefined;
  let app: TestingModule | undefined;
  let admin: TestingModule | undefined;
  let adapter: ImmudbLedgerAdapter;

  const boot = async (env: Record<string, string>): Promise<TestingModule> => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        ImmudbModule.forRootAsync({ migrations: [billingLedgerMigrations] }),
      ],
    }).compile();
    vi.unstubAllEnvs();
    return moduleRef;
  };

  beforeAll(async () => {
    container = await new GenericContainer(IMMUDB_TEST_IMAGE)
      .withEnvironment({ IMMUDB_PGSQL_SERVER: 'false' })
      .withExposedPorts(3322, 9497)
      .withWaitStrategy(Wait.forHttp('/readyz', 9497))
      .start();
    const address = `${container.getHost()}:${container.getMappedPort(3322)}`;
    // The application user (SELECT + INSERT only), provisioned and migrated at boot.
    app = await boot({
      IMMUDB_ADDRESS: address,
      IMMUDB_DATABASE: 'ledger_it',
      IMMUDB_ADMIN_PASSWORD: 'immudb',
      IMMUDB_RUN_MIGRATIONS: 'true',
    });
    // A superuser session on the same database, to forge rows the adapter would never write.
    admin = await boot({
      IMMUDB_ADDRESS: address,
      IMMUDB_DATABASE: 'ledger_it',
      IMMUDB_USERNAME: 'immudb',
      IMMUDB_PASSWORD: 'immudb',
    });
    adapter = new ImmudbLedgerAdapter(app.get(ImmudbClient));
  });

  afterAll(async () => {
    await app?.close();
    await admin?.close();
    await container?.stop();
  });

  describeLedgerContract('ImmudbLedgerAdapter', async () => ({ ledger: adapter }));

  it('finds entries with fewer than two postings or unbalanced currencies (R1)', async () => {
    const immudb = admin?.get(ImmudbClient);
    if (immudb === undefined) throw new Error('admin not booted');
    const now = toEpochMicros(new Date());
    const entry = (id: string) =>
      `INSERT INTO ledger_entries (id, source_key, tenant_id, kind, payment_id, stripe_object, presentment_amount, presentment_currency, payload_hash, occurred_at_us, recorded_at_us, schema_version) VALUES ('${id}', 'forged:${id}', '${CHARGE_DRAFT.tenantId}', 'adjustment', '', '', 0, '', '${'0'.repeat(64)}', ${now}, ${now}, 1)`;
    const posting = (entryId: string, line: number, debit: number, credit: number) =>
      `INSERT INTO ledger_postings (id, entry_id, line, tenant_id, account_id, currency, debit, credit) VALUES ('${entryId}:${line}', '${entryId}', ${line}, '${CHARGE_DRAFT.tenantId}', 'acct', 'usd', ${debit}, ${credit})`;
    await immudb.readWrite(async (tx) => {
      await tx.exec(entry('forged-one-line'));
      await tx.exec(posting('forged-one-line', 1, 5, 0));
      await tx.exec(entry('forged-unbalanced'));
      await tx.exec(posting('forged-unbalanced', 1, 5, 0));
      await tx.exec(posting('forged-unbalanced', 2, 0, 4));
    });
    const found = await adapter.findUnbalanced({ fromUs: now - 1n, toUs: now + 60_000_000n });
    expect(found).toEqual(
      expect.arrayContaining([
        { entryId: 'forged-one-line', currency: null, debit: 0n, credit: 0n, postings: 1 },
        { entryId: 'forged-unbalanced', currency: 'usd', debit: 5n, credit: 4n, postings: 2 },
      ]),
    );
  });

  it('detects a row rewritten by a superuser (R2) and fails its verification', async () => {
    const immudb = admin?.get(ImmudbClient);
    if (immudb === undefined) throw new Error('admin not booted');
    const posted = await adapter.post({ ...CHARGE_DRAFT, sourceKey: 'stripe:txn:txn_tampered' });
    const trusted = await adapter.advanceTrustedState(null);
    await immudb.readWrite((tx) =>
      tx.exec("UPDATE ledger_entries SET kind = 'adjustment' WHERE id = @id", {
        id: posted.entryId,
      }),
    );
    await expect(adapter.findMutations()).resolves.toEqual(
      expect.arrayContaining([{ table: 'ledger_entries', id: posted.entryId, rev: 2n }]),
    );
    const now = await adapter.advanceTrustedState(trusted);
    // A new, valid revision with the same payload_hash: verification passes, R2 above caught it.
    await expect(
      adapter.verifyEntry(posted.entryId, posted.payloadHash, now),
    ).resolves.toBeUndefined();
    await expect(adapter.getEntry(CHARGE_DRAFT.tenantId, posted.entryId)).resolves.toMatchObject({
      kind: 'adjustment',
    });
  });
});
