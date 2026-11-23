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

describe('OPS-1: one runbook says how each store is backed up and restored', () => {
  it('docs/OPERATIONS.md exists and is linked from the README docs list', () => {
    expect(existsSync(join(root, 'docs/OPERATIONS.md'))).toBe(true);
    expect(read('README.md')).toMatch(/\| \[docs\/OPERATIONS\.md\]\(docs\/OPERATIONS\.md\) +\|/);
  });

  it('the runbook names the Postgres, Cassandra and immudb steps and the re-anchor entrypoint', () => {
    const runbook = read('docs/OPERATIONS.md');
    for (const term of [
      'citus_create_restore_point',
      'nodetool snapshot',
      'immuadmin hot-backup',
      'dist/cli/ledger-reanchor.js',
    ]) {
      expect(runbook, term).toContain(term);
    }
  });

  it('every store has a section and the restore order is stated', () => {
    const runbook = read('docs/OPERATIONS.md');
    for (const heading of [
      '## Postgres and Citus',
      '## Cassandra',
      '## immudb',
      '## Restore order and loss windows',
    ]) {
      expect(runbook.split('\n'), heading).toContain(heading);
    }
  });

  it('every restore step that was not run end to end says UNTESTED', () => {
    const runbook = read('docs/OPERATIONS.md');
    for (const heading of ['## Postgres and Citus', '## Cassandra', '## immudb']) {
      expect(section(runbook, heading), heading).toContain('UNTESTED');
    }
  });

  it('DOCKER.md and the production checklist link to the runbook', () => {
    expect(read('docs/DOCKER.md')).toContain('(OPERATIONS.md');
    const checklist = flat(section(read('docs/SECURITY.md'), '## Production checklist'));
    expect(checklist).toMatch(/- \[ \] Backups(?:(?!- \[ \]).)*\]\(OPERATIONS\.md\)/);
  });

  it('DOCKER.md no longer tells an operator to stop immudb and snapshot its volume', () => {
    expect(flat(read('docs/DOCKER.md'))).not.toContain('stop the service, snapshot the volume');
  });
});

describe('batch 1 docs drift: follow-ups that shipped and a Kafka section from before the outbox', () => {
  const development = (): string => flat(read('docs/DEVELOPMENT.md'));

  it('api-subpath-followup-stale: no doc calls the per-domain API subpath exports a follow-up', () => {
    expect(development()).not.toMatch(/subpath exports[^.]*known follow-up/);
    expect(flat(read('docs/API.md'))).not.toContain('(per-domain API subpath exports)');
    expect(development()).toContain(
      'the build stage compiles every lib and domain; the runtime image keeps only traced files',
    );
  });

  it('devdocs-kafka-section-pre-outbox: the Kafka section does not count topics and points at topics.txt', () => {
    const kafka = flat(section(read('docs/DEVELOPMENT.md'), '## Kafka topics'));
    expect(kafka).not.toContain('Today there are three');
    expect(kafka).toContain('docker/kafka/topics.txt');
    expect(kafka).toMatch(/Postgres contexts? enqueues? through (?:their|its) outbox/);
  });

  it('devdocs-kafka-section-pre-outbox: only a context without a store publishes directly', () => {
    const kafka = flat(section(read('docs/DEVELOPMENT.md'), '## Kafka topics'));
    expect(kafka).not.toContain('Producers call `KafkaProducer.publish');
    expect(kafka).toMatch(
      /only a context without a (?:Postgres )?store[^`]*calls `KafkaProducer\.publish/i,
    );
  });

  it('OPS-2: the expand/contract note points at the lock timeout and the online steps', () => {
    const note = development()
      .split('- ')
      .find((item) => item.startsWith('Migrations are forward-only'));
    expect(note).toBeDefined();
    expect(note).toContain('lock timeout');
    expect(note).toContain('online');
    expect(note).toContain('libs/database/README.md');
  });
});

describe('spec-roadmap-status-stale: the program spec says which phases shipped', () => {
  const spec = read('docs/superpowers/specs/2026-10-12-domains-tenancy-rls-program-design.md');

  it('has a status line under the header that says every phase shipped', () => {
    const header = spec.split('\n').slice(0, 12).join('\n');
    expect(flat(header)).toMatch(/\*\*Delivery:\*\*[^-]*shipped/);
  });

  it('has no roadmap row marked next, and every row is done', () => {
    const rows = spec.split('\n').filter((line) => /^\| (?:A1|H|D|F|B|S|L|C|G|E) +\|/.test(line));
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row, row).not.toMatch(/\bnext\b/);
      expect(row, row).toContain('**done**');
    }
  });
});

