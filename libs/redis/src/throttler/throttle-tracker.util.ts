import { normalizeIp } from '@nestjs/throttler';
import { isNonEmptyString } from '../keys/key.util.js';

/** Reads `user.id` from an authenticated principal without depending on @app/auth (no cycle). */
export function authenticatedUserId(user: unknown): string | undefined {
  if (typeof user !== 'object' || user === null) return undefined;
  const id: unknown = Reflect.get(user, 'id');
  return isNonEmptyString(id) ? id : undefined;
}

/**
 * Throttle tracker: `user:<id>` for authenticated principals (fair per account, NAT-proof),
 * otherwise `ip:<address>` with IPv6 collapsed to its subnet (default /64 — a single client
 * controls a whole /64, so per-address limits would be trivially bypassed).
 */
export function throttleTracker(user: unknown, ip: unknown, ipv6SubnetPrefix: number): string {
  const userId = authenticatedUserId(user);
  if (userId) return `user:${userId}`;
  return isNonEmptyString(ip) ? `ip:${normalizeIp(ip, ipv6SubnetPrefix)}` : 'ip:unknown';
}
