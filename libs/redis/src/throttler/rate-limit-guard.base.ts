import { type ExecutionContext, Inject } from '@nestjs/common';
import {
  normalizeIp,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerRequest,
} from '@nestjs/throttler';
import { getContextType } from '@platform/common';
import {
  collectDecision,
  formatRateLimit,
  formatRateLimitPolicy,
  type RateLimitDecision,
} from './rate-limit-headers.js';
import { rateLimitKey } from './rate-limit-key.util.js';
import { recordRateLimitDecision } from './rate-limit-metrics.js';
import { type RateLimitPolicy, RateLimitPolicyRegistry } from './rate-limit-policy.js';
import { GLOBAL_SCOPE, RATE_LIMIT_POLICY_KEY, THROTTLER } from './throttle.constants.js';
import { authenticatedTenantId, authenticatedUserId } from './throttle-tracker.util.js';

/** Who a request or message is charged to. `user` is read structurally (`{ id }`). */
export interface RateLimitSubject {
  readonly user?: unknown;
  readonly ip?: string | undefined;
}

/** One bucket a throttler charges for one request. */
export interface RateLimitBucket {
  throttler: string;
  scope: string;
  tracker: string;
  limit: number;
  ttlMs: number;
  blockMs: number;
}

/**
 * Global budgets charged for one GraphQL request (one operation, many root resolvers), per
 * `throttler|tracker` (a `@Public` field charges `ip:<addr>`, an authenticated one `user:<id>`):
 * the charge in flight, settling to the refusal to repeat (`ThrottlerLimitDetail`) or `null` when the
 * budget admitted the request. The promise goes in the map BEFORE the storage is awaited: graphql-js
 * starts every root field of a query in one synchronous loop, so a value stored only after the await
 * would let each field charge again. graphql-ws builds a fresh `req` per operation
 * (`buildWsRequest`), so subscriptions are charged once each.
 */
const chargedGraphqlRequests = new WeakMap<
  object,
  Map<string, Promise<ThrottlerLimitDetail | null>>
>();

/**
 * Shared logic of the HTTP/GraphQL, pre-auth IP and WebSocket guards. `ThrottlerGuard.canActivate`
 * loops over EVERY configured throttler; each subclass enforces only the names in `enforced` and
 * maps the rest to "not charged". Keys are scope-based (`rateLimitKey`), never class/handler-based.
 */
export abstract class RateLimitGuardBase extends ThrottlerGuard {
  @Inject(RateLimitPolicyRegistry)
  protected readonly policies!: RateLimitPolicyRegistry;

  /** Throttler names this guard charges. */
  protected abstract readonly enforced: ReadonlySet<string>;

  protected abstract subjectOf(context: ExecutionContext): RateLimitSubject;

  /** Where `Retry-After` goes (HTTP reply); `undefined` for transports without headers. */
  protected responseOf(_context: ExecutionContext): Record<string, unknown> | undefined {
    return undefined;
  }

  /** `true` → the request is not charged at all (ignored user agents). */
  protected isIgnored(_context: ExecutionContext): boolean {
    return false;
  }

