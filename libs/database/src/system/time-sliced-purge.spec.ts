import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PURGE_MAX_SLICES,
  DEFAULT_PURGE_SLICE_MS,
  MIN_PURGE_SLICE_MS,
  purgeInTimeSlices,
} from './time-sliced-purge.js';

const MINUTE = 60_000;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const at = (minutes: number): Date => new Date(T0 + minutes * MINUTE);

/** A table of timestamps; `oldestDue` and `deleteThrough` behave like the SQL (`<= cutoff`). */
function table(minutes: readonly number[], cutoff: Date) {
  let rows = minutes.map(at);
  const calls: string[] = [];
  return {
    calls,
    left: (): number[] => rows.map((row) => (row.getTime() - T0) / MINUTE),
    oldestDue: async (): Promise<Date | null> => {
      calls.push('oldest');
      const due = rows.filter((row) => row <= cutoff);
      return due.length === 0 ? null : new Date(Math.min(...due.map((row) => row.getTime())));
    },
    deleteThrough: async (bound: Date): Promise<number> => {
      calls.push(`delete<=${(bound.getTime() - T0) / MINUTE}`);
      const before = rows.length;
      rows = rows.filter((row) => row > bound || row > cutoff);
      return before - rows.length;
    },
  };
}

describe('purgeInTimeSlices', () => {
  it('deletes oldest first, one slice past the oldest due row at a time, and stops at the cutoff', async () => {
    const cutoff = at(100);
    const t = table([0, 10, 20, 50, 95, 100, 101, 200], cutoff);
    const result = await purgeInTimeSlices({
      cutoff,
      sliceMs: 30 * MINUTE,
      maxSlices: 10,
      oldestDue: t.oldestDue,
      deleteThrough: t.deleteThrough,
    });
    expect(result).toEqual({ deleted: 6, slices: 3, drained: true });
    // min 0 → <= 30; min 50 → <= 80; min 95 → <= 100 (the cutoff, never past it); then none due.
    expect(t.calls).toEqual([
      'oldest',
      'delete<=30',
      'oldest',
      'delete<=80',
      'oldest',
      'delete<=100',
      'oldest',
    ]);
    expect(t.left()).toEqual([101, 200]);
  });

  it('skips the gaps: each slice starts at the oldest row that is still due', async () => {
    const cutoff = at(10_000);
    const t = table([0, 5_000, 9_000], cutoff);
    const result = await purgeInTimeSlices({
      cutoff,
      sliceMs: 15 * MINUTE,
      maxSlices: 10,
      oldestDue: t.oldestDue,
      deleteThrough: t.deleteThrough,
    });
    expect(result).toEqual({ deleted: 3, slices: 3, drained: true });
    expect(t.calls.filter((call) => call.startsWith('delete'))).toEqual([
      'delete<=15',
      'delete<=5015',
      'delete<=9015',
    ]);
  });

  it('stops after maxSlices with the rest of the backlog for the next run (drained: false)', async () => {
    const cutoff = at(1_000);
    const t = table([0, 100, 200, 300, 400], cutoff);
    const options = {
      cutoff,
      sliceMs: 50 * MINUTE,
      maxSlices: 2,
      oldestDue: t.oldestDue,
      deleteThrough: t.deleteThrough,
    };
    await expect(purgeInTimeSlices(options)).resolves.toEqual({
      deleted: 2,
      slices: 2,
      drained: false,
    });
    expect(t.left()).toEqual([200, 300, 400]);
    // The next run picks up where this one stopped.
    await expect(purgeInTimeSlices(options)).resolves.toEqual({
      deleted: 2,
      slices: 2,
      drained: false,
    });
    await expect(purgeInTimeSlices(options)).resolves.toEqual({
      deleted: 1,
      slices: 1,
      drained: true,
    });
    expect(t.left()).toEqual([]);
  });

  it('nothing due: one read, no delete', async () => {
    const cutoff = at(0);
    const t = table([1, 2], cutoff);
    await expect(
      purgeInTimeSlices({ cutoff, oldestDue: t.oldestDue, deleteThrough: t.deleteThrough }),
    ).resolves.toEqual({ deleted: 0, slices: 0, drained: true });
    expect(t.calls).toEqual(['oldest']);
  });

  it('a slice that hits statement_timeout (57014) is retried at half the span, down to the minimum', async () => {
    const cutoff = at(1_000);
    const bounds: number[] = [];
    let timeouts = 2;
    let rows = [at(0), at(1), at(2)];
    const result = await purgeInTimeSlices({
      cutoff,
      sliceMs: 40 * MINUTE,
      maxSlices: 10,
      oldestDue: async () => rows[0] ?? null,
      deleteThrough: async (bound) => {
        bounds.push((bound.getTime() - T0) / MINUTE);
        if (timeouts > 0) {
          timeouts -= 1;
          throw Object.assign(new Error('canceling statement due to statement timeout'), {
            code: '57014',
          });
        }
        const before = rows.length;
        rows = rows.filter((row) => row > bound);
        return before - rows.length;
      },
    });
    // 40 → 20 → 10 minutes; the narrowed span holds for the rest of the run.
    expect(bounds).toEqual([40, 20, 10]);
    expect(result).toEqual({ deleted: 3, slices: 3, drained: true });
  });

  it('recognises a timeout that drizzle wrapped (DrizzleQueryError puts the PostgresError on .cause)', async () => {
    const cutoff = at(1_000);
    const bounds: number[] = [];
    let timeouts = 1;
    let rows = [at(0)];
    const result = await purgeInTimeSlices({
      cutoff,
      sliceMs: 40 * MINUTE,
      oldestDue: async () => rows[0] ?? null,
      deleteThrough: async (bound) => {
        bounds.push((bound.getTime() - T0) / MINUTE);
        if (timeouts > 0) {
          timeouts -= 1;
          const driver = Object.assign(new Error('canceling statement due to statement timeout'), {
            code: '57014',
          });
          throw new Error('Failed query: delete from ...', { cause: driver });
        }
        const before = rows.length;
        rows = rows.filter((row) => row > bound);
        return before - rows.length;
      },
    });
    expect(bounds).toEqual([40, 20]);
    expect(result).toEqual({ deleted: 1, slices: 2, drained: true });
  });

  it('rethrows any other error, and a timeout at the minimum span', async () => {
    const cutoff = at(1_000);
    const boom = new Error('boom');
    await expect(
      purgeInTimeSlices({
        cutoff,
        oldestDue: async () => at(0),
        deleteThrough: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    const timeout = Object.assign(new Error('statement timeout'), { code: '57014' });
    await expect(
      purgeInTimeSlices({
        cutoff,
        sliceMs: MIN_PURGE_SLICE_MS,
        oldestDue: async () => at(0),
        deleteThrough: async () => {
          throw timeout;
        },
      }),
    ).rejects.toBe(timeout);
  });

  it('defaults: 15-minute slices, at most 96 per run (a day of backlog per hourly run)', () => {
    expect(DEFAULT_PURGE_SLICE_MS).toBe(15 * MINUTE);
    expect(DEFAULT_PURGE_MAX_SLICES).toBe(96);
    expect(MIN_PURGE_SLICE_MS).toBe(1_000);
  });

  it('rejects a non-positive slice or slice count', async () => {
    const base = { cutoff: at(0), oldestDue: async () => null, deleteThrough: async () => 0 };
    await expect(purgeInTimeSlices({ ...base, sliceMs: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(purgeInTimeSlices({ ...base, maxSlices: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(purgeInTimeSlices({ ...base, maxSlices: 1.5 })).rejects.toBeInstanceOf(RangeError);
  });
});
