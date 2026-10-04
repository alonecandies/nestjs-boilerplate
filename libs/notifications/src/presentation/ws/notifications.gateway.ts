import {
  AccessTokenDenylist,
  AuthErrorCode,
  type AuthUser,
  authenticateSocket,
  CurrentUser,
  extractSocketToken,
  Permission,
  RequirePermissions,
  TokenService,
} from '@app/auth';
import { toProblemDetails, UnauthenticatedException } from '@app/common';
import { Throttle, WsThrottlerGuard } from '@app/redis';
import { Logger, type OnModuleDestroy, UseGuards } from '@nestjs/common';
import {
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type WsResponse,
} from '@nestjs/websockets';
import type { DefaultEventsMap, ExtendedError, Namespace, Socket } from 'socket.io';
import { NotificationsPort } from '../../application/ports/notifications.port.js';
import {
  NOTIFICATIONS_WS_EVENTS,
  NOTIFICATIONS_WS_NAMESPACE,
  userRoom,
} from '../../notifications.constants.js';
import type { NotificationResponse } from '../http/notifications.dto.js';
import {
  type MarkReadAck,
  type MarkReadMessage,
  markReadMessageSchema,
} from './notifications-ws.schemas.js';
import { WsSessionGuard } from './ws-session.guard.js';

/** `socket.data` of this namespace: the user authenticated at the handshake. */
export interface NotificationsSocketData {
  user?: AuthUser;
}

export type NotificationsSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  NotificationsSocketData
>;

export type NotificationsNamespace = Namespace<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  NotificationsSocketData
>;

/** How often each replica disconnects its sockets whose access token was revoked (logout). */
export const WS_REVOCATION_SWEEP_INTERVAL_MS = 30_000;

/** `setTimeout` fires at once beyond this delay (~24.8 days), so longer expiries are capped. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * socket.io namespace `/notifications`.
 * - Handshake: a namespace middleware verifies the access token (`auth.token`, or
 *   `Authorization: Bearer`) once, including the revocation denylist, BEFORE the connection is
 *   accepted — so no message can race the authentication. A refused client gets `connect_error`
 *   whose `data` is the problem details (`code` MISSING_TOKEN / TOKEN_EXPIRED / …).
 * - Connection: the socket joins room `user:<id>`.
 * - Session lifetime: tokens are short-lived but sockets are not. The socket is sent an
 *   `exception` (TOKEN_EXPIRED) and disconnected when its access token expires, and every
 *   `WS_REVOCATION_SWEEP_INTERVAL_MS` each replica disconnects its sockets whose token was
 *   revoked (logout → denylist; `exception` TOKEN_REVOKED). Clients reconnect with a fresh token,
 *   so pushes stop reaching a session that HTTP would already reject.
 * - Messages: the global guards run per message (`JwtAuthGuard` checks `socket.data.user` is
 *   still unexpired, then RBAC), then `WsSessionGuard` (denylist, like HTTP) and per-message
 *   throttling (`WsThrottlerGuard`, Redis-backed).
 * - Pushes: `NotificationPushConsumer` calls `pushToUser`; with `RedisIoAdapter` the room emit
 *   reaches the user's sockets on every replica.
 */
