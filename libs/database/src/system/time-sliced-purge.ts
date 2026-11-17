/**
 * Bounded progress for a purge of a distributed table (B3 final review F3). Citus cannot push a
 * `LIMIT`ed sub-select down, so a purge cannot delete "the next N rows"; one DELETE of the whole
 * backlog, on the other hand, may never finish inside the role's `statement_timeout` (15 s) and
 * then never catches up. Instead the purge deletes in time slices, oldest first:
 *
 * 1. read the oldest due timestamp (`select min(t) … where t <= cutoff`: one index probe per shard);
 * 2. delete the rows up to `oldest + slice` (never past `cutoff`): one multi-shard DELETE, set-based,
 *    no row-by-row loop (ruling 6);
 * 3. repeat, up to `maxSlices` statements per run; the next run resumes at the new oldest row.
 *
 * Re-reading the oldest row skips empty gaps and makes every slice delete at least one row. Each
 * DELETE commits on its own (the system pool runs without a transaction), so earlier slices survive
 * a later failure. A slice that still hits `statement_timeout` (57014: too dense a span) is retried
 * at half the span, down to `MIN_PURGE_SLICE_MS`, and the narrowed span holds for the rest of the
 * run; a timeout at the minimum span is rethrown (the cron logs it and retries on its next tick).
 */

/** 15 minutes per slice ... */
export const DEFAULT_PURGE_SLICE_MS = 15 * 60_000;
/** ... and at most 96 slices per run: an hourly run clears up to a day of backlog. */
export const DEFAULT_PURGE_MAX_SLICES = 96;
/** The narrowest span a timed-out slice is halved down to. */
export const MIN_PURGE_SLICE_MS = 1_000;

/** Postgres `query_canceled`: what `statement_timeout` raises. */
const STATEMENT_TIMEOUT = '57014';

export interface TimeSlicedPurgeOptions {
  /** The run never deletes past it (the purge's own predicate, `<=` or `<`, applies too). */
  readonly cutoff: Date;
  /** Width of one slice, in ms (default `DEFAULT_PURGE_SLICE_MS`). */
  readonly sliceMs?: number;
  /** DELETE statements per run, timed-out ones included (default `DEFAULT_PURGE_MAX_SLICES`). */
  readonly maxSlices?: number;
  /** The oldest timestamp still due (on the purge's side of `cutoff`), or null when none is. */
  oldestDue(): Promise<Date | null>;
  /**
   * Deletes the due rows whose timestamp is at most `bound` (`bound <= cutoff`; keep the cutoff
   * predicate in the statement too) and returns how many went.
   */
  deleteThrough(bound: Date): Promise<number>;
}

export interface TimeSlicedPurgeResult {
  /** Rows deleted by this run. */
  readonly deleted: number;
  /** DELETE statements sent, timed-out ones included. */
  readonly slices: number;
  /** `true` once nothing due is left; `false` when `maxSlices` stopped the run first. */
  readonly drained: boolean;
}

const MAX_CAUSE_DEPTH = 5;

/** `true` when `error` or one of its causes is a statement timeout (drizzle wraps driver errors). */
const isStatementTimeout = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === STATEMENT_TIMEOUT) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

/** Runs one bounded purge; see the module comment. */
export async function purgeInTimeSlices(
  options: TimeSlicedPurgeOptions,
): Promise<TimeSlicedPurgeResult> {
  const maxSlices = options.maxSlices ?? DEFAULT_PURGE_MAX_SLICES;
  let span = options.sliceMs ?? DEFAULT_PURGE_SLICE_MS;
  if (!Number.isFinite(span) || span <= 0) {
    throw new RangeError(`purgeInTimeSlices: sliceMs must be positive, got ${span}`);
  }
  if (!Number.isInteger(maxSlices) || maxSlices < 1) {
    throw new RangeError(
      `purgeInTimeSlices: maxSlices must be a positive integer, got ${maxSlices}`,
    );
  }
  const cutoff = options.cutoff.getTime();
  let deleted = 0;
  let slices = 0;
  while (slices < maxSlices) {
    const oldest = await options.oldestDue();
    if (oldest === null) return { deleted, slices, drained: true };
    const bound = new Date(Math.min(oldest.getTime() + span, cutoff));
    slices += 1;
    try {
      deleted += await options.deleteThrough(bound);
    } catch (error) {
      if (!isStatementTimeout(error) || span <= MIN_PURGE_SLICE_MS) throw error;
      span = Math.max(MIN_PURGE_SLICE_MS, Math.floor(span / 2));
    }
  }
  return { deleted, slices, drained: false };
}
