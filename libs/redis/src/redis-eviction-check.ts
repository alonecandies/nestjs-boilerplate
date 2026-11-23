import { Logger } from '@nestjs/common';
import { OperationTimeoutException, withTimeout } from '@platform/common';
import { getOrCreateGauge } from '@platform/observability';
import type { Redis } from 'ioredis';

export const REDIS_EVICTION_POLICY_SAFE = 'redis_eviction_policy_safe';

/**
 * How long the boot check waits for `INFO memory`: a fixed budget, independent of the throttler's
 * per-request timeout (that one is tuned for hot-path latency, this one only has to stop a dropped
 * connection from holding the boot, since the offline queue would keep the command pending).
 */
export const EVICTION_CHECK_TIMEOUT_MS = 2_000;

/** The only policy that never drops a key: queues, locks, the denylist and throttle counters need it. */
export const REQUIRED_EVICTION_POLICY = 'noeviction';

/** The `maxmemory_policy` line of an `INFO memory` report, `undefined` when the server hides it. */
export function readMaxmemoryPolicy(info: string): string | undefined {
  return /^maxmemory_policy:(\S+)\s*$/m.exec(info)?.[1];
}

/**
 * Boot check (OPS-5): this Redis holds the access-token denylist, BullMQ queues, locks and
 * throttle counters, so a policy that evicts keys under memory pressure silently un-revokes
 * tokens, loses jobs and releases locks. Reads `maxmemory_policy` from `INFO memory`, logs one
 * structured error line when it is not `noeviction`, and sets `redis_eviction_policy_safe`
 * (1 or 0). The gauge is not registered when the policy cannot be read (an `INFO` error, or a
 * managed Redis that hides it), so an alert on `== 0` never fires on a guess. Never throws: it
 * must not fail a boot over a diagnostic. Never stalls either: when `INFO` does not answer within
 * `timeoutMs` (default {@link EVICTION_CHECK_TIMEOUT_MS}) it logs one warning, leaves the gauge
 * absent and returns.
 */
export async function checkRedisEvictionPolicy(
  client: Redis,
  timeoutMs: number = EVICTION_CHECK_TIMEOUT_MS,
): Promise<void> {
  const logger = new Logger('RedisEvictionCheck');
  let policy: string | undefined;
  try {
    policy = readMaxmemoryPolicy(await withTimeout(client.info('memory'), timeoutMs));
  } catch (error) {
    if (error instanceof OperationTimeoutException) {
      logger.warn(
        { event: 'redis_eviction_check_timeout', timeoutMs },
        `INFO memory did not answer within ${timeoutMs} ms, eviction policy not checked`,
      );
      return;
    }
    logger.debug(
      `INFO memory failed, eviction policy not checked: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (policy === undefined) return;
  const safe = policy === REQUIRED_EVICTION_POLICY;
  getOrCreateGauge({
    name: REDIS_EVICTION_POLICY_SAFE,
    help: '1 when the Redis maxmemory-policy is noeviction, 0 when it can evict keys (absent when unreadable)',
  }).set(safe ? 1 : 0);
  if (!safe) {
    logger.error(
      { event: 'redis_eviction_policy_unsafe', policy, required: REQUIRED_EVICTION_POLICY },
      `Redis maxmemory-policy is "${policy}", not "${REQUIRED_EVICTION_POLICY}": under memory pressure it can evict the token denylist, queued jobs, locks and throttle counters. Set maxmemory-policy noeviction and appendonly yes.`,
    );
  }
}
