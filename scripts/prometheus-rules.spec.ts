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
  // AI plan Task 7 (`libs/ai/src/ai.metrics.ts`).
  'ai_requests_total',
  'ai_tokens_total',
  'ai_request_duration_seconds',
  // Audit fixes Task 4 (`libs/transport/src/kafka/kafka-metrics.ts`).
  'kafka_consumer_messages_total',
  // Audit fixes Task 21: the series of the platform and billing rules and the mail job counter.
  'kafka_consumer_lag',
  'grpc_client_circuit_breaker_state',
  'grpc_client_handled_total',
  'rate_limit_fail_open_total',
  'db_pool_operations_waiting',
  'http_request_duration_seconds',
  'redis_eviction_policy_safe',
  'billing_checkout_paid_without_currency_total',
  'billing_checkout_paid_without_amount_total',
  'billing_checkout_paid_without_owner_total',
  'billing_checkout_amount_mismatch_total',
  'billing_stripe_api_version_mismatch_total',
  'mail_jobs_total',
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
  'delta',
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
  'docker/prometheus/rules/ai.rules.yml': {
    AiErrorRate: 'ticket',
  },
  'docker/prometheus/rules/platform.rules.yml': {
    KafkaDeadLetters: 'page',
    KafkaRedeliveries: 'ticket',
    KafkaConsumerLagGrowing: 'ticket',
    GrpcCircuitBreakerOpen: 'page',
    RateLimitFailOpen: 'ticket',
    DbPoolSaturated: 'ticket',
    HttpServerErrorRatio: 'page',
    RedisEvictionPolicyUnsafe: 'ticket',
    MailJobsFailed: 'ticket',
  },
  'docker/prometheus/rules/billing.rules.yml': {
    BillingPaidWithoutCurrency: 'page',
    BillingPaidWithoutAmount: 'page',
    BillingPaidWithoutOwner: 'page',
    BillingAmountMismatch: 'ticket',
    BillingStripeApiVersionMismatch: 'ticket',
  },
};

/** The failures the audit lists (ARCH-3): each series is read by at least one rule. */
const AUDIT_SERIES = [
  'kafka_consumer_messages_total',
  'kafka_consumer_lag',
  'grpc_client_circuit_breaker_state',
  'rate_limit_fail_open_total',
  'db_pool_operations_waiting',
  'http_request_duration_seconds',
  'redis_eviction_policy_safe',
  'billing_checkout_paid_without_currency_total',
  'billing_checkout_paid_without_amount_total',
  'billing_checkout_paid_without_owner_total',
  'billing_checkout_amount_mismatch_total',
  'billing_stripe_api_version_mismatch_total',
  'mail_jobs_total',
] as const;

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

  it("AiErrorRate: error and timeout calls above 10 % of a model's calls for 10 m, aborts excluded", () => {
    const rule = expr('AiErrorRate');
    expect(rule).toContain('ai_requests_total{outcome=~"error|timeout"}');
    expect(rule).not.toContain('aborted');
    expect(rule).toMatch(/by \(model\)/);
    expect(rule).toMatch(/> 0\.1/);
    expect(waits('AiErrorRate')).toBe('10m');
  });

  it('KafkaDeadLetters: any dead-lettered message within 15 m, per service and topic', () => {
    const rule = expr('KafkaDeadLetters');
    expect(rule).toContain('increase(kafka_consumer_messages_total{outcome="dead_letter"}[15m])');
    expect(rule).toMatch(/by \(service, topic\)/);
    expect(rule).toMatch(/> 0$/);
  });
});

