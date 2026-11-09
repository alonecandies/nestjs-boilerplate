import { type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { getContextType } from '@platform/common';
import { type ThrottleConfig, throttleConfig } from '@platform/config';
import {
  type RateLimitBucket,
  RateLimitGuardBase,
  type RateLimitSubject,
} from './rate-limit-guard.base.js';
import { AUTH_THROTTLE_KEY, THROTTLER } from './throttle.constants.js';

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
 * Charges the `user` budget (user id, else client IP; scope `global`) and the `route` budget of a
 * `@RateLimit` policy. Register it AFTER `AuthModule` so `req.user` is set.
 */
@Injectable()
export class AppThrottlerGuard extends RateLimitGuardBase {
  // Property injection keeps ThrottlerGuard's own (decorated) constructor untouched.
  @Inject(throttleConfig.KEY)
  private readonly limits!: ThrottleConfig;

  protected override readonly enforced: ReadonlySet<string> = new Set<string>([
    THROTTLER.USER,
    THROTTLER.ROUTE,
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
    const bucket = super.bucketFor(request, subject);
    // Interim until task C2: @AuthThrottle() routes share ONE `auth` scope (F17) with the
    // THROTTLE_AUTH_* window instead of the global user budget.
    if (bucket?.throttler === THROTTLER.USER && this.isAuthThrottled(request.context)) {
      const { authLimit, authTtlMs } = this.limits;
      return { ...bucket, scope: 'auth', limit: authLimit, ttlMs: authTtlMs, blockMs: authTtlMs };
    }
    return bucket;
  }

  private isAuthThrottled(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(AUTH_THROTTLE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}
