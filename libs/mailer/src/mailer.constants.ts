import { join } from 'node:path';
import type { JobsOptions } from 'bullmq';

/** BullMQ queue carrying outbound mail (`bull:mail:*` keys). */
export const MAIL_QUEUE = 'mail';

/**
 * Prometheus counter `mail_jobs_total{outcome}`, registered by `AppMailerModule` in processes that
 * run the worker. One count per finished attempt: `sent` (delivered), `retried` (failed with
 * attempts left) or `failed` (out of attempts or a permanent error: the mail is not sent).
 */
export const MAIL_JOBS_TOTAL = 'mail_jobs_total';

export type MailJobOutcome = 'sent' | 'retried' | 'failed';

/** Every outcome, so each series can be created at 0 (see `MailProcessor`). */
export const MAIL_JOB_OUTCOMES: readonly MailJobOutcome[] = ['sent', 'retried', 'failed'];

/**
 * The shared layout partials (`header`, `footer`, `button`), resolved next to this module. SWC
 * `copyFiles` mirrors `src/templates/partials/**` into `dist/templates/partials/**`, so the same
 * expression works from sources (dev/tests) and from the build. The mail templates belong to the
 * domains that send them: apps register their folders with `AppMailerModule.forRootAsync({
 * templateDirs })`.
 */
export const MAIL_PARTIALS_DIR = join(import.meta.dirname, 'templates', 'partials');

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
