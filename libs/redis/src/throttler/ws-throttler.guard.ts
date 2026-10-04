import { getContextType } from '@app/common';
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
import { DEFAULT_THROTTLER_NAME } from './throttle.constants.js';
import { throttleTracker } from './throttle-tracker.util.js';

/** The parts of a socket.io `Socket` read here (structural → independent of socket.io copies). */
interface SocketLike {
  data?: { user?: unknown } | null;
  handshake?: { address?: string };
}

/**
 * Per-MESSAGE rate limiting for WebSocket gateways — the global `AppThrottlerGuard` skips `ws`
 * (there is no request/response to hang headers on). Apply it on the gateway, never as APP_GUARD:
 *
 * ```ts
 * @UseGuards(WsThrottlerGuard)
 * @WebSocketGateway({ namespace: '/notifications' })
 * export class NotificationsGateway { @Throttle({ default: { limit: 5, ttl: 10_000 } }) … }
 * ```
 *
 * Same Redis storage and limits as HTTP (`THROTTLE_*`, overridable with `@Throttle()`); tracker =
 * `user:<socket.data.user.id>` or the handshake address. A blocked message raises
 * `ThrottlerException` (429), which the WS exception filter reports to the client.
 * Requires `AppThrottlerModule` (it provides the throttler options + storage).
 */
@Injectable()
export class WsThrottlerGuard extends ThrottlerGuard {
  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return getContextType(context) !== 'ws';
  }

  protected override async handleRequest({
    context,
    limit,
    ttl,
    throttler,
    blockDuration,
    generateKey,
  }: ThrottlerRequest): Promise<boolean> {
    const client = context.switchToWs().getClient<SocketLike | undefined>();
    const tracker = throttleTracker(
      client?.data?.user,
      client?.handshake?.address,
      this.ipv6SubnetPrefix,
    );
    const name = throttler.name ?? DEFAULT_THROTTLER_NAME;
    const key = generateKey(context, tracker, name);
    const record = await this.storageService.increment(key, ttl, limit, blockDuration, name);
    if (record.isBlocked) {
      await this.throwThrottlingException(context, { limit, ttl, key, tracker, ...record });
    }
    return true;
  }
}