describe('the platform and billing rules of audit fixes Task 21', () => {
  const byName = new Map(
    Object.keys(EXPECTED).flatMap((file) => load(file).map((rule) => [rule.alert, rule] as const)),
  );
  const expr = (name: string): string => (byName.get(name)?.expr ?? '').replace(/\s+/g, ' ').trim();
  const waits = (name: string): string | undefined => byName.get(name)?.for;

  it('every series the audit lists is read by at least one rule', () => {
    const read = new Set(
      [...byName.values()].flatMap((rule) =>
        seriesOf(rule.expr ?? '').map((name) => name.replace(/_(bucket|sum|count)$/, '')),
      ),
    );
    for (const name of AUDIT_SERIES) expect(read, name).toContain(name);
  });

  it('KafkaRedeliveries: a sustained redelivery rate per service and topic', () => {
    expect(expr('KafkaRedeliveries')).toMatch(
      /rate\(kafka_consumer_messages_total\{outcome="redelivery"\}\[5m\]\).*> 0$/,
    );
    expect(waits('KafkaRedeliveries')).toBe('15m');
  });

  it('KafkaConsumerLagGrowing: lag above 1000 and still growing over 15 m', () => {
    const rule = expr('KafkaConsumerLagGrowing');
    expect(rule).toMatch(/kafka_consumer_lag > 1000/);
    expect(rule).toContain('delta(kafka_consumer_lag[15m]) > 0');
    expect(waits('KafkaConsumerLagGrowing')).toBe('15m');
  });

  // The breaker cycles open and half_open against a hung upstream (5 s each, a 15 s scrape), so the
  // rule reads "not closed", and only while calls are refused: an idle breaker stays half_open.
  it('GrpcCircuitBreakerOpen: a breaker not closed for 5 m while its service refuses calls', () => {
    const rule = expr('GrpcCircuitBreakerOpen');
    expect(rule).toContain('grpc_client_circuit_breaker_state{state!="closed"}) == 1');
    expect(rule).not.toContain('{state="open"}');
    expect(rule).toContain(' and on (service) sum by (service) ');
    expect(rule).toMatch(
      /rate\(grpc_client_handled_total\{grpc_code="CIRCUIT_OPEN"\}\[2m\]\)\) > 0$/,
    );
    expect(waits('GrpcCircuitBreakerOpen')).toBe('5m');
  });

  it('RateLimitFailOpen: any fail-open increase, per throttler', () => {
    expect(expr('RateLimitFailOpen')).toMatch(/increase\(rate_limit_fail_open_total\[5m\]\).*> 0$/);
    expect(expr('RateLimitFailOpen')).toMatch(/by \(service, throttler\)/);
  });

  it('DbPoolSaturated: operations waiting for 10 m', () => {
    expect(expr('DbPoolSaturated')).toMatch(/db_pool_operations_waiting\) > 0$/);
    expect(waits('DbPoolSaturated')).toBe('10m');
  });

  it('HttpServerErrorRatio: 5xx above 5 % of the requests of a service for 10 m', () => {
    const rule = expr('HttpServerErrorRatio');
    expect(rule).toContain('http_request_duration_seconds_count{status_code=~"5.."}');
    expect(rule).toMatch(/> 0\.05$/);
    expect(waits('HttpServerErrorRatio')).toBe('10m');
  });

  it('RedisEvictionPolicyUnsafe: the gauge is 0', () => {
    expect(expr('RedisEvictionPolicyUnsafe')).toMatch(/redis_eviction_policy_safe\) == 0$/);
  });

  it('MailJobsFailed: any job that ran out of attempts', () => {
    expect(expr('MailJobsFailed')).toMatch(
      /increase\(mail_jobs_total\{outcome="failed"\}\[15m\]\).*> 0$/,
    );
  });

  it.each([
    ['BillingPaidWithoutCurrency', 'billing_checkout_paid_without_currency_total'],
    ['BillingPaidWithoutAmount', 'billing_checkout_paid_without_amount_total'],
    ['BillingPaidWithoutOwner', 'billing_checkout_paid_without_owner_total'],
    ['BillingAmountMismatch', 'billing_checkout_amount_mismatch_total'],
    ['BillingStripeApiVersionMismatch', 'billing_stripe_api_version_mismatch_total'],
  ])('%s: any increase of %s', (alert, series) => {
    expect(expr(alert)).toMatch(new RegExp(`increase\\(${series}\\[15m\\]\\).*> 0$`));
  });
});

describe('the Grafana overview reads the dead-letter series', () => {
  it('one panel plots kafka_consumer_messages_total{outcome="dead_letter"}', () => {
    const dashboard = JSON.parse(read('docker/grafana/dashboards/nestjs-overview.json')) as {
      panels: { title?: string; targets?: { expr?: string }[] }[];
    };
    const panels = dashboard.panels.filter((panel) =>
      (panel.targets ?? []).some((target) =>
        (target.expr ?? '').includes('kafka_consumer_messages_total{outcome="dead_letter"'),
      ),
    );
    expect(panels.map((panel) => panel.title)).toHaveLength(1);
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

  it('names every outbox method of the code and the twelve ledger methods of billing', () => {
    expect(from).toBeGreaterThan(-1);
    const outbox = quoted(read('libs/outbox/src/outbox-system-methods.ts'));
    expect(outbox).toHaveLength(4);
    for (const name of outbox) expect(text, name).toContain(`\`${name}\``);
    const billing = quoted(
      read('domains/billing/src/infrastructure/persistence/billing.system-methods.ts'),
    );
    expect(billing.filter((name) => name.startsWith('ledger'))).toHaveLength(12);
  });

  it('states the pinned totals: identity 13, billing 18', () => {
    const count = (domain: string, shared: number): number =>
      quoted(read(`domains/${domain}/src/infrastructure/persistence/${domain}.system-methods.ts`))
        .length + shared;
    expect(count('identity', 3)).toBe(13);
    expect(count('billing', 4)).toBe(18);
    expect(text).toContain('Identity pins 13 methods and billing 18');
  });
});
