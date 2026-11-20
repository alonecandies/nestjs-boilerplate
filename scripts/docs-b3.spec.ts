import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B3 Task 21: the docs describe what shipped. Every list a doc repeats is read from the code that
 * owns it, so a method, a reason, a guard check or an env key added later fails here until the doc
 * names it.
 */
const root = join(import.meta.dirname, '..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

const security = read('docs/SECURITY.md');
const configuration = read('docs/CONFIGURATION.md');

/** The text of one `##`/`###` section: from its heading to the next heading of the same or higher level. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`no section "${heading}"`);
  const level = /^#+/.exec(heading)?.[0].length ?? 1;
  const length = lines
    .slice(start + 1)
    .findIndex((line) => new RegExp(`^#{1,${level}} `).test(line) && !line.startsWith('```'));
  return lines.slice(start, length === -1 ? undefined : start + 1 + length).join('\n');
}

/** First-column `code` cell of every table row. */
const firstCells = (markdown: string): string[] =>
  markdown
    .split('\n')
    .flatMap((line) => /^\| `([^`]+)`\s*\|/.exec(line)?.[1] ?? [])
    .toSorted();

/** Collapses line wraps, so a phrase matches wherever prettier broke the line. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

const quoted = (source: string, pattern: RegExp): string[] =>
  [...source.matchAll(pattern)].map((match) => match[1] ?? '');

describe('docs/SECURITY.md: the system pool', () => {
  const methods = ['identity', 'billing'].flatMap((domain) =>
    quoted(
      read(`domains/${domain}/src/infrastructure/persistence/${domain}.system-methods.ts`),
      /defineSystemMethod\(\s*'([A-Za-z.]+)',\s*'(?:pre-auth|system)',?\s*\)/g,
    ),
  );
  const scopes = new Map(
    ['identity', 'billing'].flatMap((domain) =>
      [
        ...read(
          `domains/${domain}/src/infrastructure/persistence/${domain}.system-methods.ts`,
        ).matchAll(/defineSystemMethod\(\s*'([A-Za-z.]+)',\s*'(pre-auth|system)',?\s*\)/g),
      ].map((match) => [match[1] ?? '', match[2] ?? ''] as const),
    ),
  );
  const pool = (): string => section(security, '### The system pool');

  it('lists exactly the methods of the two pinned lists', () => {
    expect(methods.length).toBeGreaterThan(0);
    expect(firstCells(pool()).filter((cell) => cell.includes('.'))).toEqual(methods.toSorted());
  });

  it('gives each method its scope', () => {
    for (const [name, scope] of scopes) {
      const row = pool()
        .split('\n')
        .find((line) => line.startsWith(`| \`${name}\``));
      expect(row?.split('|').map((cell) => cell.trim())[2], name).toBe(scope);
    }
  });

  it('names the doors: DATABASE_SYSTEM_URL, SystemContext and the unavailable and context errors', () => {
    for (const word of [
      'DATABASE_SYSTEM_URL',
      'SystemContext.run',
      'SYSTEM_DATABASE_UNAVAILABLE',
      'SYSTEM_CONTEXT_REQUIRED',
      'db_system_calls_total',
      '.system-repository.ts',
      'staff:grant',
    ]) {
      expect(pool(), word).toContain(word);
    }
  });
});

