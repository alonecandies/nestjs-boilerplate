import {
  getOrCreateCounter,
  getOrCreateGauge,
  getOrCreateHistogram,
} from '@platform/observability';
import type { OutboxPoll, OutboxRow } from './outbox.types.js';

export const OUTBOX_BACKLOG = 'outbox_backlog';
export const OUTBOX_OLDEST_UNPUBLISHED_AGE_SECONDS = 'outbox_oldest_unpublished_age_seconds';
export const OUTBOX_PUBLISH_LATENCY_SECONDS = 'outbox_publish_latency_seconds';
export const OUTBOX_PUBLISHED_TOTAL = 'outbox_published_total';
export const OUTBOX_RELAY_LEADER = 'outbox_relay_leader';

/** Commit-to-publish latency buckets: a healthy relay sits near the poll interval (500 ms). */
export const OUTBOX_LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900];

/** `ok`: the broker acknowledged the row; `error`: the publish failed (the batch stops there). */
export type OutboxPublishOutcome = 'ok' | 'error';

const backlog = () =>
  getOrCreateGauge({
    name: OUTBOX_BACKLOG,
    help: 'Unpublished outbox rows at the last poll of the leader relay, by outbox (absent on non-leaders)',
    labelNames: ['outbox'],
  });

const oldestAge = () =>
  getOrCreateGauge({
    name: OUTBOX_OLDEST_UNPUBLISHED_AGE_SECONDS,
    help: 'Age of the oldest unpublished outbox row at the last poll of the leader relay, by outbox (0 when empty)',
    labelNames: ['outbox'],
  });

const latency = () =>
  getOrCreateHistogram({
    name: OUTBOX_PUBLISH_LATENCY_SECONDS,
    help: 'Seconds from the created_at of an outbox row to the broker acknowledging its publish, by outbox and topic',
    labelNames: ['outbox', 'topic'],
    buckets: OUTBOX_LATENCY_BUCKETS,
  });

const published = () =>
  getOrCreateCounter({
    name: OUTBOX_PUBLISHED_TOTAL,
    help: 'Outbox rows the relay tried to publish, by outbox, topic and outcome (ok, error)',
    labelNames: ['outbox', 'topic', 'outcome'],
  });

const leader = () =>
  getOrCreateGauge({
    name: OUTBOX_RELAY_LEADER,
    help: '1 while this process holds the relay lock of the outbox, 0 otherwise',
    labelNames: ['outbox'],
  });

/**
 * The relay metrics of one outbox (label `outbox` = the feature name, its Postgres schema). Only
 * the leader sets backlog and age; when its term ends they are removed (not zeroed), so a sum over
 * processes never adds a stale value from a former leader.
 */
export class OutboxMetrics {
  private readonly labels: { readonly outbox: string };

  constructor(name: string) {
    this.labels = { outbox: name };
  }

  /** The relay runs in this process and does not lead (yet): `outbox_relay_leader` 0. */
  following(): void {
    leader().set(this.labels, 0);
  }

  /** A term started: `outbox_relay_leader` 1. */
  termStarted(): void {
    leader().set(this.labels, 1);
  }

  /** A term ended (lost, stopped or failed): leader 0, backlog and age removed. */
  termEnded(): void {
    leader().set(this.labels, 0);
    backlog().remove(this.labels);
    oldestAge().remove(this.labels);
  }

  /** The backlog statistics of one poll; the age is `now − oldestCreatedAt` (0 for none). */
  polled(poll: Pick<OutboxPoll, 'backlog' | 'oldestCreatedAt'>, now: number = Date.now()): void {
    backlog().set(this.labels, poll.backlog);
    const age =
      poll.oldestCreatedAt === null ? 0 : Math.max(0, now - poll.oldestCreatedAt.getTime()) / 1000;
    oldestAge().set(this.labels, age);
  }

  /** The broker acknowledged `row` at `now`: one latency observation and one `ok`. */
  published(row: Pick<OutboxRow, 'topic' | 'createdAt'>, now: number = Date.now()): void {
    const labels = { ...this.labels, topic: row.topic };
    latency().observe(labels, Math.max(0, now - row.createdAt.getTime()) / 1000);
    published().inc({ ...labels, outcome: 'ok' satisfies OutboxPublishOutcome });
  }

  /** The publish of `row` failed: one `error`. */
  publishFailed(row: Pick<OutboxRow, 'topic'>): void {
    published().inc({
      ...this.labels,
      topic: row.topic,
      outcome: 'error' satisfies OutboxPublishOutcome,
    });
  }
}
