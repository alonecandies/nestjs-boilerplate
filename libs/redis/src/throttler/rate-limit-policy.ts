import { Injectable } from '@nestjs/common';

/** What a policy bucket is keyed by: client IP, user (falling back to IP), or credential + IP. */
export type RateLimitKeyKind = 'ip' | 'user' | 'credentials';

/** Consecutive non-successful attempts per account before it is refused for `durationMs`. */
export interface RateLimitLockout {
  readonly threshold: number;
  readonly durationMs: number;
}

/** A named route policy, declared by the owning domain (`RateLimitModule.forFeature`). */
export interface RateLimitPolicy {
  /** `<domain>.<name>`, lower-case kebab parts, e.g. `orders.credentials`, `files.upload`. */
  readonly name: string;
  readonly key: RateLimitKeyKind;
  readonly limit: number;
  readonly ttlMs: number;
  /** Block after the limit is exceeded (default `ttlMs`; `0` = reject until the window resets). */
  readonly blockMs?: number;
  /** Body / GraphQL input field holding the account identifier (default `email`). */
  readonly credentialField?: string;
  readonly lockout?: RateLimitLockout;
}

export const RATE_LIMIT_POLICY_NAME = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

const isPositiveInt = (value: number): boolean => Number.isInteger(value) && value >= 1;

function assertValidPolicy(policy: RateLimitPolicy): void {
  const fail = (why: string): never => {
    throw new Error(`Invalid rate-limit policy "${policy.name}": ${why}`);
  };
  if (!RATE_LIMIT_POLICY_NAME.test(policy.name)) {
    fail('name must look like "<domain>.<name>" (lower-case kebab parts)');
  }
  if (!isPositiveInt(policy.limit)) fail('limit must be an integer >= 1');
  if (!isPositiveInt(policy.ttlMs)) fail('ttlMs must be an integer >= 1');
  if (policy.blockMs !== undefined && !(Number.isInteger(policy.blockMs) && policy.blockMs >= 0)) {
    fail('blockMs must be an integer >= 0');
  }
  if (
    policy.key !== 'credentials' &&
    (policy.lockout !== undefined || policy.credentialField !== undefined)
  ) {
    fail('lockout and credentialField need key "credentials"');
  }
  if (
    policy.lockout !== undefined &&
    !(isPositiveInt(policy.lockout.threshold) && isPositiveInt(policy.lockout.durationMs))
  ) {
    fail('lockout threshold and durationMs must be integers >= 1');
  }
}

/** Process-wide registry of named policies (provided globally by `AppThrottlerModule`). */
@Injectable()
export class RateLimitPolicyRegistry {
  private readonly policies = new Map<string, RateLimitPolicy>();

  register(policies: readonly RateLimitPolicy[]): void {
    for (const policy of policies) {
      assertValidPolicy(policy);
      if (this.policies.has(policy.name)) {
        throw new Error(`Rate-limit policy "${policy.name}" is registered twice`);
      }
      this.policies.set(policy.name, Object.freeze({ ...policy }));
    }
  }

  get(name: string): RateLimitPolicy | undefined {
    return this.policies.get(name);
  }

  require(name: string): RateLimitPolicy {
    const policy = this.policies.get(name);
    if (policy === undefined) throw new Error(`Unknown rate-limit policy "${name}"`);
    return policy;
  }

  names(): string[] {
    return [...this.policies.keys()].sort();
  }
}
