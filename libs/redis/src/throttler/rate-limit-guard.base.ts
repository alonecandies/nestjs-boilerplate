import { type ExecutionContext, Inject } from '@nestjs/common';
import { normalizeIp, ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
import { rateLimitKey } from './rate-limit-key.util.js';
import { type RateLimitPolicy, RateLimitPolicyRegistry } from './rate-limit-policy.js';
import { GLOBAL_SCOPE, RATE_LIMIT_POLICY_KEY, THROTTLER } from './throttle.constants.js';
import { authenticatedUserId } from './throttle-tracker.util.js';

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
    const key = rateLimitKey(bucket.throttler, bucket.scope, bucket.tracker);
    const record = await this.storageService.increment(
      key,
      bucket.ttlMs,
      bucket.limit,
      bucket.blockMs,
      bucket.throttler,
    );
    if (!record.isBlocked) return;
    const res = this.responseOf(context);
    if (res !== undefined) this.setResponseHeader(res, 'Retry-After', record.timeToBlockExpire);
    await this.throwThrottlingException(context, {
      limit: bucket.limit,
      ttl: bucket.ttlMs,
      key,
      tracker: bucket.tracker,
      ...record,
    });
  }
}
