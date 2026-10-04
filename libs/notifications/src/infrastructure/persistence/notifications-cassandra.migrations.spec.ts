import { loadCqlMigrations } from '@app/cassandra';
import { describe, expect, it } from 'vitest';
import { notificationsCassandraMigrations } from './notifications-cassandra.migrations.js';

describe('notifications CQL migrations', () => {
  const migrations = loadCqlMigrations([notificationsCassandraMigrations]);

  it('are found next to the descriptor and ordered', () => {
    expect(migrations.map((m) => m.file)).toEqual([
      expect.stringMatching(/001_create_notifications\.cql$/),
      expect.stringMatching(/002_create_notification_recipients\.cql$/),
    ]);
  });

  it('are idempotent, single-statement DDL', () => {
    for (const migration of migrations) {
      expect(migration.statements).toHaveLength(1);
      expect(migration.statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS /);
    }
  });

  it('define the inbox exactly as the queries expect', () => {
    const [inbox] = migrations[0]?.statements ?? [];
    expect(inbox).toContain('PRIMARY KEY ((user_id), notification_id)');
    expect(inbox).toContain('CLUSTERING ORDER BY (notification_id DESC)');
    expect(inbox).toContain('default_time_to_live = 7776000');
  });
});
