import {
  AccessTokenDenylist,
  type AuthUser,
  authenticateSocket,
  CurrentUser,
  extractSocketToken,
  Permission,
  RequirePermissions,
  TokenService,
} from '@app/auth';
import { toProblemDetails } from '@app/common';
import { Throttle, WsThrottlerGuard } from '@app/redis';
import { Logger, UseGuards } from '@nestjs/common';
import {
  MessageBody,
  type OnGatewayConnection,
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

/**
 * socket.io namespace `/notifications`.
 * - Handshake: a namespace middleware verifies the access token (`auth.token`, or
 *   `Authorization: Bearer`) once, including the revocation denylist, BEFORE the connection is
 *   accepted — so no message can race the authentication. A refused client gets `connect_error`
 *   whose `data` is the problem details (`code` MISSING_TOKEN / TOKEN_EXPIRED / …).
 * - Connection: the socket joins room `user:<id>`.
 * - Messages: the global guards run per message (`JwtAuthGuard` checks `socket.data.user` is
 *   still unexpired, then RBAC), plus per-message throttling (`WsThrottlerGuard`, Redis-backed).
 * - Pushes: `NotificationPushConsumer` calls `pushToUser`; with `RedisIoAdapter` the room emit
 *   reaches the user's sockets on every replica.
 */
@UseGuards(WsThrottlerGuard)
@WebSocketGateway({ namespace: NOTIFICATIONS_WS_NAMESPACE })
export class NotificationsGateway
  implements OnGatewayInit<NotificationsNamespace>, OnGatewayConnection<NotificationsSocket>
{
  private readonly logger = new Logger(NotificationsGateway.name);

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
}
