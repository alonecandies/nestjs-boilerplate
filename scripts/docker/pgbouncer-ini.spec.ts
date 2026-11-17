import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

type Ini = Record<string, Record<string, string>>;

/** `[section]` + `key = value` lines; `;` and `#` start a comment line. */
function parseIni(text: string): Ini {
  const ini: Ini = {};
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header?.[1] !== undefined) {
      section = header[1];
      ini[section] = ini[section] ?? {};
      continue;
    }
    const eq = line.indexOf('=');
    const entries = ini[section];
    if (eq < 0 || entries === undefined) throw new Error(`unparsable ini line: ${line}`);
    entries[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return ini;
}

const ini = parseIni(read('docker/pgbouncer/pgbouncer.ini'));
const pgbouncer = ini.pgbouncer ?? {};

describe('docker/pgbouncer/pgbouncer.ini (sharding design section 5)', () => {
  it('pools per transaction, so a session setting can never outlive one', () => {
    expect(pgbouncer.pool_mode).toBe('transaction');
  });

  it('keeps prepared statements working through the pooler', () => {
    expect(pgbouncer.max_prepared_statements).toBe('200');
  });

  it('authenticates clients with SCRAM from the mounted userlist', () => {
    expect(pgbouncer.auth_type).toBe('scram-sha-256');
    expect(pgbouncer.auth_file).toBe('/etc/pgbouncer/userlist.txt');
  });

  it('ignores extra_float_digits only: any other startup parameter is refused', () => {
    // The migrator's statement_timeout startup parameter must reach PgBouncer unmasked: its 08P01
    // refusal is how the runner detects a pooled connection. Listing it here would hide that.
    expect(pgbouncer.ignore_startup_parameters).toBe('extra_float_digits');
  });

  it('caps the system role at 5 server connections', () => {
    expect(ini.users?.app_system).toBeDefined();
    const settings = Object.fromEntries(
      (ini.users?.app_system ?? '').split(/\s+/).map((pair) => pair.split('=')),
    ) as Record<string, string>;
    expect(settings.pool_size).toBe('5');
    expect(settings.max_user_connections).toBe('5');
  });

  it('sends every database to the coordinator directly, never back through itself', () => {
    expect(Object.values(ini.databases ?? {})).toEqual(['host=postgres port=5432']);
  });

  it('lets only the system role read the console statistics, and nobody administer it', () => {
    expect(pgbouncer.admin_users ?? '').toBe('');
    expect(pgbouncer.stats_users).toBe('app_system');
  });
});

describe('docker/pgbouncer/userlist.txt', () => {
  const users = read('docker/pgbouncer/userlist.txt')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith(';'))
    .map((line) => /^"([^"]+)"\s+"([^"]*)"$/.exec(line.trim())?.[1]);

  it('names exactly the two pooled app roles: never the owner, never a superuser', () => {
    expect(users.sort()).toEqual(['app_runtime', 'app_system']);
  });
});

describe('docker-compose.yml (SH §5 env)', () => {
  const compose = read('docker-compose.yml');
  const envPostgres =
    /^x-env-postgres: &env-postgres\n((?: {2}.*\n|\n)+)/m.exec(compose)?.[1] ?? '';

  it('runs the pinned PgBouncer image on the mounted directory', () => {
    expect(compose).toContain('image: edoburu/pgbouncer:v1.26.1-p0');
    expect(compose).toContain('./docker/pgbouncer:/etc/pgbouncer:ro');
    expect(compose).toMatch(/127\.0\.0\.1:\$\{PGBOUNCER_HOST_PORT:-6432\}:6432/);
  });

  it('connects the apps as the three roles: pooled runtime and system, direct owner', () => {
    expect(envPostgres).toMatch(/DATABASE_URL: postgres:\/\/app_runtime:[^@\n]+@pgbouncer:6432\//);
    expect(envPostgres).toMatch(
      /DATABASE_SYSTEM_URL: postgres:\/\/app_system:[^@\n]+@pgbouncer:6432\//,
    );
    expect(envPostgres).toMatch(
      /DATABASE_MIGRATION_URL: postgres:\/\/app_owner:[^@\n]+@postgres:5432\//,
    );
    expect(envPostgres).toContain('DATABASE_POOLER: pgbouncer');
    expect(envPostgres).toContain('DATABASE_BOOT_GUARD: enforce');
  });

  it('never points the app at PgBouncer with the superuser', () => {
    expect(envPostgres).not.toContain('POSTGRES_USER');
  });
});