describe('CI-2 and test-gap-statements-stale: the test docs describe the coverage that exists', () => {
  /** Every `apps|domains|libs/<package>` folder that holds a file with the suffix, with its project name. */
  function packagesWith(suffix: string, parents: string[]): string[] {
    const found = new Set<string>();
    const walk = (dir: string, owner: string): void => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (['node_modules', 'dist', 'coverage', 'generated'].includes(entry.name)) continue;
        if (entry.isDirectory()) walk(`${dir}/${entry.name}`, owner);
        else if (entry.name.endsWith(suffix)) found.add(owner);
      }
    };
    for (const parent of parents) {
      for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${parent}/${entry.name}`, `${parent}/${entry.name}`);
      }
    }
    return [...found].sort();
  }
  const testing = (): string => flat(read('docs/TESTING.md'));

  it('docs/TESTING.md names the project of every package that has an *.int-spec.ts', () => {
    const domains = new Set(
      readdirSync(join(root, 'domains'), { withFileTypes: true }).map((entry) => entry.name),
    );
    const packages = packagesWith('.int-spec.ts', ['apps', 'domains', 'libs']);
    expect(packages.length).toBeGreaterThan(8);
    for (const pkg of packages) {
      const [parent = '', name = ''] = pkg.split('/');
      const project = parent === 'libs' && domains.has(name) ? `platform-${name}` : name;
      expect(testing(), `${pkg} has int specs`).toContain(`\`${project}:int\``);
    }
  });

  it('docs/TESTING.md counts and names every app that has an e2e suite', () => {
    const apps = packagesWith('.e2e-spec.ts', ['apps']).map((pkg) => pkg.slice('apps/'.length));
    expect(apps).toHaveLength(6);
    expect(testing()).toContain('Every app has an e2e spec');
    expect(testing()).toContain('the six app e2e suites');
    expect(testing()).not.toContain('five app e2e');
    for (const app of apps) expect(testing(), app).toContain(`\`${app}\``);
  });

  it('docs/TESTING.md keeps one known gap: the Nest consumer stack on a real broker', () => {
    const gapsSection = section(read('docs/TESTING.md'), '## Known gaps');
    const gaps = flat(gapsSection);
    expect(gaps).not.toContain('no broker or cross-process integration specs');
    expect(gaps).toContain('Nest consumer');
    expect(gaps).toContain('outbox-kafka-delivery.int-spec.ts');
    expect(gaps).toContain('topology');
    expect(gapsSection.match(/^- /gm) ?? []).toHaveLength(1);
  });

  it('docs/TESTING.md gives the int hook timeout the CI-2 budget', () => {
    expect(testing()).toContain('integration projects 120 s / 240 s');
    expect(testing()).not.toContain('120 s / 180 s');
  });

  it('docs/DOCKER.md describes the integration job and the six image apps', () => {
    const job = flat(read('docs/DOCKER.md'));
    for (const store of ['Citus', 'Cassandra', 'Kafka', 'immudb', 'RustFS', 'fake-gcs-server']) {
      expect(job).toMatch(new RegExp(`\\*\\*integration\\*\\*:[^\\n]*${store}`));
    }
    expect(job).toContain('scripts/int-images.mjs');
    expect(job).toContain('**image** (matrix of the 6 apps)');
  });

  it('docs/RELEASING.md links the test doc instead of listing int specs', () => {
    const releasing = read('docs/RELEASING.md');
    expect(releasing).not.toContain('known follow-up');
    expect(releasing).not.toContain('Today only `@platform/database`');
    expect(releasing).toContain('(TESTING.md');
  });
});
