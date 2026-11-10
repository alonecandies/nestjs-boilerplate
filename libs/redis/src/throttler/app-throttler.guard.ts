import { type ExecutionContext, Injectable } from '@nestjs/common';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { getContextType } from '@platform/common';
import { credentialFrom, credentialHash } from './credential-tracker.util.js';
import { markLockoutAttempt } from './lockout.js';
import {
  type RateLimitBucket,
  RateLimitGuardBase,
  type RateLimitSubject,
} from './rate-limit-guard.base.js';
import { rateLimitKey } from './rate-limit-key.util.js';
import { THROTTLER } from './throttle.constants.js';

type HeaderSink = Record<string, unknown>;

/** graphql-ws subscriptions have no reply: give the guard a sink so header writes are no-ops. */
const NOOP_RESPONSE: HeaderSink = Object.freeze({ header: (): undefined => undefined });
const EMPTY_REQUEST: HeaderSink = Object.freeze({ headers: {} });

/** GraphQL context shape built by @platform/graphql (`{ req, reply }`); typed structurally. */
interface GqlContextLike {
  req?: HeaderSink;
  reply?: HeaderSink;
}

/**
 * Global throttler guard for HTTP and GraphQL (ws: `WsThrottlerGuard`; rpc: limited at the edge).
 * Charges the `user` budget (user id, else client IP; scope `global`), the `route` budget of a
 * `@RateLimit` policy and, for `credentials` policies, the `auth` bucket (sha256(email)+IP) plus the
 * per-account `lockout` bucket. Register it AFTER `AuthModule` so `req.user` is set.
 */
@Injectable()
export class AppThrottlerGuard extends RateLimitGuardBase {
  protected override readonly enforced: ReadonlySet<string> = new Set<string>([
    THROTTLER.USER,
    THROTTLER.ROUTE,
    THROTTLER.AUTH,
  ]);

  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const type = getContextType(context);
    return type === 'rpc' || type === 'ws';
  }

  protected override getRequestResponse(context: ExecutionContext): {
    req: HeaderSink;
    res: HeaderSink;
  } {
    if (getContextType(context) === 'graphql') {
      const gql = context.getArgByIndex<GqlContextLike | undefined>(2);
      return { req: gql?.req ?? EMPTY_REQUEST, res: gql?.reply ?? NOOP_RESPONSE };
    }
    return super.getRequestResponse(context);
  }

  protected override subjectOf(context: ExecutionContext): RateLimitSubject {
    const { req } = this.getRequestResponse(context);
    return { user: req['user'], ip: typeof req['ip'] === 'string' ? req['ip'] : undefined };
  }

  protected override responseOf(context: ExecutionContext): HeaderSink {
    return this.getRequestResponse(context).res;
  }

  protected override isIgnored(context: ExecutionContext): boolean {
    const agents = this.commonOptions.ignoreUserAgents;
    if (!Array.isArray(agents) || agents.length === 0) return false;
    const headers = this.getRequestResponse(context).req['headers'] as
      | Record<string, unknown>
      | undefined;
    const agent = headers?.['user-agent'];
    return typeof agent === 'string' && agents.some((pattern) => pattern.test(agent));
  }

  protected override bucketFor(
    request: ThrottlerRequest,
    subject: RateLimitSubject,
  ): RateLimitBucket | undefined {
    if ((request.throttler.name ?? THROTTLER.USER) !== THROTTLER.AUTH) {
      return super.bucketFor(request, subject);
    }
    const policy = this.policyFor(request.context);
    if (policy?.key !== 'credentials') return undefined;
    const credential = credentialHash(this.credentialOf(request.context, policy.credentialField));
    return {
      throttler: THROTTLER.AUTH,
      scope: policy.name,
      tracker: `cred:${credential}|${this.ipTracker(subject.ip)}`,
      limit: policy.limit,
      ttlMs: policy.ttlMs,
      blockMs: policy.blockMs ?? policy.ttlMs,
    };
  }

  /** After the `auth` bucket: the per-account lockout (any IP), reset on success. */
  protected override async handleRequest(request: ThrottlerRequest): Promise<boolean> {
    await super.handleRequest(request);
    // Subclasses (IpThrottlerGuard) that don't enforce `auth` must not touch the lockout either.
    if ((request.throttler.name ?? THROTTLER.USER) !== THROTTLER.AUTH) return true;
    if (!this.enforced.has(THROTTLER.AUTH)) return true;
    if (this.isIgnored(request.context)) return true;
    const policy = this.policyFor(request.context);
    if (policy?.key !== 'credentials' || policy.lockout === undefined) return true;
    const credential = credentialHash(this.credentialOf(request.context, policy.credentialField));
    if (credential === 'none') return true;
    const bucket: RateLimitBucket = {
      throttler: THROTTLER.LOCKOUT,
      scope: policy.name,
      tracker: `acct:${credential}`,
      limit: policy.lockout.threshold,
      ttlMs: policy.lockout.durationMs,
      blockMs: policy.lockout.durationMs,
    };
    await this.charge(request.context, bucket);
    const { req } = this.getRequestResponse(request.context);
    markLockoutAttempt(req, rateLimitKey(bucket.throttler, bucket.scope, bucket.tracker));
    return true;
  }

  /** The account identifier: HTTP body field, or GraphQL args (`input.<field>`). */
  private credentialOf(context: ExecutionContext, field = 'email'): unknown {
    if (getContextType(context) === 'graphql') {
      return credentialFrom(context.getArgByIndex<unknown>(1), field);
    }
    return credentialFrom(this.getRequestResponse(context).req['body'], field);
  }
}
