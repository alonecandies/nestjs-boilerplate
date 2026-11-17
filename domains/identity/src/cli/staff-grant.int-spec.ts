import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IdentityDatabase, startIdentityDatabase } from '../../test/identity-database.js';
import { createPostgresStaffStore } from './postgres-staff-store.js';
import { runStaffGrantCli } from './staff-grant.js';

describe('staff:grant against Postgres', () => {
  let database: IdentityDatabase;
  let url: string;

  beforeAll(async () => {
    database = await startIdentityDatabase([]);
    // The CLI connects as app_owner (DATABASE_MIGRATION_URL), through the TO app_owner policies.
    url = database.pg.migrationUrl;
    await database.admin.execute(
      sql`insert into identity.users (email, password_hash, display_name) values ('ops@example.com', 'x', 'Ops')`,
    );
  }, 180_000);

  afterAll(async () => {
    await database?.close();
  });

  const flag = async (): Promise<boolean | undefined> => {
    const [row] = await database.admin.execute<{ is_platform_staff: boolean }>(
      sql`select is_platform_staff from identity.users where email = 'ops@example.com'`,
    );
    return row?.is_platform_staff;
  };

  it('grants and revokes is_platform_staff by email; unknown emails exit 1', async () => {
    const deps = {
      env: { DATABASE_MIGRATION_URL: url },
      connect: createPostgresStaffStore,
      out: () => undefined,
      err: () => undefined,
    };
    await expect(runStaffGrantCli(['OPS@example.com'], deps)).resolves.toBe(0);
    await expect(flag()).resolves.toBe(true);
    await expect(runStaffGrantCli(['ops@example.com', '--revoke'], deps)).resolves.toBe(0);
    await expect(flag()).resolves.toBe(false);
    await expect(runStaffGrantCli(['ghost@example.com'], deps)).resolves.toBe(1);
  });
});
