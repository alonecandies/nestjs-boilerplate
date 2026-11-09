import { type ExecutionContext, Injectable } from '@nestjs/common';
import { getContextType } from '@platform/common';
import { RateLimitGuardBase, type RateLimitSubject } from './rate-limit-guard.base.js';
import { THROTTLER } from './throttle.constants.js';

/** The parts of a socket.io `Socket` read here (structural → independent of socket.io copies). */
interface SocketLike {
  data?: { user?: unknown } | null;
  handshake?: { address?: string };
}

/**
 * Per-MESSAGE rate limiting for WebSocket gateways (the global `AppThrottlerGuard` skips `ws`).
 * Apply it on the gateway, never as APP_GUARD: `@UseGuards(WsThrottlerGuard)`, with
 * `@RateLimit('<domain>.<name>')` on handlers that need their own budget. Charges the global `user`
 * budget and the handler's policy. A blocked message raises `ThrottlerException` (429), which
 * `@UseWsExceptionFilter()` delivers as `{ ok: false, error }`. Requires `AppThrottlerModule`.
 */
@Injectable()
export class WsThrottlerGuard extends RateLimitGuardBase {
  protected override readonly enforced: ReadonlySet<string> = new Set<string>([
    THROTTLER.USER,
    THROTTLER.ROUTE,
  ]);

  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return getContextType(context) !== 'ws';
  }

  protected override subjectOf(context: ExecutionContext): RateLimitSubject {
    const client = context.switchToWs().getClient<SocketLike | undefined>();
    return { user: client?.data?.user, ip: client?.handshake?.address };
  }
}
