import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MIGRATIONS_TABLE } from '@platform/database';
import { describeOutboxTable } from '@platform/outbox/testing';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import drizzleConfig from '../../../drizzle.config.js';
import { billingMigrations } from './billing.migrations.js';
import {
  billingPgSchema,
  billingSchema,
  ledgerAccounts,
  ledgerDiscrepancies,
  ledgerEntryRefs,
  ledgerReanchors,
  ledgerReconciliationRuns,
  ledgerTrustedState,
  outbox,
  paymentStatusEnum,
  payments,
  stripeEvents,
} from './billing.schema.js';

describeOutboxTable(outbox, 'billing');

/** A migration file's statements: comments dropped, whitespace collapsed, one entry per breakpoint. */
const statementsOf = (file: string): string[] =>
  readFileSync(join(billingMigrations.folder, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((statement) => statement !== '');

const journalTags = (): string[] =>
  (
    JSON.parse(readFileSync(join(billingMigrations.folder, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    }
  ).entries.map((entry) => entry.tag);

/** The five ledger tables (outbox plan "Ledger tables", L-10): three tenant tables, two local. */
const LEDGER_TENANT_TABLES = [
  'ledger_accounts',
  'ledger_entry_refs',
  'ledger_discrepancies',
] as const;
const LEDGER_TABLES = [
  ...LEDGER_TENANT_TABLES,
  'ledger_reconciliation_runs',
  'ledger_trusted_state',
] as const;

describe('billingMigrations', () => {
  it("is billing's own history: ./migrations, bookkeeping in billing.__drizzle_migrations", () => {
    expect(billingMigrations).toEqual({
      name: 'billing',
      folder: join(import.meta.dirname, 'migrations'),
      migrationsSchema: 'billing',
      migrationsTable: MIGRATIONS_TABLE,
    });
  });

  it('keeps every billing table and enum in the billing Postgres schema', () => {
    expect(billingPgSchema.schemaName).toBe(billingMigrations.migrationsSchema);
    const tables = [
      payments,
      stripeEvents,
      outbox,
      ledgerAccounts,
      ledgerEntryRefs,
      ledgerDiscrepancies,
      ledgerReconciliationRuns,
      ledgerTrustedState,
      ledgerReanchors,
    ];
    expect(tables.map((table) => getTableConfig(table).schema)).toEqual(
      tables.map(() => 'billing'),
    );
    expect(paymentStatusEnum.schema).toBe('billing');
  });

  it('registers the outbox as billingOutbox: the monolith spreads every schema into one object', () => {
    expect(billingSchema.billingOutbox).toBe(outbox);
    expect(Object.keys(billingSchema)).not.toContain('outbox');
  });

  it('matches drizzle.config.ts: output folder, schema filter, bookkeeping table', () => {
    expect(resolve(drizzleConfig.out ?? '')).toBe(billingMigrations.folder);
    expect(drizzleConfig.schemaFilter).toEqual([billingMigrations.migrationsSchema]);
    expect(drizzleConfig.migrations).toEqual({
      schema: billingMigrations.migrationsSchema,
      table: billingMigrations.migrationsTable,
    });
  });

  it('creates its schema idempotently and carries the former 0002 purge index', () => {
    const baseline = readFileSync(join(billingMigrations.folder, '0000_init.sql'), 'utf8');
    expect(baseline).toContain('CREATE SCHEMA IF NOT EXISTS "billing";');
    expect(baseline).not.toMatch(/^CREATE SCHEMA "billing";/m);
    expect(baseline).toContain(
      'CREATE INDEX "stripe_events_processed_at_idx" ON "billing"."stripe_events"',
    );
  });

  describe('0000_init (the final squash, SH-12: one baseline in the sharding design order)', () => {
    const statements = (): string[] => statementsOf('0000_init.sql');
    /** The statement index of each `CREATE TABLE`, by table name. */
    const creates = (): [string, number][] =>
      statements()
        .map((statement, index) => [
          statement.match(/^CREATE TABLE "billing"\."(\w+)"/)?.[1],
          index,
        ])
        .filter((entry): entry is [string, number] => entry[0] !== undefined);
    const firstIndexOf = (pattern: RegExp): number =>
      statements().findIndex((statement) => pattern.test(statement));

    it('keeps the last stacked migration timestamp, so a database migrated before the squash skips it', () => {
      const read = (folder: string): number[] =>
        (
          JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
            entries: { when: number }[];
          }
        ).entries.map((entry) => entry.when);

      const stacked = read(
        join(import.meta.dirname, '..', '..', '..', 'test', 'stacked-history', 'migrations'),
      );

      expect(read(billingMigrations.folder)[0]).toBe(stacked.at(-1));
    });

    it('is the first journal entry; every entry has its snapshot', () => {
      expect(journalTags()).toEqual(['0000_init', '0001_ledger_reanchors']);
      expect(readdirSync(join(billingMigrations.folder, 'meta')).toSorted()).toEqual([
        '0000_snapshot.json',
        '0001_snapshot.json',
        '_journal.json',
      ]);
    });

    it('creates the enum with every status, the ledger ones (S-6, D5) last', () => {
      expect(statements()).toContain(
        "CREATE TYPE \"billing\".\"payment_status\" AS ENUM('pending', 'succeeded', 'failed', 'expired', 'refunded', 'partially_refunded', 'disputed');",
      );
    });

    it('creates the tables tenant-first: tenant-leading keys, no column default for tenant_id', () => {
      const text = statements().join('\n');
      expect(text).toContain('CONSTRAINT "payments_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")');
      expect(text).toContain(
        'CONSTRAINT "stripe_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")',
      );
      expect(text).toContain(
        'CREATE UNIQUE INDEX "payments_tenant_id_stripe_checkout_session_id_uq" ON "billing"."payments" USING btree ("tenant_id","stripe_checkout_session_id");',
      );
      expect(text).toContain(
        'CREATE UNIQUE INDEX "payments_tenant_id_user_id_idempotency_key_uq" ON "billing"."payments" USING btree ("tenant_id","user_id","idempotency_key");',
      );
      expect(text).toContain('"amount_refunded" bigint DEFAULT 0 NOT NULL');
      expect(text).toContain('"read_at" timestamp (3) with time zone,');
      expect(text).not.toMatch(/"tenant_id" uuid DEFAULT/);
      expect(text).not.toMatch(/ALTER TABLE "billing"\.\S+ (ADD|DROP|ALTER) COLUMN/);
    });

    it('distributes the six tenant tables right after their CREATE, and neither local table', () => {
      expect(creates().map(([table]) => table)).toEqual([
        'payments',
        'stripe_events',
        'outbox',
        ...LEDGER_TABLES,
      ]);
      const distributed = ['payments', 'stripe_events', 'outbox', ...LEDGER_TENANT_TABLES];
      expect(statements().filter((statement) => /^SELECT app\./.test(statement))).toEqual(
        distributed.map((table) => `SELECT app.distribute_by_tenant('billing.${table}');`),
      );
      for (const [table, index] of creates()) {
        const next = statements()[index + 1];
        if (distributed.includes(table)) {
          expect(next).toBe(`SELECT app.distribute_by_tenant('billing.${table}');`);
        } else {
          expect(next).not.toMatch(/app\.distribute_/);
        }
      }
    });

    it('creates every table, distribution and index before the RLS, grants, then policies', () => {
      const lastStructural = statements().findLastIndex((statement) =>
        /^(CREATE TABLE|CREATE (UNIQUE )?INDEX|SELECT app\.)/.test(statement),
      );
      const rls = firstIndexOf(/ROW LEVEL SECURITY;$/);
      const grants = firstIndexOf(/^GRANT /);
      const policies = firstIndexOf(/^CREATE POLICY /);
      expect(lastStructural).toBeLessThan(rls);
      expect(rls).toBeLessThan(grants);
      expect(grants).toBeLessThan(policies);
    });

    it('adds no foreign key, no default privilege, no REVOKE and nothing for PUBLIC', () => {
      const text = statements().join('\n');
      expect(text).not.toMatch(/FOREIGN KEY|REFERENCES/i);
      expect(text).not.toMatch(/DEFAULT PRIVILEGES|\bREVOKE\b|\bPUBLIC\b|__drizzle_migrations/i);
    });

    it('enables and forces RLS on all eight billing tables, one table per statement', () => {
      expect(statements().filter((statement) => /ROW LEVEL SECURITY;$/.test(statement))).toEqual(
        ['payments', 'stripe_events', 'outbox', ...LEDGER_TABLES].flatMap((table) => [
          `ALTER TABLE billing.${table} ENABLE ROW LEVEL SECURITY;`,
          `ALTER TABLE billing.${table} FORCE ROW LEVEL SECURITY;`,
        ]),
      );
    });

    it('grants one table (or schema) to one role per statement (B3-5/B3-6, G-1, L-10, spec §9 item 9)', () => {
      const grants = statements().filter((statement) => /^(GRANT|REVOKE)\b/.test(statement));
      expect(grants).toEqual([
        'GRANT USAGE ON SCHEMA billing TO app_runtime;',
        'GRANT USAGE ON SCHEMA billing TO app_system;',
        'GRANT SELECT, INSERT, UPDATE ON TABLE billing.payments TO app_runtime;',
        'GRANT SELECT ON TABLE billing.payments TO app_system;',
        'GRANT SELECT, INSERT ON TABLE billing.stripe_events TO app_runtime;',
        'GRANT SELECT, INSERT, DELETE ON TABLE billing.stripe_events TO app_system;',
        'GRANT INSERT ON TABLE billing.outbox TO app_runtime;',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE billing.outbox TO app_system;',
        ...LEDGER_TENANT_TABLES.flatMap((table) => [
          `GRANT SELECT, INSERT ON TABLE billing.${table} TO app_runtime;`,
          `GRANT SELECT, INSERT ON TABLE billing.${table} TO app_system;`,
        ]),
        'GRANT SELECT, INSERT, UPDATE ON TABLE billing.ledger_reconciliation_runs TO app_system;',
        'GRANT SELECT, INSERT, UPDATE ON TABLE billing.ledger_trusted_state TO app_system;',
      ]);
      for (const grant of grants) {
        expect(grant).toMatch(
          /^GRANT [A-Z, ]+ ON (SCHEMA billing|TABLE billing\.[a-z_]+) TO (app_runtime|app_system);$/,
        );
      }
    });

    it('holds exactly the §8.2 billing, outbox and ledger policies, row-local (no subquery)', () => {
      const policies = statements().filter((statement) => statement.startsWith('CREATE POLICY'));
      expect(policies).toEqual([
        'CREATE POLICY payments_select ON billing.payments FOR SELECT TO app_runtime USING (tenant_id = app.tenant_id() AND (user_id = app.user_id() OR app.elevated()));',
        'CREATE POLICY payments_insert ON billing.payments FOR INSERT TO app_runtime WITH CHECK (tenant_id = app.tenant_id() AND user_id = app.user_id());',
        'CREATE POLICY payments_update ON billing.payments FOR UPDATE TO app_runtime USING (tenant_id = app.tenant_id() AND user_id = app.user_id()) WITH CHECK (tenant_id = app.tenant_id() AND user_id = app.user_id());',
        'CREATE POLICY stripe_events_select ON billing.stripe_events FOR SELECT TO app_runtime USING (tenant_id = app.tenant_id() AND user_id = app.user_id());',
        'CREATE POLICY stripe_events_insert ON billing.stripe_events FOR INSERT TO app_runtime WITH CHECK (tenant_id = app.tenant_id() AND user_id = app.user_id());',
        'CREATE POLICY outbox_insert ON billing.outbox FOR INSERT TO app_runtime WITH CHECK (tenant_id = app.tenant_id());',
        ...LEDGER_TENANT_TABLES.flatMap((table) => [
          `CREATE POLICY ${table}_select ON billing.${table} FOR SELECT TO app_runtime USING (tenant_id = app.tenant_id() AND app.elevated());`,
          `CREATE POLICY ${table}_insert ON billing.${table} FOR INSERT TO app_runtime WITH CHECK (tenant_id = app.tenant_id());`,
        ]),
      ]);
      for (const policy of policies) {
        expect(policy).not.toMatch(/\(\s*select/i);
        expect(policy).not.toMatch(/\bCASE\b|\bIS NULL\b/i);
      }
    });

    it('creates billing.outbox as the outbox plan SQL: CREATE, distribution, then its two indexes', () => {
      const all = statements();
      const at = all.findIndex((statement) =>
        statement.startsWith('CREATE TABLE "billing"."outbox"'),
      );
      expect(all.slice(at, at + 4)).toEqual([
        'CREATE TABLE "billing"."outbox" ( "tenant_id" uuid NOT NULL, "id" uuid NOT NULL, "topic" text NOT NULL, "key" text, "envelope" jsonb NOT NULL, "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL, "published_at" timestamp (3) with time zone, CONSTRAINT "outbox_tenant_id_id_pk" PRIMARY KEY("tenant_id","id") );',
        "SELECT app.distribute_by_tenant('billing.outbox');",
        'CREATE INDEX "outbox_unpublished_idx" ON "billing"."outbox" USING btree ("created_at","id") WHERE "billing"."outbox"."published_at" IS NULL;',
        'CREATE INDEX "outbox_published_at_idx" ON "billing"."outbox" USING btree ("published_at") WHERE "billing"."outbox"."published_at" IS NOT NULL;',
      ]);
    });
  });

  describe('0001_ledger_reanchors (audit fixes OPS-1: the audit trail of a trusted-state re-anchor)', () => {
    const statements = (): string[] => statementsOf('0001_ledger_reanchors.sql');
    const journal = (): { tag: string; when: number }[] =>
      (
        JSON.parse(
          readFileSync(join(billingMigrations.folder, 'meta', '_journal.json'), 'utf8'),
        ) as { entries: { tag: string; when: number }[] }
      ).entries;

    it('comes after the baseline in the journal (a later timestamp)', () => {
      const [baseline, reanchors] = journal();
      expect(reanchors?.tag).toBe('0001_ledger_reanchors');
      expect(reanchors?.when ?? 0).toBeGreaterThan(baseline?.when ?? Number.POSITIVE_INFINITY);
    });

    it('creates billing.ledger_reanchors and its lookup index, coordinator-local (no distribution call)', () => {
      const [create, index, ...rest] = statements();
      expect(create).toBe(
        'CREATE TABLE "billing"."ledger_reanchors" ( "id" uuid NOT NULL, "database" text NOT NULL, "replaced_tx_id" bigint NOT NULL, "replaced_tx_hash" "bytea" NOT NULL, "new_tx_id" bigint NOT NULL, "new_tx_hash" "bytea" NOT NULL, "lost_from" timestamp (3) with time zone NOT NULL, "operator" text NOT NULL, "reason" text NOT NULL, "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL, CONSTRAINT "ledger_reanchors_id_pk" PRIMARY KEY("id") );',
      );
      expect(index).toBe(
        'CREATE INDEX "ledger_reanchors_database_created_at_idx" ON "billing"."ledger_reanchors" USING btree ("database","created_at");',
      );
      expect(rest.join('\n')).not.toMatch(/app\.distribute_|CREATE TABLE|ALTER TABLE "billing"\./);
    });

    it('forces RLS without a policy and grants INSERT and SELECT to app_system only (append-only)', () => {
      const text = statements().join('\n');
      expect(statements().filter((statement) => /ROW LEVEL SECURITY;$/.test(statement))).toEqual([
        'ALTER TABLE billing.ledger_reanchors ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE billing.ledger_reanchors FORCE ROW LEVEL SECURITY;',
      ]);
      expect(statements().filter((statement) => /^(GRANT|REVOKE)\b/.test(statement))).toEqual([
        'GRANT SELECT, INSERT ON TABLE billing.ledger_reanchors TO app_system;',
      ]);
      expect(text).not.toMatch(/CREATE POLICY|app_runtime|UPDATE|DELETE|FOREIGN KEY|REFERENCES/i);
      expect(text).not.toMatch(/DEFAULT PRIVILEGES|\bPUBLIC\b|__drizzle_migrations/i);
    });
  });
});
