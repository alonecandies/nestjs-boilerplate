import { createHash } from 'node:crypto';

/**
 * Bucket key = sha256 of `[throttler, scope, tracker]` (JSON-encoded, so no component can forge
 * another by containing a separator). Scope is a policy name or `global`, never a class or handler
 * name, so every route sharing a policy shares the bucket (F17). The digest keeps PII (IPs, ids,
 * email hashes) out of Redis key names.
 */
export function rateLimitKey(throttler: string, scope: string, tracker: string): string {
  return createHash('sha256')
    .update(JSON.stringify([throttler, scope, tracker]))
    .digest('hex');
}
