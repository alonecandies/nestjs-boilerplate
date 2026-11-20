import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Outbox plan Task 19: the alert rules of the outbox and the ledger. Both files parse, exactly the
 * planned alerts exist with the planned severities, and every series an `expr` reads is one the code
 * registers ("Metric names" of the plan; the names are pinned in `libs/outbox/src/outbox-metrics.ts`
 * and `domains/billing/src/infrastructure/ledger/ledger-metrics.ts`).
 */
const root = join(import.meta.dirname, '..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

interface Rule {
  alert?: string;
  expr?: string;
  for?: string;
  labels?: { severity?: string };
  annotations?: { summary?: string; description?: string };
}
interface RuleFile {
  groups: { name: string; rules: Rule[] }[];
}

const load = (file: string): Rule[] => {
  const parsed = parse(read(file)) as RuleFile;
  return parsed.groups.flatMap((group) => group.rules);
};

/** The series the code registers, as the plan's "Metric names" lists them. */
const METRIC_NAMES: readonly string[] = [
  'outbox_backlog',
  'outbox_oldest_unpublished_age_seconds',
  'outbox_publish_latency_seconds',
  'outbox_published_total',
  'outbox_relay_leader',
  'ledger_postings_total',
  'ledger_post_duration_seconds',
  'ledger_discrepancies_total',
  'ledger_verified_tx_id',
  'ledger_reconciliation_runs_total',
  'ledger_reconciliation_last_success_timestamp_seconds',
  'ledger_unverified_tx_lag',
];

/** PromQL words that are not series: functions, aggregations, operators, modifiers. */
const PROMQL_WORDS = new Set([
  'abs',
  'absent',
  'and',
  'avg',
  'bool',
  'by',
  'count',
  'increase',
  'max',
  'min',
  'on',
  'or',
  'rate',
  'sum',
  'time',
  'unless',
  'vector',
  'without',
]);

/** The series names an expression reads (label matchers, strings and ranges removed). */
function seriesOf(expr: string): string[] {
  const bare = expr
    .replace(/"[^"]*"/g, '""')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\b(by|without|on|ignoring)\s*\([^)]*\)/g, '');
  return (bare.match(/[a-zA-Z_:][a-zA-Z0-9_:]*/g) ?? []).filter((word) => !PROMQL_WORDS.has(word));
}

const EXPECTED: Readonly<Record<string, Readonly<Record<string, 'page' | 'ticket'>>>> = {
  'docker/prometheus/rules/outbox.rules.yml': {
    OutboxBacklogStuck: 'page',
    OutboxPublishErrors: 'ticket',
    OutboxNoLeader: 'page',
  },
  'docker/prometheus/rules/ledger.rules.yml': {
    LedgerDiscrepancy: 'ticket',
    LedgerTamperEvidence: 'page',
    LedgerPostConflict: 'ticket',
    LedgerReconciliationStale: 'page',
  },
};

describe.each(Object.entries(EXPECTED))('%s', (file, alerts) => {
  const rules = load(file);

  it('parses, and defines exactly the planned alerts with their severities', () => {
    const found = Object.fromEntries(
      rules.map((rule) => [rule.alert ?? '(recording rule)', rule.labels?.severity]),
    );
    expect(found).toEqual(alerts);
  });

  it('reads only registered series in every expr', () => {
    for (const rule of rules) {
      const names = seriesOf(rule.expr ?? '');
      expect(names.length, `${String(rule.alert)} reads no series`).toBeGreaterThan(0);
      for (const name of names) {
        expect(METRIC_NAMES, `${String(rule.alert)} reads ${name}`).toContain(
          name.replace(/_(bucket|sum|count)$/, ''),
        );
      }
    }
  });

  it('every alert carries a summary and a description', () => {
    for (const rule of rules) {
      expect(rule.annotations?.summary, `${String(rule.alert)} summary`).toEqual(
        expect.any(String),
      );
      expect(rule.annotations?.description, `${String(rule.alert)} description`).toEqual(
        expect.any(String),
      );
    }
  });
});

describe('the alert thresholds of the plan', () => {
  const byName = new Map(
    Object.keys(EXPECTED).flatMap((file) => load(file).map((rule) => [rule.alert, rule] as const)),
  );
  const expr = (name: string): string => (byName.get(name)?.expr ?? '').replace(/\s+/g, ' ').trim();
  const waits = (name: string): string | undefined => byName.get(name)?.for;

  it('OutboxBacklogStuck: oldest unpublished age above 300 s for 5 m', () => {
    expect(expr('OutboxBacklogStuck')).toMatch(/outbox_oldest_unpublished_age_seconds.*> 300$/);
    expect(waits('OutboxBacklogStuck')).toBe('5m');
  });

  it('OutboxPublishErrors: any error rate for 10 m', () => {
    expect(expr('OutboxPublishErrors')).toMatch(/outbox_published_total\{outcome="error"\}.*> 0$/);
    expect(waits('OutboxPublishErrors')).toBe('10m');
  });

  it('OutboxNoLeader: no relay holds the lock for 5 m', () => {
    expect(expr('OutboxNoLeader')).toMatch(/outbox_relay_leader.*< 1$/);
    expect(waits('OutboxNoLeader')).toBe('5m');
  });

  it('LedgerDiscrepancy: any increase within one hour', () => {
    expect(expr('LedgerDiscrepancy')).toMatch(/ledger_discrepancies_total.*\[1h\].*> 0$/);
  });

  it('LedgerTamperEvidence: verification_failed or ledger_row_mutated', () => {
    expect(expr('LedgerTamperEvidence')).toContain('verification_failed|ledger_row_mutated');
  });

  it('LedgerPostConflict: the conflict outcome of the postings counter', () => {
    expect(expr('LedgerPostConflict')).toContain('ledger_postings_total{outcome="conflict"}');
  });

  it('LedgerReconciliationStale: last success older than 3 h', () => {
    expect(expr('LedgerReconciliationStale')).toMatch(
      /time\(\) - .*ledger_reconciliation_last_success_timestamp_seconds.* > 10800$/,
    );
  });
});

describe('Prometheus loads the rule files', () => {
  it('rule_files names the rules directory', () => {
    const config = parse(read('docker/prometheus/prometheus.yml')) as { rule_files?: string[] };
    expect(config.rule_files).toEqual(['/etc/prometheus/rules/*.rules.yml']);
  });

  it('the compose prometheus service mounts the directory read-only', () => {
    expect(read('docker-compose.yml')).toContain(
      './docker/prometheus/rules:/etc/prometheus/rules:ro',
    );
  });
});

/**
 * The outbox is the only event path of the Postgres domains. After this plan no doc calls events
 * best-effort or publish-after-commit, nor says there is no outbox, except the notifications note
 * (`notifications.notification-created.v1` has no Postgres store behind it).
 */
describe('the docs describe the outbox as built', () => {
  const docs = [
    'README.md',
    ...[
      'ARCHITECTURE',
      'SECURITY',
      'TESTING',
      'CONFIGURATION',
      'OBSERVABILITY',
      'API',
      'DOCKER',
      'DEVELOPMENT',
      'PERFORMANCE',
    ].map((name) => `docs/${name}.md`),
    ...['billing', 'identity', 'notifications', 'files'].map((name) => `domains/${name}/README.md`),
    ...['outbox', 'transport'].map((name) => `libs/${name}/README.md`),
    ...['monolith', 'gateway', 'identity-service', 'billing-service', 'notifications-service'].map(
      (name) => `apps/${name}/README.md`,
    ),
  ];
  const STALE = /no outbox|publish-after-commit|best-effort/i;

  it('finds "no outbox", "publish-after-commit" and "best-effort" only in the notifications note', () => {
    const hits = docs.flatMap((file) => {
      let text: string;
      try {
        text = read(file);
      } catch {
        return [];
      }
      return text
        .split('\n')
        .filter((line) => STALE.test(line))
        .map((line) => `${file}: ${line.trim().slice(0, 120)}`);
    });
    // The notifications note: its own README, or a line that names the notification-created event.
    const unexpected = hits.filter(
      (hit) => !/^(domains|apps)\/notifications/.test(hit) && !/notification-created/.test(hit),
    );
    expect(unexpected).toEqual([]);
  });
});

describe('docs/SECURITY.md: System-method lists after this plan', () => {
  const security = read('docs/SECURITY.md');
  const heading = '### System-method lists after this plan';
  const from = security.indexOf(heading);
  const text = security.slice(from, security.indexOf('\n### ', from + heading.length));
  const quoted = (source: string): string[] =>
    [...source.matchAll(/defineSystemMethod\(\s*'([A-Za-z.]+)'/g)].map((match) => match[1] ?? '');

  it('names every outbox method of the code and the eleven ledger methods of billing', () => {
    expect(from).toBeGreaterThan(-1);
    const outbox = quoted(read('libs/outbox/src/outbox-system-methods.ts'));
    expect(outbox).toHaveLength(4);
    for (const name of outbox) expect(text, name).toContain(`\`${name}\``);
    const billing = quoted(
      read('domains/billing/src/infrastructure/persistence/billing.system-methods.ts'),
    );
    expect(billing.filter((name) => name.startsWith('ledger'))).toHaveLength(11);
  });

  it('states the pinned totals: identity 13, billing 16', () => {
    const count = (domain: string, shared: number): number =>
      quoted(read(`domains/${domain}/src/infrastructure/persistence/${domain}.system-methods.ts`))
        .length + shared;
    expect(count('identity', 3)).toBe(13);
    expect(count('billing', 4)).toBe(17);
    expect(text).toContain('Identity pins 13 methods and billing 17');
  });
});
