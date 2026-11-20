import { getOrCreateCounter } from '@platform/observability';
import type { RateLimitDecision } from './rate-limit-headers.js';

export const RATE_LIMIT_DECISIONS_TOTAL = 'rate_limit_decisions_total';

/** `blocked`: the bucket refused (429 or a graphql/ws refusal); `allowed`: anything else. */
export type RateLimitOutcome = 'allowed' | 'blocked';

const decisions = () =>
  getOrCreateCounter({
    name: RATE_LIMIT_DECISIONS_TOTAL,
    help: 'Rate-limit decisions, by throttler, policy scope and outcome (allowed, blocked)',
    labelNames: ['throttler', 'scope', 'outcome'],
  });

/**
 * Counts one rate-limit decision (G-10). Called once per charge, at the two places every decision
 * passes: `RateLimitGuardBase.recordDecision` (guards) and `RateLimitCharger.charge` (GraphQL cost,
 * graphql-ws, socket handshakes). Labels stay bounded: the throttler name, the policy scope (a
 * policy name or `global`, `cost`) and the outcome; never the tracker, key, IP, user or tenant.
 */
export function recordRateLimitDecision(decision: RateLimitDecision): void {
  const outcome: RateLimitOutcome = decision.blocked ? 'blocked' : 'allowed';
  decisions().inc({ throttler: decision.throttler, scope: decision.scope, outcome });
}
