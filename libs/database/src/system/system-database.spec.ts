import { Logger } from '@nestjs/common';
import { createPrincipal, runWithPrincipal, SystemContext } from '@platform/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '../drizzle/drizzle.types.js';
import { DB_SYSTEM_CALLS_TOTAL, SystemDatabase, SystemDatabaseError } from './system-database.js';
import { defineSystemMethod, type SystemMethod } from './system-method.js';

const counter = vi.hoisted((): { inc: ReturnType<typeof vi.fn>; spec: unknown } => ({
  inc: vi.fn(),
  spec: undefined,
}));
vi.mock('@platform/observability', () => ({
  getOrCreateCounter: (spec: unknown) => {
    counter.spec = spec;
    return { inc: counter.inc };
  },
}));

const USER = '0197a000-0000-7000-8000-00000000000a';
const TENANT = '0197a000-0000-7000-8000-0000000000a1';
const member = createPrincipal({ userId: USER, tenantId: TENANT, roles: ['member'] });
const REASON = 'sample.nightly-purge';

const purge = defineSystemMethod('samples.deleteExpired', 'system');
const lookup = defineSystemMethod('samples.findByEmail', 'pre-auth');

/** A stand-in for the app_system Drizzle handle: `run` only hands it to `work`. */
const systemDb = { name: 'system-db' } as unknown as DrizzleDB;

describe('defineSystemMethod', () => {
  it('returns a frozen { name, scope }', () => {
    expect(purge).toEqual({ name: 'samples.deleteExpired', scope: 'system' });
    expect(Object.isFrozen(purge)).toBe(true);
    expect(defineSystemMethod('shipmentEvents.markProcessedAsPlatform', 'system').name).toBe(
      'shipmentEvents.markProcessedAsPlatform',
    );
  });

  it.each([
    '',
    'samples',
    'samples.',
    '.deleteExpired',
    'samples.delete.expired',
    'samples.delete-expired',
    'Samples.deleteExpired',
    'samples.deleteExpired ',
    "samples.x'; drop table y; --",
  ])('rejects the name %j (not <repository>.<method>)', (name) => {
    expect(() => defineSystemMethod(name, 'system')).toThrow(/<repository>\.<method>/);
  });

  it('rejects a name that is not a string and an unknown scope', () => {
    expect(() => defineSystemMethod(42 as unknown as string, 'system')).toThrow(
      /<repository>\.<method>/,
    );
    expect(() => defineSystemMethod('samples.deleteExpired', 'admin' as never)).toThrow(/scope/);
  });
});

