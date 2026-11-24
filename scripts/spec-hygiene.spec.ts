import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TEST-1 guard: the specs the audit inventoried must not depend on the wall clock. A spec that
 * compares elapsed time to an upper bound fails from load alone; a fixed sleep before an absence
 * check passes vacuously when the machine is slow; a helper that closes its port-0 listener
 * before returning the number leaves a window in which a parallel fork takes the port.
 */
const root = join(import.meta.dirname, '..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

/** Every file under apps/, domains/ and libs/ (not node_modules or build output) that matches. */
function filesMatching(accept: (path: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (accept(entry.name)) found.push(relative(root, path));
    }
  };
  for (const top of ['apps', 'domains', 'libs']) walk(join(root, top));
  return found.sort();
}

/** The realtime e2e files: revocation is awaited as an event, a push that must not come is fenced. */
const REALTIME_E2E = [
  'apps/monolith/test/realtime-socket.e2e-spec.ts',
  'apps/gateway/test/realtime-socket.e2e-spec.ts',
  'apps/monolith/test/realtime-graphql.e2e-spec.ts',
  'apps/gateway/test/realtime-graphql.e2e-spec.ts',
];

/** The specs that bounded elapsed wall-clock time. */
const ELAPSED_BOUND_SPECS = [
  ...REALTIME_E2E,
  'libs/transport/src/kafka/kafka.health.spec.ts',
  'libs/redis/src/cache/redis-store.util.spec.ts',
  'libs/redis/src/throttler/redis-throttler.storage.spec.ts',
  'libs/observability/src/shutdown/telemetry-flush.service.spec.ts',
  'apps/gateway/test/app.e2e-spec.ts',
];

/** The specs that slept a fixed time before asserting an absence (or an ordering). */
const SLEEP_SPECS = [
  'apps/monolith/test/outbox.e2e-spec.ts',
  'apps/monolith/test/tenancy-events.e2e-spec.ts',
  'libs/outbox/src/outbox.module.spec.ts',
  'domains/ai/src/application/commands/stream-message/stream-message.handler.spec.ts',
  'domains/ai/src/application/commands/send-message/send-message.handler.spec.ts',
];

/** `expect(performance.now() - t)` or `expect(Date.now() - t)` followed by an upper-bound matcher. */
const ELAPSED_UPPER_BOUND =
  /(?:performance\.now\(\)|Date\.now\(\))\s*-\s*[\w.]+\s*\)\s*\.(?:toBeLessThan|toBeLessThanOrEqual)\(/;

/** `await new Promise((resolve) => setTimeout(resolve, 20))` and the like: a fixed sleep. */
const FIXED_SLEEP =
  /new Promise(?:<[^>]*>)?\(\s*\(?\s*resolve\s*\)?\s*=>\s*setTimeout\(\s*resolve\s*,/;

/**
 * `listen(0, ...)`, then `address()`, then `close(`: the port is read from a listener that is then
 * released, so a parallel fork can take it before the caller binds it.
 */
const CLOSE_THEN_REBIND = /\.listen\(\s*0\b[\s\S]*?\.address\(\)[\s\S]*?\.close\(/;

/**
 * The two Kafka container bootstraps: a container's advertised listener must name the host port
 * before the container starts, so the port has to be chosen first (an inherent window).
 */
const FREE_PORT_ALLOWED = [
  'libs/outbox/test/outbox-kafka-delivery.int-spec.ts',
  'libs/transport/test/support/kafka-container.ts',
];

describe('spec hygiene (TEST-1)', () => {
  it('finds the inventoried specs (the paths below are not stale)', () => {
    for (const file of [...ELAPSED_BOUND_SPECS, ...SLEEP_SPECS]) {
      expect(() => read(file), file).not.toThrow();
    }
  });

  it('no spec compares elapsed wall-clock time to an upper bound', () => {
    const offenders = ELAPSED_BOUND_SPECS.filter((file) => ELAPSED_UPPER_BOUND.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('no spec defines WITHIN_TWO_SWEEPS_MS, and the realtime suites have no QUIET_MS wait', () => {
    const specs = filesMatching((name) => /\.(?:e2e-)?spec\.ts$/.test(name));
    expect(specs.filter((file) => read(file).includes('WITHIN_TWO_SWEEPS_MS'))).toEqual([]);
    expect(REALTIME_E2E.filter((file) => /\bQUIET_MS\b/.test(read(file)))).toEqual([]);
  });

  it('the absence and ordering checks of the inventoried specs wait for a signal, not a sleep', () => {
    expect(SLEEP_SPECS.filter((file) => FIXED_SLEEP.test(read(file)))).toEqual([]);
  });

  it('there is exactly one definition of withBoundGrpcPort, in @platform/transport/testing', () => {
    const definitions = filesMatching((name) => name.endsWith('.ts')).filter((file) =>
      /\bfunction\s+withBoundGrpcPort\b/.test(read(file)),
    );
    expect(definitions).toEqual(['libs/transport/src/testing/bound-grpc-port.ts']);
  });

  it('no spec or test helper closes a port-0 listener to return its number', () => {
    const offenders = filesMatching((name) => name.endsWith('.ts')).filter(
      (file) =>
        (/\.(?:e2e-|int-)?spec\.ts$/.test(file) || /(?:^|\/)test\//.test(file)) &&
        !FREE_PORT_ALLOWED.includes(file) &&
        CLOSE_THEN_REBIND.test(read(file)),
    );
    expect(offenders).toEqual([]);
  });
});
