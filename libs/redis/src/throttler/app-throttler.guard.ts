import { getContextType } from '@app/common';
import { type ThrottleConfig, throttleConfig } from '@app/config';
import { type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
import { AUTH_THROTTLE_KEY, DEFAULT_THROTTLER_NAME } from './throttle.constants.js';
import { throttleTracker } from './throttle-tracker.util.js';

type HeaderSink = Record<string, unknown>;

/** graphql-ws subscriptions have no reply: give the guard a sink so header writes are no-ops. */
const NOOP_RESPONSE: HeaderSink = Object.freeze({ header: (): undefined => undefined });
const EMPTY_REQUEST: HeaderSink = Object.freeze({ headers: {} });

/** GraphQL context shape built by @app/graphql (`{ req, reply }`); typed structurally. */
interface GqlContextLike {
  req?: HeaderSink;
  reply?: HeaderSink;
}

/**
 * Global throttler guard, transport-aware (hybrid apps run global guards for every transport):
 * - `http` / `graphql` are throttled (graphql through the `{ req, reply }` context),
 * - `ws` is skipped (use `WsThrottlerGuard` on gateways), `rpc` is skipped (gRPC/Kafka traffic is
 *   service-to-service and already limited at the edge),
 * - tracker = `user:<id>` when `JwtAuthGuard` authenticated the request, else `ip:<client ip>`
 *   (Fastify `req.ip` honours `trustProxy`; IPv6 is normalised to its /64 like the default),
 * - `@AuthThrottle()` handlers use the stricter `THROTTLE_AUTH_*` window.
 *
 * Per-user tracking needs the auth guard to run first: import `AuthModule` before
 * `AppThrottlerModule` (global guards run in module-registration order).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  // Property injection keeps ThrottlerGuard's own (decorated) constructor untouched.
  @Inject(throttleConfig.KEY)
  private readonly limits!: ThrottleConfig;

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

  protected override async getTracker(req: HeaderSink): Promise<string> {
    return throttleTracker(req.user, req.ip, this.ipv6SubnetPrefix);
  }

  protected override async handleRequest(request: ThrottlerRequest): Promise<boolean> {
    if (
      request.throttler.name === DEFAULT_THROTTLER_NAME &&
      this.isAuthThrottled(request.context)
    ) {
      const { authLimit, authTtlMs } = this.limits;
      return super.handleRequest({
        ...request,
        limit: authLimit,
        ttl: authTtlMs,
        blockDuration: authTtlMs,
      });
    }
    return super.handleRequest(request);
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