  protected policyFor(context: ExecutionContext): RateLimitPolicy | undefined {
    const name = this.reflector.getAllAndOverride<string | undefined>(RATE_LIMIT_POLICY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return name === undefined ? undefined : this.policies.require(name);
  }

  protected ipTracker(ip: string | undefined): string {
    return ip ? `ip:${normalizeIp(ip, this.ipv6SubnetPrefix)}` : 'ip:unknown';
  }

  protected userTracker(subject: RateLimitSubject): string {
    const id = authenticatedUserId(subject.user);
    return id ? `user:${id}` : this.ipTracker(subject.ip);
  }

  /**
   * The bucket a global (non-route) `request.throttler` charges, or `undefined` when it does not
   * apply here. The `route` throttler is resolved by `bucketsFor`.
   */
  protected bucketFor(
    request: ThrottlerRequest,
    subject: RateLimitSubject,
  ): RateLimitBucket | undefined {
    const name = request.throttler.name ?? THROTTLER.USER;
    const global = {
      throttler: name,
      scope: GLOBAL_SCOPE,
      limit: request.limit,
      ttlMs: request.ttl,
      blockMs: request.blockDuration,
    };
    switch (name) {
      case THROTTLER.IP:
        return { ...global, tracker: this.ipTracker(subject.ip) };
      case THROTTLER.USER:
        return { ...global, tracker: this.userTracker(subject) };
      case THROTTLER.TENANT: {
        const tenantId = authenticatedTenantId(subject.user);
        return tenantId === undefined ? undefined : { ...global, tracker: `tenant:${tenantId}` };
      }
      default:
        return undefined;
    }
  }

  /**
   * The buckets `request.throttler` charges for this request, in charging order. The `route`
   * throttler resolves the route's policy once: the member's bucket first, then the policy's
   * `tenant` budget (one bucket per active tenant, scope = the policy name, its own key and header
   * item, `"tenant:<policy>"`) when the policy has one and the caller has a tenant. Every other
   * throttler charges the single bucket of `bucketFor`.
   */
  protected bucketsFor(request: ThrottlerRequest, subject: RateLimitSubject): RateLimitBucket[] {
    if ((request.throttler.name ?? THROTTLER.USER) !== THROTTLER.ROUTE) {
      const bucket = this.bucketFor(request, subject);
      return bucket === undefined ? [] : [bucket];
    }
    const policy = this.policyFor(request.context);
    if (policy === undefined) return [];
    const buckets: RateLimitBucket[] = [];
    if (policy.key !== 'credentials') {
      buckets.push({
        throttler: THROTTLER.ROUTE,
        scope: policy.name,
        tracker: policy.key === 'ip' ? this.ipTracker(subject.ip) : this.userTracker(subject),
        limit: policy.limit,
        ttlMs: policy.ttlMs,
        blockMs: policy.blockMs ?? policy.ttlMs,
      });
    }
    const tenantId = authenticatedTenantId(subject.user);
    if (policy.tenant !== undefined && tenantId !== undefined) {
      buckets.push({
        throttler: THROTTLER.TENANT,
        scope: policy.name,
        tracker: `tenant:${tenantId}`,
        limit: policy.tenant.limit,
        ttlMs: policy.tenant.ttlMs,
        blockMs: policy.tenant.blockMs ?? policy.tenant.ttlMs,
      });
    }
    return buckets;
  }

  protected override async handleRequest(request: ThrottlerRequest): Promise<boolean> {
    const name = request.throttler.name ?? THROTTLER.USER;
    if (!this.enforced.has(name) || this.isIgnored(request.context)) return true;
    const subject = this.subjectOf(request.context);
    // In order: `charge` throws on a refusal, so a member over their own limit never spends the
    // tenant's budget.
    for (const bucket of this.bucketsFor(request, subject)) {
      await this.charge(request.context, bucket);
    }
    return true;
  }

  /** Increments `bucket`; throws `ThrottlerException` (429, `Retry-After`) when it is blocked. */
  protected async charge(context: ExecutionContext, bucket: RateLimitBucket): Promise<void> {
    const charged = this.graphqlChargesOf(context, bucket);
    // Keyed by tracker too: a `@Public` root field runs before `req.user` is set, so it charges
    // `ip:<addr>`; the authenticated fields after it must still charge `user:<id>` once.
    const chargeKey = `${bucket.throttler}|${bucket.tracker}`;
    let pending = charged?.get(chargeKey);
    if (pending === undefined) {
      pending = this.chargeStorage(context, bucket);
      charged?.set(chargeKey, pending);
    }
    const refusal = await pending;
    if (refusal === null) return;
    const res = this.responseOf(context);
    if (res !== undefined) this.setResponseHeader(res, 'Retry-After', refusal.timeToBlockExpire);
    await this.throwThrottlingException(context, refusal);
  }

  /** The charges of this GraphQL request, for a global budget; `undefined` when not shared. */
  private graphqlChargesOf(
    context: ExecutionContext,
    bucket: RateLimitBucket,
  ): Map<string, Promise<ThrottlerLimitDetail | null>> | undefined {
    if (bucket.scope !== GLOBAL_SCOPE || getContextType(context) !== 'graphql') return undefined;
    const req = context.getArgByIndex<{ req?: object } | undefined>(2)?.req;
    if (req === undefined) return undefined;
    let charged = chargedGraphqlRequests.get(req);
    if (charged === undefined) {
      charged = new Map();
      chargedGraphqlRequests.set(req, charged);
    }
    return charged;
  }

  /** Charges the storage once and records the decision; resolves to the refusal, else `null`. */
  private async chargeStorage(
    context: ExecutionContext,
    bucket: RateLimitBucket,
  ): Promise<ThrottlerLimitDetail | null> {
    const key = rateLimitKey(bucket.throttler, bucket.scope, bucket.tracker);
    const record = await this.storageService.increment(
      key,
      bucket.ttlMs,
      bucket.limit,
      bucket.blockMs,
      bucket.throttler,
    );
    this.recordDecision(context, {
      throttler: bucket.throttler,
      scope: bucket.scope,
      limit: bucket.limit,
      ttlMs: bucket.ttlMs,
      remaining: record.isBlocked ? 0 : Math.max(0, bucket.limit - record.totalHits),
      resetSeconds: record.isBlocked ? record.timeToBlockExpire : record.timeToExpire,
      blocked: record.isBlocked,
      retryAfterSeconds: record.isBlocked ? record.timeToBlockExpire : 0,
    });
    if (!record.isBlocked) return null;
    return { limit: bucket.limit, ttl: bucket.ttlMs, key, tracker: bucket.tracker, ...record };
  }

  /**
   * Every guard decision passes here: counts it (`rate_limit_decisions_total`, G-10: first, before
   * the early returns, so lockout and WebSocket decisions are counted too) and writes the IETF
   * headers (all budgets of this response, both guards). The lockout bucket is never advertised.
   */
  protected recordDecision(context: ExecutionContext, decision: RateLimitDecision): void {
    recordRateLimitDecision(decision);
    if (decision.throttler === THROTTLER.LOCKOUT) return;
    const res = this.responseOf(context);
    if (res === undefined) return;
    const all = collectDecision(res, decision);
    this.setResponseHeader(res, 'RateLimit-Policy', formatRateLimitPolicy(all));
    this.setResponseHeader(res, 'RateLimit', formatRateLimit(all));
  }
}
