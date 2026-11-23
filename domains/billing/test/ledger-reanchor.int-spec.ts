import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  LEDGER_POSTING_REQUESTED_EVENT,
  type LedgerPostingRequestedPayload,
} from '@domain/billing-contracts';
import { Global, Module } from '@nestjs/common';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { RbacModule } from '@platform/auth';
import { PLATFORM_TENANT_ID, SystemContext } from '@platform/common';
import type { OutboxConfig } from '@platform/config';
import { AppConfigModule } from '@platform/config';
import { createEventEnvelope, type EventEnvelope, parseEventEnvelope } from '@platform/contracts';
import { SYSTEM_DATABASE, type SystemDatabase } from '@platform/database';
import {
  IMMUDB_TEST_IMAGE,
  ImmudbClient,
  ImmudbModule,
  type ImmudbState,
  type ImmudbTx,
  type ImmudbValue,
} from '@platform/immudb';
import { OutboxRelay } from '@platform/outbox';
import { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import type Stripe from 'stripe';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { r4EnvelopeId } from '../src/application/commands/reconcile-ledger/checks/r4-stripe.js';
import { ReconcileLedgerCommand } from '../src/application/commands/reconcile-ledger/reconcile-ledger.command.js';
import type { PostingBalanceTransaction } from '../src/application/ledger/posting-rules.js';
import { BILLING_RBAC } from '../src/billing.permissions.js';
import { BillingMessagingModule } from '../src/billing-messaging.module.js';
import { ledgerEntryId } from '../src/domain/ledger/ledger.ids.js';
import { billingLedgerMigrations } from '../src/infrastructure/ledger/billing-ledger.migrations.js';
import { billingMigrations } from '../src/infrastructure/persistence/billing.migrations.js';
import type { BillingSchema } from '../src/infrastructure/persistence/billing.schema.js';
import { BILLING_OUTBOX } from '../src/infrastructure/persistence/billing-outbox.js';
import { BillingOutboxSystemRepository } from '../src/infrastructure/persistence/drizzle-outbox.system-repository.js';
import { type LedgerSource, StripeService } from '../src/infrastructure/stripe/stripe.service.js';
import { runLedgerReanchorCli } from '../src/presentation/cli/ledger-reanchor-cli.js';
import { LedgerPostingConsumer } from '../src/presentation/messaging/ledger-posting.consumer.js';
import { type BillingDatabase, startBillingDatabase } from './billing-database.js';
import { TEST_WEBHOOK_SECRET } from './billing-test.utils.js';

/*
 * OPS-1 (audit fixes plan Task 5): an immudb restore and the audited re-anchor of
 * billing.ledger_trusted_state, on Citus 14.2 (local execution off) and two immudb 1.11.2 servers
 * started with the same `--signingKey` (the original and the restored one, the same database
 * name). The ledger runs through the real BillingMessagingModule (LEDGER_ENABLED=true,
 * LEDGER_VERIFY=true) over one `ImmudbClient` the spec switches from the original server to the
 * restored one. Postings go through the real consumer (two platform payouts, A and B). The
 * re-anchor runs through the real CLI body (`runLedgerReanchorCli`, its own Nest context over the
 * same Postgres and the restored server, pinned to no key, another key or the right one). Only
 * Stripe, Kafka and the relay's lock are fakes.
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project billing:int ledger-reanchor
 */

const DATABASE = 'ledger_reanchor_it';
const CREATED = 1_794_182_400;

const pem = (key: KeyObject): string => key.export({ type: 'spki', format: 'pem' }).toString();
const base64 = (text: string): string => Buffer.from(text).toString('base64');

async function startImmudb(signingKeyPem: string): Promise<StartedTestContainer> {
  return (
    new GenericContainer(IMMUDB_TEST_IMAGE)
      .withEnvironment({ IMMUDB_PGSQL_SERVER: 'false' })
      .withExposedPorts(3322, 9497)
      .withWaitStrategy(Wait.forHttp('/readyz', 9497))
      // SEC1 "EC PRIVATE KEY" PEM, as immudb's pkg/signer/ecdsa.go parses it.
      .withCopyContentToContainer([
        { content: signingKeyPem, target: '/keys/signing.key', mode: 0o644 },
      ])
      .withCommand(['--signingKey=/keys/signing.key'])
      .start()
  );
}

/** The one `ImmudbClient` of the app: every call goes to `target`, which the spec switches. */
class SwitchableImmudbClient extends ImmudbClient {
  constructor(public target: ImmudbClient | null = null) {
    super();
  }

  private get client(): ImmudbClient {
    if (this.target === null) throw new Error('no immudb client selected');
    return this.target;
  }

  override readWrite<T>(work: (tx: ImmudbTx) => Promise<T>) {
    return this.client.readWrite(work);
  }

  override readOnly<T>(work: (tx: ImmudbTx) => Promise<T>, opts?: { mustIncludeTxId?: bigint }) {
    return this.client.readOnly(work, opts);
  }

  override currentState() {
    return this.client.currentState();
  }

  override verifyConsistency(trusted: ImmudbState, target: ImmudbState) {
    return this.client.verifyConsistency(trusted, target);
  }

  override verifiedRow(table: string, pk: readonly ImmudbValue[], trusted: ImmudbState) {
    return this.client.verifiedRow(table, pk, trusted);
  }

  override pinsSigningKey() {
    return this.client.pinsSigningKey();
  }
}

const switchable = new SwitchableImmudbClient();

@Global()
@Module({
  providers: [
    { provide: KafkaProducer, useValue: new FakeKafkaProducer({ source: 'billing' }) },
    { provide: ImmudbClient, useValue: switchable },
  ],
  exports: [KafkaProducer, ImmudbClient],
})
class FakeInfrastructureModule {}

const payout = (id: string, amount: number): PostingBalanceTransaction => ({
  id,
  amount,
  fee: 0,
  currency: 'usd',
  created: CREATED,
  reporting_category: 'payout',
  source: id.replace('txn_', 'po_'),
});

/** Payout A (kept by the restore) and payout B (lost by it). */
const TXN_A = payout('txn_rn_a', -5_000);
const TXN_B = payout('txn_rn_b', -7_000);

const SOURCE_A: LedgerSource = { transactions: [TXN_A], pending: false, presentment: null };
const SOURCE_B: LedgerSource = { transactions: [TXN_B], pending: false, presentment: null };
/** What the fake Stripe answers per object id: the payout, or (R4's re-enqueue) its transaction. */
const SOURCES: Readonly<Record<string, LedgerSource>> = {
  [TXN_A.source as string]: SOURCE_A,
  [TXN_A.id]: SOURCE_A,
  [TXN_B.source as string]: SOURCE_B,
  [TXN_B.id]: SOURCE_B,
};

/** What the fake Stripe lists for any window: both payouts' balance transactions. */
const LISTED = [TXN_A, TXN_B].map(
  (posting) =>
    ({
      ...posting,
      object: 'balance_transaction',
      net: posting.amount - posting.fee,
      source: { id: posting.source, object: 'payout' },
    }) as unknown as Stripe.BalanceTransaction,
);

const fakeStripe = () => {
  vi.spyOn(StripeService.prototype, 'ledgerSource').mockImplementation(async (_type, id) => {
    const source = SOURCES[id];
    if (source === undefined) throw new Error(`the fake Stripe knows no ${id}`);
    return source;
  });
  vi.spyOn(StripeService.prototype, 'listBalanceTransactions').mockImplementation(
    async function* () {
      yield* LISTED;
    },
  );
};

const posting = (
  txn: PostingBalanceTransaction,
  id: string,
): EventEnvelope<LedgerPostingRequestedPayload> =>
  createEventEnvelope(
    LEDGER_POSTING_REQUESTED_EVENT,
    {
      source: 'stripe',
      livemode: false,
      stripeEventId: `evt_${txn.id}`,
      stripeEventType: 'payout.paid',
      objectType: 'payout',
      objectId: txn.source as string,
      tenantId: PLATFORM_TENANT_ID,
      userId: null,
      paymentId: null,
    },
    { id, actorId: null, tenantId: PLATFORM_TENANT_ID, source: 'billing' },
  );

const POSTING_A = posting(TXN_A, '0197d600-0000-5000-8000-00000000e00a');
const POSTING_B = posting(TXN_B, '0197d600-0000-5000-8000-00000000e00b');
const ENTRY_B = ledgerEntryId(`stripe:txn:${TXN_B.id}`);

const RELAY: OutboxConfig = {
  relayEnabled: true,
  pollIntervalMs: 100,
  batchSize: 100,
  lockTtlMs: 1_000,
  maxBackoffMs: 1_000,
  retentionHours: 168,
};

type RunView = { id: string; status: string; counts: unknown };
type DiscrepancyView = { kind: string; source_key: string; detected_by: string };
type ReanchorView = {
  database: string;
  replaced_tx_id: string;
  replaced_tx_hash: string;
  new_tx_id: string;
  new_tx_hash: string;
  lost_from: Date;
  operator: string;
  reason: string;
};
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'OPS-1: an immudb restore and the audited re-anchor of the trusted state',
  () => {
    const signing = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const signingPrivatePem = signing.privateKey.export({ type: 'sec1', format: 'pem' }).toString();
    const pinned = base64(pem(signing.publicKey));
    const otherKey = base64(pem(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey));

    let original: StartedTestContainer | undefined;
    let restored: StartedTestContainer | undefined;
    let database: BillingDatabase | undefined;
    let commands: CommandBus;
    let restoredClient: ImmudbClient;
    const modules: TestingModule[] = [];
    /**
     * Set by (1): where the restore's lost history starts (20 minutes back, before A: the re-anchor
     * refuses a lost-from inside the reconcile grace, review #3; earlier is allowed), and B's ref's
     * tx id in it.
     */
    let lostFrom: Date;
    let lostTxIdOfB: bigint;

    const db = () => database ?? expect.fail('no database');
    const asSystem = <T>(fn: () => Promise<T>) => SystemContext.run('billing.reanchor-it', fn);
    const consume = (envelope: EventEnvelope<LedgerPostingRequestedPayload>) =>
      db().app.get(LedgerPostingConsumer, { strict: false }).onLedgerPosting(envelope);
    const reconcile = () => asSystem(() => commands.execute(new ReconcileLedgerCommand()));

    /** A real client of `container`'s database, pinned to `key` (none: no key). */
    const clientOn = async (
      container: StartedTestContainer,
      options: { key?: string; migrate?: boolean } = {},
    ): Promise<ImmudbClient> => {
      const env: Record<string, string | undefined> = {
        IMMUDB_ADDRESS: `${container.getHost()}:${container.getMappedPort(3322)}`,
        IMMUDB_DATABASE: DATABASE,
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
      return moduleRef.get(ImmudbClient);
    };

    const runs = async (): Promise<RunView[]> => [
      ...(await db().superuser.execute<RunView>(sql`
        select id, status, counts from billing.ledger_reconciliation_runs
        order by created_at, id`)),
    ];
    const discrepancies = async (): Promise<DiscrepancyView[]> => [
      ...(await db().superuser.execute<DiscrepancyView>(sql`
        select kind, source_key, detected_by from billing.ledger_discrepancies
        order by kind, source_key`)),
    ];
    const trustedRow = async () => {
      const [row] = await db().superuser.execute<{
        tx_id: string;
        tx_hash: Buffer;
        read_at: Date | null;
      }>(
        sql`select tx_id::text as tx_id, tx_hash, read_at from billing.ledger_trusted_state
            where database = ${DATABASE}`,
      );
      return row === undefined
        ? null
        : {
            txId: BigInt(row.tx_id),
            txHash: Buffer.from(row.tx_hash).toString('hex'),
            readAt: row.read_at,
          };
    };
    const reanchorRows = async (): Promise<ReanchorView[]> =>
      [
        ...(await db().superuser.execute<ReanchorView>(sql`
          select database, replaced_tx_id::text as replaced_tx_id,
            encode(replaced_tx_hash, 'hex') as replaced_tx_hash, new_tx_id::text as new_tx_id,
            encode(new_tx_hash, 'hex') as new_tx_hash, lost_from, operator, reason
          from billing.ledger_reanchors order by created_at`)),
      ].map((row) => ({ ...row, lost_from: new Date(row.lost_from) }));
    /** Everything a refused re-anchor must leave as it was. */
    const writable = async () => ({
      trusted: await trustedRow(),
      reanchors: await reanchorRows(),
      runs: (await runs()).length,
    });

    /**
     * Runs the real CLI body against the restored server, its client pinned to `key` (none: no
     * key); returns its exit code and everything it printed.
     */
    const cli = async (key: string | undefined) => {
      if (restored === undefined) throw new Error('not started');
      const env: Record<string, string | undefined> = {
        IMMUDB_ADDRESS: `${restored.getHost()}:${restored.getMappedPort(3322)}`,
        IMMUDB_DATABASE: DATABASE,
        IMMUDB_RUN_MIGRATIONS: 'false',
        IMMUDB_SERVER_SIGNING_PUBLIC_KEY: key,
        LOG_PRETTY: 'false',
      };
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      process.exitCode = undefined;
      try {
        await runLedgerReanchorCli({
          migrations: [billingMigrations],
          args: [
            '--database',
            DATABASE,
            '--lost-from',
            lostFrom.toISOString(),
            '--operator',
            'ops-oncall',
            '--reason',
            'immudb restored from a backup taken before B',
          ],
        });
        const printed = (spy: typeof stdout) => spy.mock.calls.map(([chunk]) => String(chunk));
        return {
          exitCode: process.exitCode,
          lines: printed(stdout),
          output: [...printed(stdout), ...printed(stderr)].join(''),
        };
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
        process.exitCode = undefined;
      }
    };

    beforeAll(async () => {
      [original, restored] = await Promise.all([
        startImmudb(signingPrivatePem),
        startImmudb(signingPrivatePem),
      ]);
      // Both servers migrated up front: the restored one starts as the backup did, before B.
      restoredClient = await clientOn(restored, { key: pinned, migrate: true });
      switchable.target = await clientOn(original, { key: pinned, migrate: true });
      vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_billing_reanchor_int');
      vi.stubEnv('STRIPE_WEBHOOK_SECRET', TEST_WEBHOOK_SECRET);
      vi.stubEnv('LEDGER_ENABLED', 'true');
      vi.stubEnv('LEDGER_VERIFY', 'true');
      fakeStripe();
      database = await startBillingDatabase([], {
        imports: [
          FakeInfrastructureModule,
          CqrsModule.forRoot(),
          RbacModule.forRoot(),
          RbacModule.forFeature(BILLING_RBAC),
          BillingMessagingModule,
        ],
      });
      commands = database.app.get(CommandBus);
    }, 360_000);

    beforeEach(() => {
      fakeStripe();
    });

    afterAll(async () => {
      for (const moduleRef of modules) await moduleRef.close();
      await database?.close();
      await Promise.all([original?.stop(), restored?.stop()]);
    });

    it('(1) after a restore to before B, every reconciliation run fails R5 and nothing moves the trusted state', async () => {
      if (original === undefined || restored === undefined) throw new Error('not started');
      // A, then B a moment later: the restore keeps A and loses B.
      lostFrom = new Date(Date.now() - 20 * 60_000);
      await consume(POSTING_A);
      await sleep(5);
      await consume(POSTING_B);
      const [refB] = await db().superuser.execute<{ tx_id: string }>(
        sql`select immudb_tx_id::text as tx_id from billing.ledger_entry_refs
            where entry_id = ${ENTRY_B}`,
      );
      lostTxIdOfB = BigInt(refB?.tx_id ?? expect.fail('no ref for B'));
      await expect(reconcile()).resolves.toEqual({ found: {}, appended: {} });
      const trusted = await trustedRow();
      expect(trusted?.txId).toBe((await switchable.currentState()).txId);

      // The restore: the backup holds A only, posted again here by the same consumer.
      switchable.target = restoredClient;
      await consume(POSTING_A);
      expect((await switchable.currentState()).txId).toBeLessThan(trusted?.txId ?? 0n);

      for (let run = 0; run < 2; run++) {
        await reconcile();
        expect((await runs()).at(-1)?.status).toBe('failed');
        expect(await trustedRow()).toEqual(trusted);
      }
      expect(await discrepancies()).toEqual([
        { kind: 'missing_entry', source_key: `stripe:txn:${TXN_B.id}`, detected_by: 'R4' },
        { kind: 'verification_failed', source_key: `state:${DATABASE}`, detected_by: 'R5' },
      ]);
    });

    it('(2) the CLI without a pinned key, and with another key pinned, refuses and writes nothing', async () => {
      const before = await writable();

      const unpinned = await cli(undefined);
      expect(unpinned.exitCode).toBe(1);
      expect(unpinned.output).toContain('no immudb server signing key is pinned');

      const otherPinned = await cli(otherKey);
      expect(otherPinned.exitCode).toBe(1);
      expect(otherPinned.output).toContain('does not verify against the pinned key');

      expect(await writable()).toEqual(before);
      expect(before.reanchors).toEqual([]);
    });

    it('(3) with the right key: one audit row and the restored state, written together; app_runtime cannot read the audit and app_system cannot change it', async () => {
      const before = (await trustedRow()) ?? expect.fail('no trusted state');
      const state = await restoredClient.currentState();
      expect(state.txId).toBeLessThan(before.txId);

      const result = await cli(pinned);

      expect(result.exitCode).toBe(0);
      // The result line (the log lines are JSON too, with a level).
      const printed = result.lines.find((line) => line.startsWith('{"reanchorId"'));
      expect(JSON.parse(printed ?? expect.fail(result.output))).toMatchObject({
        database: DATABASE,
        replacedTxId: before.txId.toString(),
        txId: state.txId.toString(),
        reconciliation: { found: { missing_entry: 1, verification_failed: 1 } },
      });
      expect(await reanchorRows()).toEqual([
        {
          database: DATABASE,
          replaced_tx_id: before.txId.toString(),
          replaced_tx_hash: before.txHash,
          new_tx_id: state.txId.toString(),
          new_tx_hash: hex(state.txHash),
          lost_from: lostFrom,
          operator: 'ops-oncall',
          reason: 'immudb restored from a backup taken before B',
        },
      ]);
      // The follow-up run advanced it from the re-anchored state (nothing posted since).
      expect(await trustedRow()).toMatchObject({ txId: state.txId, txHash: hex(state.txHash) });

      const runtime = postgres(db().pg.runtimeUrl, { max: 1, onnotice: () => undefined });
      const system = postgres(db().pg.systemUrl, { max: 1, onnotice: () => undefined });
      const code = (work: Promise<unknown>) =>
        work.then(
          () => 'ok',
          (error: { code?: string }) => error.code,
        );
      try {
        await expect(code(runtime`select * from billing.ledger_reanchors`)).resolves.toBe('42501');
        await expect(
          code(system`update billing.ledger_reanchors set operator = 'someone else'`),
        ).resolves.toBe('42501');
        await expect(code(system`delete from billing.ledger_reanchors`)).resolves.toBe('42501');
      } finally {
        await runtime.end({ timeout: 5 });
        await system.end({ timeout: 5 });
      }
      expect(await reanchorRows()).toHaveLength(1);
    });

    it('(4) that run reports B as verification_failed and re-enqueues it; after the consumer immudb holds one B, Postgres one ref, and the next run is clean', async () => {
      const run = (await runs()).at(-1) ?? expect.fail('no run');
      expect(run).toMatchObject({
        status: 'succeeded',
        counts: { found: { missing_entry: 1, verification_failed: 1 } },
      });
      expect(await discrepancies()).toContainEqual({
        kind: 'verification_failed',
        source_key: `ledger_entries:${ENTRY_B}`,
        detected_by: 'R5',
      });
      const outbox = await db().superuser.execute<{ id: string }>(
        sql`select id from billing.outbox where published_at is null`,
      );
      expect([...outbox].map((row) => row.id)).toContain(r4EnvelopeId(run.id, TXN_B.id));

      // One relay tick publishes every re-enqueued posting of B; the consumer posts it once.
      const published = new FakeKafkaProducer({ source: 'billing-int' });
      const relay = new OutboxRelay(
        BILLING_OUTBOX,
        new BillingOutboxSystemRepository(
          db().app.get<SystemDatabase<BillingSchema>>(SYSTEM_DATABASE, { strict: false }),
        ),
        published,
        { using: () => Promise.reject(new Error('a tick takes no lock')) },
        RELAY,
        { systemPool: true },
      );
      await expect(relay.tick(new AbortController().signal)).resolves.toMatchObject({
        published: outbox.length,
        failed: false,
      });
      const records = published.published(LEDGER_POSTING_REQUESTED_EVENT);
      expect(records).toHaveLength(outbox.length);
      for (const record of records) {
        const envelope = parseEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, record.value);
        expect(envelope.payload.objectId).toBe(TXN_B.id);
        await consume(envelope);
      }

      const inImmudb = await restoredClient.readOnly((tx) =>
        tx.query<{ id: string }>('SELECT id FROM ledger_entries WHERE source_key = @source_key', {
          source_key: `stripe:txn:${TXN_B.id}`,
        }),
      );
      expect(inImmudb).toEqual([{ id: ENTRY_B }]);
      const refs = await db().superuser.execute<{ tx_id: string }>(
        sql`select immudb_tx_id::text as tx_id from billing.ledger_entry_refs
            where entry_id = ${ENTRY_B}`,
      );
      // The ref keeps the lost history's tx id: R5 verifies it by its entry, whatever the tx id.
      expect([...refs]).toEqual([{ tx_id: lostTxIdOfB.toString() }]);

      await expect(reconcile()).resolves.toEqual({ found: {}, appended: {} });
      expect((await runs()).at(-1)?.status).toBe('succeeded');
    });

    it('(5) on a healthy ledger the CLI refuses: the current state still extends the trusted one', async () => {
      const before = await writable();

      const result = await cli(pinned);

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('still extends the trusted one');
      expect(await writable()).toEqual(before);
    });
  },
);