describe('docs/SECURITY.md: elevation, boot guard, SET LOCAL, PgBouncer', () => {
  it('lists the three elevation reasons of the code', () => {
    const reasons = quoted(
      read('libs/database/src/rls/rls-elevation.service.ts').split('ELEVATION_REASONS')[1] ?? '',
      /'([a-z-]+)',?\n/g,
    );
    expect(reasons.toSorted()).toEqual(
      ['membership-activity', 'tenant-bootstrap', 'verified-invitation'].toSorted(),
    );
    const elevation = section(security, '### Elevation');
    for (const reason of reasons) expect(elevation, reason).toContain(`\`${reason}\``);
    for (const word of ['elevate(permission)', 'ELEVATION_DENIED', '*.elevated.ts']) {
      expect(elevation, word).toContain(word);
    }
  });

  it('lists every boot guard check and the three modes', () => {
    const checks = quoted(
      read('libs/database/src/boot/boot-guard.ts'),
      /await check\(findings, '([a-z.-]+)'/g,
    );
    expect(checks.length).toBeGreaterThanOrEqual(11);
    const guard = section(security, '### Boot guard');
    for (const name of checks) expect(guard, name).toContain(`\`${name}\``);
    for (const mode of ['enforce', 'warn', 'off']) expect(guard, mode).toContain(`\`${mode}\``);
    expect(guard).toContain('DATABASE_BOOT_GUARD');
  });

  it('documents the string-built SET LOCAL and its validation', () => {
    const context = section(security, '### The RLS context: `SET LOCAL`');
    for (const word of [
      'RLS_UUID_PATTERN',
      'buildRlsContextSql',
      'RLS_NO_PRINCIPAL',
      'RLS_CONTEXT_STALE',
      'RLS_INVALID_USER_ID',
      'set_config',
    ]) {
      expect(context, word).toContain(word);
    }
  });

  it('documents PgBouncer auth_query and the startup-parameter rule', () => {
    const bouncer = section(security, '### PgBouncer authentication');
    for (const word of [
      'auth_query',
      'pgbouncer.get_auth',
      'auth_user',
      'ignore_startup_parameters',
      'statement_timeout',
      '08P01',
    ]) {
      expect(bouncer, word).toContain(word);
    }
  });

  it('states the trust model: co-member and cross-tenant reads are checked in application SQL', () => {
    const trust = section(security, '### Trust model');
    expect(trust).toMatch(/application SQL/);
    expect(flat(trust)).toMatch(/same trust model as the session context/);
  });
});

describe('docs/CONFIGURATION.md: the database keys of Tasks 3 and 17', () => {
  it.each([
    'DATABASE_URL',
    'DATABASE_SYSTEM_URL',
    'DATABASE_MIGRATION_URL',
    'DATABASE_SYSTEM_POOL_MAX',
    'DATABASE_POOLER',
    'DATABASE_BOOT_GUARD',
    'PGBOUNCER_HOST_PORT',
  ])('documents %s in a table row', (key) => {
    expect(firstCells(configuration)).toContain(key);
  });

  it('says which apps need which URL and that nothing falls back to DATABASE_URL', () => {
    const needs = section(configuration, '#### Which process needs which URL');
    for (const app of ['monolith', 'identity-service', 'billing-service', 'gateway']) {
      expect(needs, app).toContain(`\`${app}\``);
    }
    expect(needs).toMatch(/no fallback/i);
  });
});

describe('the B3 spec delta (ruling b3-identity-policies, 2026-11-17)', () => {
  const program = read('docs/superpowers/specs/2026-10-12-domains-tenancy-rls-program-design.md');
  const sharding = read('docs/superpowers/specs/2026-11-09-sharding-citus-pgbouncer-design.md');

  it('spec 8.2 rows for users and tenants are row-local, and no table row names a helper', () => {
    const policies = section(
      program,
      '### 8.2 Policies (amended 2026-11-09; see the sharding design section 7.2 and the ledger design section 5)',
    );
    const rows = policies.split('\n').filter((line) => line.startsWith('| `identity.'));
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) expect(row).not.toMatch(/shares_current_tenant|is_member|staff_flag/);
    const users = rows.find((row) => row.startsWith('| `identity.users`')) ?? '';
    expect(users).toContain('`id = user_id()`');
    expect(users).toContain('NOT is_platform_staff');
    const tenants = rows.find((row) => row.startsWith('| `identity.tenants`')) ?? '';
    expect(tenants).toContain('`id = tenant_id()`');
    expect(policies).toMatch(/row-local/);
    expect(flat(policies)).toMatch(/same trust model as the session context/);
  });

  it('spec 9 lists the identity directory reads as system methods', () => {
    const system = section(
      program,
      '## 9. Pre-auth and system access — **decided: option (b)** (amended 2026-11-09; see the sharding design section 7.4 and the ledger design sections 3 and 5)',
    );
    for (const name of [
      'users.findByIdInTenant',
      'users.listInTenant',
      'users.findByIdsInTenant',
      'memberships.findMember',
      'memberships.listMembers',
      'memberships.listForUser',
    ]) {
      expect(system, name).toContain(`\`${name}\``);
    }
  });

  it('SH 7.2 is superseded by the row-local rule', () => {
    const delta = section(sharding, '### 7.2 Spec §8.2 changes');
    expect(delta).toMatch(/Superseded 2026-11-17/);
    expect(delta).toContain('XX000');
    expect(delta).toContain('b3-identity-policies');
  });
});

describe('the READMEs and guides describe B3', () => {
  const database = read('libs/database/README.md');
  const development = read('docs/DEVELOPMENT.md');
  const billing = read('domains/billing/README.md');
  const identity = read('domains/identity/README.md');

  it('libs/database/README.md covers roles, FORCE RLS, backfills, inUnitOfWork and system methods', () => {
    for (const word of [
      'app_owner',
      'FORCE ROW LEVEL SECURITY',
      'backfills run as `app_system`',
      'inUnitOfWork',
      'defineSystemMethod',
      '### Adding a system method',
      '### Adding a table',
    ]) {
      expect(database, word).toContain(word);
    }
  });

  it('docs/DEVELOPMENT.md has the new-table and new-policy checklists, and no stale policy rule', () => {
    expect(development).toContain('### Checklist: a new table');
    expect(development).toContain('### Checklist: a new policy');
    expect(development).not.toMatch(/reads\s+\*\*reference tables only\*\*/);
    expect(development).not.toMatch(/a transaction pooler arrives with B3/);
  });

  it('the domain READMEs no longer describe the superuser harness', () => {
    for (const readme of [billing, identity]) {
      expect(readme).not.toMatch(/superuser harness/);
      expect(readme).not.toMatch(/Until B3 Tasks 15-16/);
      expect(readme).toMatch(/flows\.rls\.int-spec\.ts/);
    }
  });

  it('README.md asks for one docker compose down -v after B3', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/down -v/);
    expect(readme).toMatch(/roles/);
    expect(readme).toContain('PGBOUNCER_HOST_PORT');
  });
});
