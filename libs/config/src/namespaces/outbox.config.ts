import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zInt } from '../env/env.helpers.js';

export const outboxEnvSchema = z
  .object({
    OUTBOX_RELAY_ENABLED: zBool(true),
    OUTBOX_POLL_INTERVAL_MS: zInt(500, { min: 50, max: 60_000 }),
    OUTBOX_BATCH_SIZE: zInt(100, { min: 1, max: 500 }),
    OUTBOX_LOCK_TTL_MS: zInt(15_000, { min: 1_000, max: 300_000 }),
    OUTBOX_MAX_BACKOFF_MS: zInt(30_000, { min: 1 }),
    OUTBOX_RETENTION_HOURS: zInt(168, { min: 1, max: 8_760 }),
  })
  .superRefine((env, ctx) => {
    if (env.OUTBOX_MAX_BACKOFF_MS < env.OUTBOX_POLL_INTERVAL_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['OUTBOX_MAX_BACKOFF_MS'],
        message: 'Must be at least OUTBOX_POLL_INTERVAL_MS',
      });
    }
  })
  .transform((env) => ({
    /** Start the relay of each outbox this process owns (it still needs a system pool). */
    relayEnabled: env.OUTBOX_RELAY_ENABLED,
    /** Wait after an empty poll; a full batch polls again at once. */
    pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    /** Rows per poll. */
    batchSize: env.OUTBOX_BATCH_SIZE,
    /** TTL of the leader lock `outbox-relay:<name>` (auto-extended while the term runs). */
    lockTtlMs: env.OUTBOX_LOCK_TTL_MS,
    /** Cap of the doubling wait after a failed publish. */
    maxBackoffMs: env.OUTBOX_MAX_BACKOFF_MS,
    /** Published rows older than this are purged. */
    retentionHours: env.OUTBOX_RETENTION_HOURS,
  }));

/** Transactional outbox relay (`@platform/outbox`): one leader per outbox publishes to Kafka. */
export const outboxConfig = defineConfigNamespace('outbox', outboxEnvSchema);
export type OutboxConfig = ConfigType<typeof outboxConfig>;
