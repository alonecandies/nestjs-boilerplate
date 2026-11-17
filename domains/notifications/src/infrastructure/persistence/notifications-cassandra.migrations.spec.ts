import { loadCqlMigrations } from '@platform/cassandra';
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATIONS_TTL_SEC,
  notificationsCassandraMigrations,
} from './notifications-cassandra.migrations.js';

describe('notifications CQL migrations', () => {
  const migrations = loadCqlMigrations([notificationsCassandraMigrations]);

  it('are found next to the descriptor and ordered', () => {
    expect(migrations.map((m) => m.file)).toEqual([
      expect.stringMatching(/001_create_notifications\.cql$/),
      expect.stringMatching(/002_create_notification_recipients\.cql$/),
      expect.stringMatching(/003_create_notification_recipients_by_tenant\.cql$/),
      expect.stringMatching(/004_create_notifications_by_tenant_user\.cql$/),
      expect.stringMatching(/005_drop_user_keyed_tables\.cql$/),
    ]);
  });

  it('create tables with idempotent, single-statement DDL (001-004)', () => {
    for (const migration of migrations.slice(0, 4)) {
      expect(migration.statements).toHaveLength(1);
      expect(migration.statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS /);
    }
  });

  it('define the (tenant, user) inbox exactly as the queries expect', () => {
    const [inbox] = migrations[3]?.statements ?? [];
    expect(inbox).toMatch(/^CREATE TABLE IF NOT EXISTS notifications_by_tenant_user \(/);
    expect(inbox).toContain('PRIMARY KEY ((tenant_id, user_id), notification_id)');
    expect(inbox).toContain('CLUSTERING ORDER BY (notification_id DESC)');
    expect(inbox).toContain('default_time_to_live = 7776000');
    // markRead computes the remaining lifetime from this constant: keep both in sync.
    expect(inbox).toContain(`default_time_to_live = ${NOTIFICATIONS_TTL_SEC}`);
  });

  it('drop exactly the two user-keyed tables last (005), idempotently', () => {
    expect(migrations[4]?.statements).toEqual([
      'DROP TABLE IF EXISTS notifications_by_user',
      'DROP TABLE IF EXISTS notification_recipients',
    ]);
  });

  it('key the recipients projection by (tenant, user)', () => {
    const [recipients] = migrations[2]?.statements ?? [];
    expect(recipients).toMatch(/^CREATE TABLE IF NOT EXISTS notification_recipients_by_tenant \(/);
    expect(recipients).toContain('PRIMARY KEY ((tenant_id, user_id))');
  });
});