describe('SystemDatabase', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    counter.inc.mockClear();
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Every record the service logged (`log` for ok, `warn` for error). */
  const records = (): unknown[] =>
    [...log.mock.calls, ...warn.mock.calls].map(([record]) => record);

  it('registers db_system_calls_total{method,outcome}', () => {
    new SystemDatabase(systemDb);
    expect(counter.spec).toMatchObject({
      name: DB_SYSTEM_CALLS_TOTAL,
      labelNames: ['method', 'outcome'],
    });
    expect(DB_SYSTEM_CALLS_TOTAL).toBe('db_system_calls_total');
  });

  it('runs a system method inside SystemContext on the system handle; logs and counts it once', async () => {
    const database = new SystemDatabase(systemDb);
    const work = vi.fn(async (db: DrizzleDB) => (db === systemDb ? 3 : -1));
    await expect(SystemContext.run(REASON, () => database.run(purge, work))).resolves.toBe(3);
    expect(work).toHaveBeenCalledTimes(1);
    expect(records()).toEqual([
      { systemMethod: 'samples.deleteExpired', scope: 'system', reason: REASON, outcome: 'ok' },
    ]);
    expect(counter.inc).toHaveBeenCalledTimes(1);
    expect(counter.inc).toHaveBeenCalledWith({ method: 'samples.deleteExpired', outcome: 'ok' });
  });

  it('refuses a system method outside SystemContext (SYSTEM_CONTEXT_REQUIRED) without calling work', async () => {
    const database = new SystemDatabase(systemDb);
    const work = vi.fn(async () => 1);
    await expect(database.run(purge, work)).rejects.toMatchObject({
      name: 'SystemDatabaseError',
      code: 'SYSTEM_CONTEXT_REQUIRED',
    });
    // Under a principal (also a principal nested in a system context) it is not a system context.
    await expect(runWithPrincipal(member, () => database.run(purge, work))).rejects.toMatchObject({
      code: 'SYSTEM_CONTEXT_REQUIRED',
    });
    await expect(
      SystemContext.run(REASON, () => runWithPrincipal(member, () => database.run(purge, work))),
    ).rejects.toMatchObject({ code: 'SYSTEM_CONTEXT_REQUIRED' });
    expect(work).not.toHaveBeenCalled();
    // A refusal is a call: logged and counted as an error, once each.
    expect(records()).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(counter.inc).toHaveBeenCalledTimes(3);
    expect(counter.inc).toHaveBeenCalledWith({ method: 'samples.deleteExpired', outcome: 'error' });
  });

  it('runs a pre-auth method anywhere: no context, under a principal, in SystemContext', async () => {
    const database = new SystemDatabase(systemDb);
    const work = vi.fn(async () => 'row');
    await expect(database.run(lookup, work)).resolves.toBe('row');
    await expect(runWithPrincipal(member, () => database.run(lookup, work))).resolves.toBe('row');
    await expect(SystemContext.run(REASON, () => database.run(lookup, work))).resolves.toBe('row');
    expect(work).toHaveBeenCalledTimes(3);
    expect(records()).toEqual([
      { systemMethod: 'samples.findByEmail', scope: 'pre-auth', outcome: 'ok' },
      { systemMethod: 'samples.findByEmail', scope: 'pre-auth', outcome: 'ok' },
      { systemMethod: 'samples.findByEmail', scope: 'pre-auth', reason: REASON, outcome: 'ok' },
    ]);
    expect(counter.inc).toHaveBeenCalledTimes(3);
  });

  it('without DATABASE_SYSTEM_URL every run throws SYSTEM_DATABASE_UNAVAILABLE, never calling work', async () => {
    const database = new SystemDatabase(null);
    const work = vi.fn(async () => 1);
    await expect(database.run(lookup, work)).rejects.toMatchObject({
      name: 'SystemDatabaseError',
      code: 'SYSTEM_DATABASE_UNAVAILABLE',
    });
    await expect(SystemContext.run(REASON, () => database.run(purge, work))).rejects.toMatchObject({
      code: 'SYSTEM_DATABASE_UNAVAILABLE',
    });
    expect(work).not.toHaveBeenCalled();
    expect(counter.inc).toHaveBeenCalledTimes(2);
    expect(counter.inc).toHaveBeenNthCalledWith(1, {
      method: 'samples.findByEmail',
      outcome: 'error',
    });
    expect(records()).toHaveLength(2);
  });

  it('counts a failing work as an error, logs it once and rethrows the original error', async () => {
    const database = new SystemDatabase(systemDb);
    const failure = new Error('boom');
    await expect(
      SystemContext.run(REASON, () =>
        database.run(purge, async () => {
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
    expect(records()).toEqual([
      { systemMethod: 'samples.deleteExpired', scope: 'system', reason: REASON, outcome: 'error' },
    ]);
    expect(counter.inc).toHaveBeenCalledTimes(1);
    expect(counter.inc).toHaveBeenCalledWith({ method: 'samples.deleteExpired', outcome: 'error' });
  });

  it('refuses a method not made by defineSystemMethod (a hand-built scope cannot skip the check)', async () => {
    const database = new SystemDatabase(systemDb);
    const work = vi.fn(async () => 1);
    const forged: SystemMethod = { name: 'samples.deleteExpired', scope: 'pre-auth' };
    await expect(database.run(forged, work)).rejects.toThrow(/defineSystemMethod/);
    expect(work).not.toHaveBeenCalled();
  });

  it('SystemDatabaseError carries its code', () => {
    const error = new SystemDatabaseError('SYSTEM_DATABASE_UNAVAILABLE', 'no pool');
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'SystemDatabaseError',
      code: 'SYSTEM_DATABASE_UNAVAILABLE',
    });
  });

  it('does not expose the handle as a property', () => {
    const database = new SystemDatabase(systemDb);
    expect(Object.values(database)).not.toContain(systemDb);
  });
});
