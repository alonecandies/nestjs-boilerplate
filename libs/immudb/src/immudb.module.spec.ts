import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImmudbModule } from './immudb.module.js';
import type { ImmudbModuleOptions } from './immudb.types.js';
import { runImmudbMigrations } from './migrations/immudb-migrations.js';

vi.mock('./migrations/immudb-migrations.js', () => ({
  runImmudbMigrations: vi.fn(async () => ({ applied: [], skipped: [] })),
}));

const SOURCES = [{ name: 'ledger', dir: '/nowhere' }];

/** Builds the module (no session opens until a client call) and closes it again. */
async function boot(options: ImmudbModuleOptions): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [ImmudbModule.forRootAsync(options)],
  }).compile();
  await moduleRef.close();
}

describe('ImmudbModule boot migrations', () => {
  beforeEach(() => {
    vi.mocked(runImmudbMigrations).mockClear();
    vi.stubEnv('IMMUDB_ADDRESS', '127.0.0.1:1');
    vi.stubEnv('IMMUDB_ADMIN_PASSWORD', 'admin');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs them when IMMUDB_RUN_MIGRATIONS=true', async () => {
    vi.stubEnv('IMMUDB_RUN_MIGRATIONS', 'true');
    await boot({ migrations: SOURCES });
    expect(runImmudbMigrations).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runImmudbMigrations).mock.calls[0]?.[1]).toEqual(SOURCES);
  });

  it('skips them when IMMUDB_RUN_MIGRATIONS is off', async () => {
    vi.stubEnv('IMMUDB_RUN_MIGRATIONS', 'false');
    await boot({ migrations: SOURCES });
    expect(runImmudbMigrations).not.toHaveBeenCalled();
  });

  it('runMigrations overrides IMMUDB_RUN_MIGRATIONS either way', async () => {
    vi.stubEnv('IMMUDB_RUN_MIGRATIONS', 'true');
    await boot({ migrations: SOURCES, runMigrations: false });
    expect(runImmudbMigrations).not.toHaveBeenCalled();

    vi.stubEnv('IMMUDB_RUN_MIGRATIONS', 'false');
    await boot({ migrations: SOURCES, runMigrations: true });
    expect(runImmudbMigrations).toHaveBeenCalledTimes(1);
  });
});