@UseGuards(WsSessionGuard, WsThrottlerGuard)
@WebSocketGateway({ namespace: NOTIFICATIONS_WS_NAMESPACE })
export class NotificationsGateway
  implements
    OnGatewayInit<NotificationsNamespace>,
    OnGatewayConnection<NotificationsSocket>,
    OnGatewayDisconnect<NotificationsSocket>,
    OnModuleDestroy
{
  private readonly logger = new Logger(NotificationsGateway.name);
  private readonly expiryTimers = new WeakMap<NotificationsSocket, NodeJS.Timeout>();
  private revocationSweep: NodeJS.Timeout | undefined;
  private sweeping = false;

  @WebSocketServer()
  private readonly server: NotificationsNamespace;

  constructor(
    private readonly tokens: TokenService,
    private readonly denylist: AccessTokenDenylist,
    private readonly notifications: NotificationsPort,
  ) {}

  afterInit(namespace: NotificationsNamespace): void {
    namespace.use((socket, next) => {
      void this.authenticate(socket).then(next);
    });
    this.revocationSweep = setInterval(() => {
      void this.disconnectRevokedSockets();
    }, WS_REVOCATION_SWEEP_INTERVAL_MS);
    this.revocationSweep.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.revocationSweep);
    this.revocationSweep = undefined;
  }

  /** Resolves `undefined` (accept) or the error to refuse the handshake with. */
  async authenticate(socket: NotificationsSocket): Promise<ExtendedError | undefined> {
    try {
      socket.data.user = await authenticateSocket(
        this.tokens,
        this.denylist,
        extractSocketToken(socket.handshake),
      );
      return undefined;
    } catch (error) {
      const problem = toProblemDetails(error, { exposeInternal: false });
      this.logger.debug(`Refused socket ${socket.id}: ${problem.code}`);
      return Object.assign(new Error(problem.detail ?? problem.title), { data: problem });
    }
  }

  async handleConnection(client: NotificationsSocket): Promise<void> {
    const user = client.data.user;
    if (!user) {
      // Unreachable while the middleware is installed; never leave an anonymous socket open.
      client.disconnect(true);
      return;
    }
    await client.join(userRoom(user.id));
    this.scheduleExpiry(client, user.exp);
  }

  handleDisconnect(client: NotificationsSocket): void {
    clearTimeout(this.expiryTimers.get(client));
    this.expiryTimers.delete(client);
  }

  /**
   * Disconnects this replica's sockets whose access token is on the denylist (each replica sweeps
   * its own sockets, so it works the same in every topology: logout may run in identity-service).
   * One EXISTS per distinct token, auto-pipelined. If Redis cannot answer, sockets are kept until
   * the next sweep (messages still fail closed in `WsSessionGuard`). Resolves the number of
   * sockets disconnected.
   */
  async disconnectRevokedSockets(): Promise<number> {
    if (this.sweeping || !this.denylist.enabled) return 0;
    this.sweeping = true;
    try {
      const byJti = new Map<string, NotificationsSocket[]>();
      for (const socket of this.server.sockets.values()) {
        const jti = socket.data.user?.jti;
        if (jti !== undefined) byJti.set(jti, [...(byJti.get(jti) ?? []), socket]);
      }
      const jtis = [...byJti.keys()];
      const denied = await Promise.all(jtis.map((jti) => this.denylist.isDenied(jti)));
      const revoked = jtis
        .filter((_, index) => denied[index])
        .flatMap((jti) => byJti.get(jti) ?? []);
      for (const socket of revoked) {
        this.endSession(socket, AuthErrorCode.TOKEN_REVOKED, 'Token has been revoked');
      }
      if (revoked.length > 0) {
        this.logger.debug(`Disconnected ${revoked.length} socket(s) with a revoked access token`);
      }
      return revoked.length;
    } catch (error) {
      this.logger.warn(
        `Revocation sweep skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.sweeping = false;
    }
  }

  /** Marks a notification read; the return value is the socket.io ack. */
  @SubscribeMessage(NOTIFICATIONS_WS_EVENTS.MARK_READ)
  @RequirePermissions(Permission.NotificationsRead)
  @Throttle({ default: { limit: 30, ttl: 10_000 } })
  async markRead(
    @MessageBody({ schema: markReadMessageSchema }) body: MarkReadMessage,
    @CurrentUser('id') userId: string,
  ): Promise<MarkReadAck> {
    await this.notifications.markRead({ userId, notificationId: body.id });
    return { ok: true };
  }

  /** Application-level liveness check, answered with a `pong` event. */
  @SubscribeMessage(NOTIFICATIONS_WS_EVENTS.PING)
  ping(): WsResponse<{ ts: string }> {
    return { event: NOTIFICATIONS_WS_EVENTS.PONG, data: { ts: new Date().toISOString() } };
  }

  /** Emits `notification.created` to every socket of `userId` (all tabs, all replicas). */
  pushToUser(userId: string, notification: NotificationResponse): void {
    this.server.to(userRoom(userId)).emit(NOTIFICATIONS_WS_EVENTS.CREATED, notification);
  }

  /** Mirrors graphql-ws (`scheduleExpiry`): the socket ends when its access token does. */
  private scheduleExpiry(client: NotificationsSocket, expEpochSec: number): void {
    const delayMs = Math.min(Math.max(0, expEpochSec * 1_000 - Date.now()), MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      this.endSession(client, AuthErrorCode.TOKEN_EXPIRED, 'Token has expired');
    }, delayMs);
    timer.unref();
    this.expiryTimers.set(client, timer);
  }

  /**
   * Tells the client why (`exception` with the problem details, so it refreshes or re-logs in),
   * then disconnects it. A server-side disconnect is not retried by socket.io clients on their own.
   */
  private endSession(client: NotificationsSocket, code: AuthErrorCode, detail: string): void {
    const problem = toProblemDetails(new UnauthenticatedException(detail, { code }), {
      exposeInternal: false,
    });
    client.emit(NOTIFICATIONS_WS_EVENTS.EXCEPTION, problem);
    client.disconnect(true);
  }
}
