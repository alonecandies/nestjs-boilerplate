import type { IncomingMessage } from 'node:http';
import { type ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { getContextType } from '@platform/common';
import { type AppConfig, appConfig } from '@platform/config';
import { type ClientIpResolver, createClientIpResolver } from './client-ip.util.js';
import { RateLimitGuardBase, type RateLimitSubject } from './rate-limit-guard.base.js';
import { THROTTLER } from './throttle.constants.js';

/** The parts of a socket.io `Socket` read here (structural → independent of socket.io copies). */
interface SocketLike {
  data?: { user?: unknown } | null;
  handshake?: { address?: string };
  request?: IncomingMessage;
}

/**
 * Per-MESSAGE rate limiting for WebSocket gateways (the global `AppThrottlerGuard` skips `ws`).
 * Apply it on the gateway, never as APP_GUARD: `@UseGuards(WsThrottlerGuard)`, with
 * `@RateLimit('<domain>.<name>')` on handlers that need their own budget. Charges the global `user`
 * and `tenant` budgets and the handler's policy. IP = the handshake request's client IP under `TRUST_PROXY`
 * (same rules as HTTP `req.ip`), else the handshake address. A blocked message raises `ThrottlerException` (429), which
 * `@UseWsExceptionFilter()` delivers as `{ ok: false, error }`. Requires `AppThrottlerModule`.
 */
@Injectable()
export class WsThrottlerGuard extends RateLimitGuardBase {
  protected override readonly enforced: ReadonlySet<string> = new Set<string>([
    THROTTLER.USER,
    THROTTLER.TENANT,
    THROTTLER.ROUTE,
  ]);

  @Optional()
  @Inject(appConfig.KEY)
  private readonly app?: AppConfig;

  private resolver: ClientIpResolver | undefined;

  private clientIp(client: SocketLike | undefined): string | undefined {
    this.resolver ??= createClientIpResolver(this.app?.trustProxy ?? false);
    return this.resolver(client?.request) ?? client?.handshake?.address;
  }

  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return getContextType(context) !== 'ws';
  }

  protected override subjectOf(context: ExecutionContext): RateLimitSubject {
    const client = context.switchToWs().getClient<SocketLike | undefined>();
    return { user: client?.data?.user, ip: this.clientIp(client) };
  }
}
