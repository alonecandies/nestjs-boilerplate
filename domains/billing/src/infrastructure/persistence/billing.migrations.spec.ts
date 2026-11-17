import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PLATFORM_TENANT_ID } from '@platform/common';
import { MIGRATIONS_TABLE } from '@platform/database';
import { describeOutboxTable } from '@platform/outbox/testing';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import drizzleConfig from '../../../drizzle.config.js';
import { billingMigrations } from './billing.migrations.js';
import {
  billingPgSchema,
  billingSchema,
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
    expect([payments, stripeEvents, outbox].map((table) => getTableConfig(table).schema)).toEqual([
      'billing',
      'billing',
      'billing',
    ]);
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

  describe('0001_tenant_columns (hand-edited)', () => {
    const text = readFileSync(join(billingMigrations.folder, '0001_tenant_columns.sql'), 'utf8');

    it('backfills rows that predate tenancy to the platform tenant, then drops the default', () => {
      for (const table of ['payments', 'stripe_events']) {
        expect(text).toContain(
          `ALTER TABLE "billing"."${table}" ADD COLUMN "tenant_id" uuid DEFAULT '${PLATFORM_TENANT_ID}'::uuid NOT NULL;`,
        );
        expect(text).toContain(
          `ALTER TABLE "billing"."${table}" ALTER COLUMN "tenant_id" DROP DEFAULT;`,
        );
      }
    });

    it('drops the old column-level primary keys before adding the tenant-leading ones', () => {
      for (const table of ['payments', 'stripe_events']) {
        const drop = text.indexOf(
          `ALTER TABLE "billing"."${table}" DROP CONSTRAINT "${table}_pkey";`,
        );
        const add = text.indexOf(
          `ADD CONSTRAINT "${table}_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")`,
        );
        expect(drop).toBeGreaterThanOrEqual(0);
        expect(add).toBeGreaterThan(drop);
      }
    });

    it('adds the three ledger payment statuses (ledger design S-6, D5)', () => {
      for (const value of ['refunded', 'partially_refunded', 'disputed']) {
        expect(text).toContain(`ALTER TYPE "billing"."payment_status" ADD VALUE '${value}';`);
      }
    });
  });

  describe('0002_distribute (custom, sharding design SH-6)', () => {
    const file = join(billingMigrations.folder, '0002_distribute.sql');
    const journal = JSON.parse(
      readFileSync(join(billingMigrations.folder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };

    it('is the third journal entry', () => {
      expect(journal.entries.map((entry) => entry.tag).slice(0, 3)).toEqual([
        '0000_init',
        '0001_tenant_columns',
        '0002_distribute',
      ]);
    });

    it('holds only the tenant distribution calls, payments then stripe_events', () => {
      // Comments aside, every statement is one `SELECT app.*(…)` call (sharding design §4.2).
      const calls = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith('--') && line.trim() !== '')
        .map((line) => line.replace('--> statement-breakpoint', '').trim());
      expect(calls).toEqual([
        "SELECT app.distribute_by_tenant('billing.payments');",
        "SELECT app.distribute_by_tenant('billing.stripe_events');",
      ]);
    });
  });

  describe('0003_rls (custom, B3-5/B3-6: forced RLS, explicit grants, the §8.2 billing policies)', () => {
    const journal = JSON.parse(
      readFileSync(join(billingMigrations.folder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    // Comments dropped, whitespace collapsed: one entry per statement, as drizzle splits them.
    const statements = readFileSync(join(billingMigrations.folder, '0003_rls.sql'), 'utf8')
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

    it('is the fourth journal entry', () => {
      expect(journal.entries.map((entry) => entry.tag).slice(0, 4)).toEqual([
        '0000_init',
        '0001_tenant_columns',
        '0002_distribute',
        '0003_rls',
      ]);
    });

    it('calls the app.* helpers directly: no subquery in any policy', () => {
      const policies = statements.filter((statement) => statement.startsWith('CREATE POLICY'));
      expect(policies).toHaveLength(5);
      for (const policy of policies) {
        expect(policy).not.toMatch(/\(\s*select/i);
      }
    });

    it('grants one table (or schema) to one role per statement, and changes no default privilege', () => {
      const grants = statements.filter((statement) => /^(GRANT|REVOKE)\b/.test(statement));
      expect(grants).toHaveLength(5);
      for (const grant of grants) {
        expect(grant).toMatch(
          /^GRANT [A-Z, ]+ ON (SCHEMA billing|TABLE billing\.[a-z_]+) TO (app_runtime|app_system);$/,
        );
      }
      const text = statements.join('\n');
      expect(text).not.toMatch(/DEFAULT PRIVILEGES/i);
      expect(text).not.toMatch(/__drizzle_migrations/);
      expect(text).not.toMatch(/\bPUBLIC\b/);
    });

    it('holds exactly: forced RLS on both tables, the five policies of the plan, then the grants', () => {
      expect(statements).toEqual([
        'ALTER TABLE billing.payments ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE billing.payments FORCE ROW LEVEL SECURITY;',
        'ALTER TABLE billing.stripe_events ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE billing.stripe_events FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY payments_select ON billing.payments FOR SELECT TO app_runtime USING (tenant_id = app.tenant_id() AND (user_id = app.user_id() OR app.elevated()));',
        'CREATE POLICY payments_insert ON billing.payments FOR INSERT TO app_runtime WITH CHECK (tenant_id = app.tenant_id() AND user_id = app.user_id());',
        'CREATE POLICY payments_update ON billing.payments FOR UPDATE TO app_runtime USING (tenant_id = app.tenant_id() AND user_id = app.user_id()) WITH CHECK (tenant_id = app.tenant_id() AND user_id = app.user_id());',
        'CREATE POLICY stripe_events_select ON billing.stripe_events FOR SELECT TO app_runtime USING (tenant_id = app.tenant_id() AND user_id = app.user_id());',
        'CREATE POLICY stripe_events_insert ON billing.stripe_events FOR INSERT TO app_runtime WITH CHECK (tenant_id = app.tenant_id() AND user_id = app.user_id());',
        'GRANT USAGE ON SCHEMA billing TO app_runtime;',
        'GRANT USAGE ON SCHEMA billing TO app_system;',
        'GRANT SELECT, INSERT, UPDATE ON TABLE billing.payments TO app_runtime;',
        'GRANT SELECT, INSERT ON TABLE billing.stripe_events TO app_runtime;',
        'GRANT SELECT, INSERT, DELETE ON TABLE billing.stripe_events TO app_system;',
      ]);
    });
  });

  describe('0004_outbox (outbox plan Task 6: the "Outbox table" SQL, in migration order)', () => {
    it('is the fifth and last journal entry: the first billing migration after B3', () => {
      expect(journalTags()).toEqual([
        '0000_init',
        '0001_tenant_columns',
        '0002_distribute',
        '0003_rls',
        '0004_outbox',
      ]);
    });

    it('is the plan SQL for billing.outbox, one statement each: CREATE, distribution, indexes, RLS, grants, policy', () => {
      expect(statementsOf('0004_outbox.sql')).toEqual([
        'CREATE TABLE "billing"."outbox" ( "tenant_id" uuid NOT NULL, "id" uuid NOT NULL, "topic" text NOT NULL, "key" text, "envelope" jsonb NOT NULL, "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL, "published_at" timestamp (3) with time zone, CONSTRAINT "outbox_tenant_id_id_pk" PRIMARY KEY("tenant_id","id") );',
        "SELECT app.distribute_by_tenant('billing.outbox');",
        'CREATE INDEX "outbox_unpublished_idx" ON "billing"."outbox" USING btree ("created_at","id") WHERE "billing"."outbox"."published_at" IS NULL;',
        'CREATE INDEX "outbox_published_at_idx" ON "billing"."outbox" USING btree ("published_at") WHERE "billing"."outbox"."published_at" IS NOT NULL;',
        'ALTER TABLE "billing"."outbox" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "billing"."outbox" FORCE ROW LEVEL SECURITY;',
        'GRANT INSERT ON "billing"."outbox" TO app_runtime;',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."outbox" TO app_system;',
        'CREATE POLICY "outbox_insert" ON "billing"."outbox" FOR INSERT TO app_runtime WITH CHECK (tenant_id = app.tenant_id());',
      ]);
    });
  });
});
