import { GLOBAL_SCOPE } from './throttle.constants.js';

/** One budget's outcome for one request (headers here; decision metrics in G-10). */
export interface RateLimitDecision {
  throttler: string;
  scope: string;
  limit: number;
  ttlMs: number;
  remaining: number;
  resetSeconds: number;
  blocked: boolean;
  retryAfterSeconds: number;
}

/** Display order of the list members (unknown names sort last, alphabetically). */
export const RATE_LIMIT_HEADER_ORDER: readonly string[] = Object.freeze([
  'ip',
  'user',
  'tenant',
  'graphql',
  'route',
  'auth',
]);

export function policyItemName(decision: Pick<RateLimitDecision, 'throttler' | 'scope'>): string {
  return decision.scope === GLOBAL_SCOPE
    ? decision.throttler
    : `${decision.throttler}:${decision.scope}`;
}

/** RFC 9651 sf-string (policy names are ASCII by construction; escape anyway). */
const sfString = (value: string): string => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

const windowSeconds = (ttlMs: number): number => Math.max(1, Math.ceil(ttlMs / 1_000));

/** `RateLimit-Policy: "user";q=100;w=60, …` (draft-ietf-httpapi-ratelimit-headers-11 §3). */
export function formatRateLimitPolicy(decisions: readonly RateLimitDecision[]): string {
  return decisions
    .map((d) => `${sfString(policyItemName(d))};q=${d.limit};w=${windowSeconds(d.ttlMs)}`)
    .join(', ');
}

/** `RateLimit: "user";r=99;t=60, …` (draft-ietf-httpapi-ratelimit-headers-11 §4). */
export function formatRateLimit(decisions: readonly RateLimitDecision[]): string {
  return decisions
    .map((d) => `${sfString(policyItemName(d))};r=${d.remaining};t=${d.resetSeconds}`)
    .join(', ');
}

const rank = (d: RateLimitDecision): number => {
  const index = RATE_LIMIT_HEADER_ORDER.indexOf(d.throttler);
  return index === -1 ? RATE_LIMIT_HEADER_ORDER.length : index;
};

/**
 * The more restrictive of two decisions for one item name: a blocked one, then the lower
 * remaining, then the larger reset. Two partitions of one policy (a public field charging
 * `ip:<addr>`, an authenticated one charging `user:<id>`) share a name, so the header must not
 * depend on which charge settled last. On a full tie the earlier one stays.
 */
function moreRestrictive(a: RateLimitDecision, b: RateLimitDecision): RateLimitDecision {
  if (a.blocked !== b.blocked) return a.blocked ? a : b;
  if (a.remaining !== b.remaining) return a.remaining < b.remaining ? a : b;
  return b.resetSeconds > a.resetSeconds ? b : a;
}

const collected = new WeakMap<object, Map<string, RateLimitDecision>>();

/**
 * Adds `decision` to the response's set (both guards share it) and returns the ordered list.
 * A name that was already collected keeps its more restrictive decision.
 */
export function collectDecision(
  response: object,
  decision: RateLimitDecision,
): RateLimitDecision[] {
  const byName = collected.get(response) ?? new Map<string, RateLimitDecision>();
  const name = policyItemName(decision);
  const previous = byName.get(name);
  byName.set(name, previous ? moreRestrictive(previous, decision) : decision);
  collected.set(response, byName);
  return [...byName.values()].sort(
    (a, b) => rank(a) - rank(b) || policyItemName(a).localeCompare(policyItemName(b)),
  );
}
