import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PLATFORM_TENANT_ID } from '@platform/common';
import { MIGRATIONS_TABLE } from '@platform/database';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import drizzleConfig from '../../../drizzle.config.js';
import { billingMigrations } from './billing.migrations.js';
import { billingPgSchema, paymentStatusEnum, payments, stripeEvents } from './billing.schema.js';

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
    expect([payments, stripeEvents].map((table) => getTableConfig(table).schema)).toEqual([
      'billing',
      'billing',
    ]);
    expect(paymentStatusEnum.schema).toBe('billing');
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
      expect(journal.entries.map((entry) => entry.tag)).toEqual([
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
});
