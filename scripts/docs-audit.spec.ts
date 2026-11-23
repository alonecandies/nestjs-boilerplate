import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Audit fixes (2026-11-23): the docs say what the code does. Each describe block belongs to one
 * audit finding, so a doc that drifts back fails here with the finding named.
 */
const root = join(import.meta.dirname, '..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

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

/** Collapses line wraps, so a phrase matches wherever prettier broke the line. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('OPS-4: SHUTDOWN_DRAIN_MS is documented where an operator looks', () => {
  it.each(['docs/CONFIGURATION.md', 'docs/OBSERVABILITY.md', 'docs/SECURITY.md', '.env.example'])(
    '%s names it',
    (file) => {
      expect(read(file)).toContain('SHUTDOWN_DRAIN_MS');
    },
  );

  it('the observability doc no longer says that no app sets a drain', () => {
    expect(flat(read('docs/OBSERVABILITY.md'))).not.toContain('No app sets');
  });

  it('the production checklist ties the drain to the shutdown timeout', () => {
    const checklist = flat(read('docs/SECURITY.md'));
    expect(checklist).toMatch(/- \[ \] `SHUTDOWN_DRAIN_MS`[^-]*`SHUTDOWN_TIMEOUT_MS`/);
  });
});

describe('config-ref-pre-ledger-wiring: nothing says the ledger or the outbox is unwired', () => {
  it('the immudb namespace is described as loaded by the monolith and billing-service', () => {
    const immudb = flat(
      section(read('docs/CONFIGURATION.md'), '### `immudb` — append-only verifiable SQL store'),
    );
    expect(immudb).not.toContain('not loaded by any app yet');
    expect(immudb).toContain('monolith and billing-service');
    expect(immudb).toContain('LEDGER_ENABLED=true');
  });

  it('billing-service is documented as pinning its consumer group, not as only producing', () => {
    const kafka = flat(read('docs/CONFIGURATION.md'));
    expect(kafka).not.toContain('identity-service and billing-service only produce');
    expect(kafka).toContain('BILLING_CONSUMER_GROUP');
  });

  it('.env.example does not call a loaded namespace unloaded', () => {
    expect(read('.env.example')).not.toContain('not loaded by any app yet');
  });
});

describe('OPS-5: the production Redis requirements are documented', () => {
  it('the production checklist states noeviction, AOF and the memory alert', () => {
    const checklist = flat(read('docs/SECURITY.md'));
    expect(checklist).toMatch(/- \[ \] Redis[^[]*`maxmemory-policy noeviction`[^[]*AOF[^[]*alert/);
  });

  it.each([
    'docs/CONFIGURATION.md',
    'docs/OBSERVABILITY.md',
    'docs/DOCKER.md',
    'libs/redis/README.md',
  ])('%s names the eviction gauge or policy', (file) => {
    expect(read(file)).toMatch(/noeviction|redis_eviction_policy_safe/);
  });

  it('the redis namespace explains why the policy matters', () => {
    const redis = flat(
      section(
        read('docs/CONFIGURATION.md'),
        '### `redis` — cache, locks, throttling, BullMQ, socket.io adapter, GraphQL pub/sub',
      ),
    );
    expect(redis).toContain('noeviction');
    expect(redis).toContain('appendonly');
    expect(redis).toContain('denylist');
    expect(redis).toContain('redis_eviction_policy_safe');
  });
});

describe('obs-app-metrics-sentence-stale: the metrics catalogue matches the code', () => {
  it('no doc says there are no app-level Redis or database metrics', () => {
    for (const file of ['docs/OBSERVABILITY.md', 'README.md', 'docs/ARCHITECTURE.md']) {
      expect(flat(read(file)), file).not.toContain('no app-level Redis or database metrics');
    }
  });

  it('the catalogue has a row for every db_* series the code registers', () => {
    const catalogue = read('docs/OBSERVABILITY.md');
    const sources = [
      'libs/database/src/drizzle/pool-usage.ts',
      'libs/database/src/system/system-database.ts',
      'libs/database/src/rls/rls-elevation.service.ts',
    ];
    const registered = sources.flatMap((file) =>
      [...read(file).matchAll(/= '(db_[a-z_]+)'/g)].map((match) => match[1] as string),
    );
    expect(registered.length).toBeGreaterThanOrEqual(5);
    for (const name of registered) expect(catalogue, name).toContain(`| \`${name}\``);
  });

  it('the db_pool rows mention the system pool and its size variable', () => {
    const rows = flat(
      read('docs/OBSERVABILITY.md')
        .split('\n')
        .filter((line) => line.startsWith('| `db_pool_'))
        .join('\n'),
    );
    expect(rows).toContain('pool="system"');
    expect(rows).toContain('DATABASE_SYSTEM_POOL_MAX');
  });

  it('the catalogue has a row for redis_eviction_policy_safe', () => {
    expect(read('docs/OBSERVABILITY.md')).toContain('| `redis_eviction_policy_safe`');
  });
});

describe('ARCH-8: the architecture doc covers every app and the gRPC policy lets ai-service in', () => {
  /** The docs an operator reads: `docs/*.md`, the README and each package's README. */
  const operatorDocs = (): string[] => {
    const packageReadmes = ['apps', 'domains', 'libs'].flatMap((folder) =>
      readdirSync(join(root, folder))
        .map((name) => `${folder}/${name}/README.md`)
        .filter((file) => existsSync(join(root, file))),
    );
    const docs = readdirSync(join(root, 'docs'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => `docs/${name}`);
    return ['README.md', ...docs, ...packageReadmes];
  };

  it('every folder under apps/ is named in docs/ARCHITECTURE.md', () => {
    const architecture = read('docs/ARCHITECTURE.md');
    const apps = readdirSync(join(root, 'apps'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(apps.length).toBeGreaterThanOrEqual(6);
    for (const app of apps) expect(architecture.includes(`apps/${app}`), `apps/${app}`).toBe(true);
  });

  it('the architecture doc names the ai and immudb packages', () => {
    const architecture = read('docs/ARCHITECTURE.md');
    for (const path of ['domains/ai', 'libs/ai', 'libs/immudb']) {
      expect(architecture.includes(`\`${path}\``), path).toBe(true);
    }
  });

  it('no doc says that only the gateway reaches the services', () => {
    const stale = ['only the gateway reaches', 'only lets the gateway reach'];
    const hits = operatorDocs().flatMap((file) => {
      const text = flat(read(file)).toLowerCase();
      return stale.filter((phrase) => text.includes(phrase)).map((phrase) => `${file}: ${phrase}`);
    });
    expect(hits).toEqual([]);
  });
});
