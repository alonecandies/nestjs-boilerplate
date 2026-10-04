import { join } from 'node:path';
import type { JobsOptions } from 'bullmq';

/** BullMQ queue carrying outbound mail (`bull:mail:*` keys). */
export const MAIL_QUEUE = 'mail';

/** Every template shipped in `templates/` (file name without `.hbs`). */
export const MAIL_TEMPLATES = ['welcome', 'payment-receipt', 'daily-digest'] as const;
export type MailTemplate = (typeof MAIL_TEMPLATES)[number];

/**
 * Template locations, resolved next to this module. SWC `copyFiles` mirrors `src/templates/**` into
 * `dist/templates/**`, so the same expression works from sources (dev/tests) and from the build.
 */
export const MAIL_TEMPLATES_DIR = join(import.meta.dirname, 'templates');
export const MAIL_PARTIALS_DIR = join(MAIL_TEMPLATES_DIR, 'partials');

/** Used in the default template context when `MAIL_FROM` has no display name. */
export const DEFAULT_MAIL_APP_NAME = 'NestJS Boilerplate';

const HOUR_SEC = 3600;

/**
 * Per-job options for mail. They override the AppQueueModule defaults because mail has its own
 * needs:
 * - Retries back off exponentially from 5s (7 attempts ≈ 5 min), long enough to ride out SMTP
 *   hiccups and greylisting.
 * - Completed jobs are kept for 24h, not just by count. A custom `jobId` only deduplicates while
 *   the job still exists, so this retention is the idempotency window for `idempotencyKey`
 *   (a Kafka event redelivered within a day does not send the mail twice).
 */
export const MAIL_JOB_OPTIONS = {
  attempts: 7,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * HOUR_SEC, count: 10_000 },
  removeOnFail: { age: 7 * 24 * HOUR_SEC },
} as const satisfies JobsOptions;

/** Default worker concurrency before `MAIL_QUEUE_CONCURRENCY` is applied at bootstrap. */
export const DEFAULT_MAIL_CONCURRENCY = 5;
