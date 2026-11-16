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
 * Global budgets already charged for one GraphQL request (one operation, many root resolvers): the
 * refusal to repeat (`ThrottlerLimitDetail`) or `null` when the budget admitted the request. graphql-ws
 * builds a fresh `req` per operation (`buildWsRequest`), so subscriptions are charged once each.
 */
const chargedGraphqlRequests = new WeakMap<object, Map<string, ThrottlerLimitDetail | null>>();

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

  /** The bucket `request.throttler` charges, or `undefined` when it does not apply here. */
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
      case THROTTLER.ROUTE: {
        const policy = this.policyFor(request.context);
        if (policy === undefined || policy.key === 'credentials') return undefined;
        return {
          throttler: name,
          scope: policy.name,
          tracker: policy.key === 'ip' ? this.ipTracker(subject.ip) : this.userTracker(subject),
          limit: policy.limit,
          ttlMs: policy.ttlMs,
          blockMs: policy.blockMs ?? policy.ttlMs,
        };
      }
      default:
        return undefined;
    }
  }

  protected override async handleRequest(request: ThrottlerRequest): Promise<boolean> {
    const name = request.throttler.name ?? THROTTLER.USER;
    if (!this.enforced.has(name) || this.isIgnored(request.context)) return true;
    const bucket = this.bucketFor(request, this.subjectOf(request.context));
    if (bucket === undefined) return true;
    await this.charge(request.context, bucket);
    return true;
  }

  /** Increments `bucket`; throws `ThrottlerException` (429, `Retry-After`) when it is blocked. */
  protected async charge(context: ExecutionContext, bucket: RateLimitBucket): Promise<void> {
    let charged: Map<string, ThrottlerLimitDetail | null> | undefined;
    if (bucket.scope === GLOBAL_SCOPE && getContextType(context) === 'graphql') {
      const req = context.getArgByIndex<{ req?: object } | undefined>(2)?.req;
      if (req !== undefined) {
        charged = chargedGraphqlRequests.get(req) ?? new Map<string, ThrottlerLimitDetail | null>();
        chargedGraphqlRequests.set(req, charged);
        if (charged.has(bucket.throttler)) {
          const refusal = charged.get(bucket.throttler);
          if (refusal) await this.throwThrottlingException(context, refusal);
          return;
        }
      }
    }
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
    const detail: ThrottlerLimitDetail = {
      limit: bucket.limit,
      ttl: bucket.ttlMs,
      key,
      tracker: bucket.tracker,
      ...record,
    };
    charged?.set(bucket.throttler, record.isBlocked ? detail : null);
    if (!record.isBlocked) return;
    const res = this.responseOf(context);
    if (res !== undefined) this.setResponseHeader(res, 'Retry-After', record.timeToBlockExpire);
    await this.throwThrottlingException(context, detail);
  }

  /**
   * Every guard decision passes here: writes the IETF headers (all budgets of this response, both
   * guards) and is the hook for decision metrics (G-10: count at the TOP of this method, before the
   * early returns, so lockout and WebSocket decisions are counted too). The lockout bucket is never
   * advertised.
   */
  protected recordDecision(context: ExecutionContext, decision: RateLimitDecision): void {
    if (decision.throttler === THROTTLER.LOCKOUT) return;
    const res = this.responseOf(context);
    if (res === undefined) return;
    const all = collectDecision(res, decision);
    this.setResponseHeader(res, 'RateLimit-Policy', formatRateLimitPolicy(all));
    this.setResponseHeader(res, 'RateLimit', formatRateLimit(all));
  }
}
