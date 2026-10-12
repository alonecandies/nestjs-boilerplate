import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
});
