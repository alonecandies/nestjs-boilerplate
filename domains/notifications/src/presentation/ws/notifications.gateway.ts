import { Inject, Logger, type OnModuleDestroy, Optional, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
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
import {
  AccessTokenDenylist,
  AuthErrorCode,
  type AuthUser,
  authenticateSocket,
  CurrentUser,
  extractSocketToken,
  RequirePermissions,
  RevocationSweeper,
  TokenService,
} from '@platform/auth';
import {
  createMaintenanceModeReader,
  DEFAULT_PROBLEM_TYPE_BASE_URL,
  maintenanceProblem,
  type ProblemDetails,
  toProblemDetails,
  UnauthenticatedException,
  UseWsExceptionFilter,
  WsMaintenanceGuard,
} from '@platform/common';
import { type AppConfig, type AuthConfig, appConfig, authConfig } from '@platform/config';
import {
  ConnectionCaps,
  createClientIpResolver,
  RateLimit,
  TOO_MANY_CONNECTIONS,
  WsThrottlerGuard,
} from '@platform/redis';
import type { DefaultEventsMap, ExtendedError, Namespace, Socket } from 'socket.io';
import { NotificationsPort } from '../../application/ports/notifications.port.js';
import {
  NOTIFICATIONS_WS_EVENTS,
  NOTIFICATIONS_WS_NAMESPACE,
  tenantUserRoom,
} from '../../notifications.constants.js';
import { NotificationsPermission } from '../../notifications.permissions.js';
import type { NotificationResponse } from '../http/notifications.dto.js';
import { NOTIFICATIONS_RATE_LIMITS } from '../rate-limit/notifications-rate-limit.js';
import {
  type MarkReadAck,
  type MarkReadMessage,
  markReadMessageSchema,
} from './notifications-ws.schemas.js';
import { WsSessionGuard } from './ws-session.guard.js';

/** `socket.data` of this namespace: the user authenticated at the handshake. */
export interface NotificationsSocketData {
  user?: AuthUser;
  /** The id of this socket's per-user slot (`ConnectionCaps`), released on disconnect. */
  capSlot?: string | undefined;
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

/** `setTimeout` fires at once beyond this delay (~24.8 days), so longer expiries are capped. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * socket.io namespace `/notifications`.
 * - Handshake: a namespace middleware verifies the access token (`auth.token`, or
 *   `Authorization: Bearer`) once, including the revocation denylist, BEFORE the connection is
 *   accepted — so no message can race the authentication. A refused client gets `connect_error`
 *   whose `data` is the problem details (`code` MISSING_TOKEN / TOKEN_EXPIRED / …).
 * - Maintenance mode (the app's `MAINTENANCE_MODE` switch, read at run time like the HTTP
 *   middleware reads it, so a function switch is followed without a restart): the handshake is
 *   refused first, before the IP charge and the token, with `connect_error` whose `data` is the
 *   503 problem (`SERVICE_UNAVAILABLE`), the same document REST clients get. Every message,
 *   `ping` included, is answered with that problem (`WsMaintenanceGuard`, first in this
 *   gateway's guards), and `pushToUser` emits nothing. An open socket is not closed when the
 *   switch turns on: it stays connected and inert until its next message, or until its token
 *   expires.
 * - Connection caps (`ConnectionCaps`, when `AppThrottlerModule` is present): the handshake is
 *   charged to the client IP (`TRUST_PROXY` rules) before the token is read, and the user may hold
 *   `THROTTLE_WS_SOCKETS_PER_USER` sockets at once. Both refuse with `connect_error` whose `data`
 *   is a 429 problem (`RATE_LIMITED` / `TOO_MANY_CONNECTIONS`); both fail open without Redis.
 *   A client that dropped before the slot is taken gets none, and one that drops while the slot
 *   is being taken gets it back at once (socket.io emits neither connect nor disconnect then),
 *   like graphql-ws's `closed` guards.
 * - Connection: the socket joins exactly one room, `t:<tenantId>:u:<userId>` (`tenantUserRoom`),
 *   both from the token it authenticated with. It never changes room: another tenant needs a new
 *   connection with that tenant's token. No message handler joins or leaves a room.
 * - Session lifetime: tokens are short-lived but sockets are not. The socket is sent an
 *   `exception` (TOKEN_EXPIRED) and disconnected when its access token expires. This replica's
 *   `RevocationSweeper` (`socket.io`) disconnects its sockets whose token was revoked (logout or
 *   tenant switch → denylist; `exception` TOKEN_REVOKED): at once on the denylist's revocation
 *   announcement or, for a token revoked during the handshake, on the check `track()` makes after
 *   registering the socket; else at the next sweep (every `WS_REVOCATION_SWEEP_INTERVAL_MS`,
 *   `authConfig`).
 *   Clients reconnect with a fresh token, so pushes stop reaching a session that HTTP would
 *   already reject.
 * - Messages: the global guards run per message (`JwtAuthGuard` checks `socket.data.user` is
 *   still unexpired, then RBAC), then `WsMaintenanceGuard`, `WsSessionGuard` (denylist, like
 *   HTTP) and per-message throttling (`WsThrottlerGuard`, Redis-backed).
 *   Errors (429 included) come back as `{ ok: false, error }` acks or `exception` events
 *   (`@UseWsExceptionFilter`).
 * - Pushes: `NotificationPushConsumer` calls `pushToUser(tenantId, userId, …)` with the envelope
 *   tenant; with `RedisIoAdapter` the room emit reaches that (tenant, user)'s sockets on every
 *   replica.
 */
@UseWsExceptionFilter()
@UseGuards(WsMaintenanceGuard, WsSessionGuard, WsThrottlerGuard)
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
  /** Removes a socket from the sweeper; set at connection, called at disconnect. */
  private readonly untrackers = new WeakMap<NotificationsSocket, () => void>();
  private readonly sweeper: RevocationSweeper;

  @WebSocketServer()
  private readonly server: NotificationsNamespace;

  /** Property-injected so the client IP follows `TRUST_PROXY`; unset in unit tests. */
  @Optional()
  @Inject(appConfig.KEY)
  private readonly app?: AppConfig;

  /** Property-injected to read the maintenance switch at run time; unset in unit tests (off). */
  @Optional()
  @Inject(ModuleRef)
  private readonly moduleRef?: ModuleRef;

  private maintenanceReader: (() => boolean) | undefined;

  private clientIp: ReturnType<typeof createClientIpResolver> | undefined;

  constructor(
    private readonly tokens: TokenService,
    private readonly denylist: AccessTokenDenylist,
    private readonly notifications: NotificationsPort,
    @Inject(authConfig.KEY) auth: AuthConfig,
    // Explicit token: an optional parameter must not rely on emitted metadata.
    @Optional() @Inject(ConnectionCaps) private readonly caps?: ConnectionCaps,
  ) {
    this.sweeper = new RevocationSweeper(denylist, {
      name: 'socket.io',
      intervalMs: auth.wsRevocationSweepIntervalMs,
    });
  }

  afterInit(namespace: NotificationsNamespace): void {
    namespace.use((socket, next) => {
      void this.authenticate(socket).then(next);
    });
    this.sweeper.start();
  }

  onModuleDestroy(): void {
    this.sweeper.stop();
  }

  /** Resolves `undefined` (accept) or the error to refuse the handshake with. */
  async authenticate(socket: NotificationsSocket): Promise<ExtendedError | undefined> {
    // Before the IP charge and the token: a refused client must cost nothing during maintenance.
    if (this.maintenanceOn()) {
      this.logger.debug(`Refused socket ${socket.id}: maintenance mode`);
      const problem = maintenanceProblem();
      return Object.assign(new Error(problem.detail ?? problem.title), { data: problem });
    }
    try {
      this.clientIp ??= createClientIpResolver(this.app?.trustProxy ?? false);
      const ip = this.clientIp(socket.request) ?? socket.handshake?.address;
      const verdict = (await this.caps?.admitHandshake(ip)) ?? { ok: true as const };
      if (!verdict.ok) {
        return this.refuse('RATE_LIMITED', 'Too many connection attempts. Please retry later.');
      }
      socket.data.user = await authenticateSocket(
        this.tokens,
        this.denylist,
        extractSocketToken(socket.handshake),
      );
      if (this.caps !== undefined) {
        if (socket.conn.readyState !== 'open') {
          // The client dropped while its token was verified: nothing was acquired, so take no
          // slot (socket.io emits neither connect nor disconnect for it), like graphql-ws.
          return new Error('Client disconnected during the handshake');
        }
        const { id: userId, exp } = socket.data.user;
        const slot = await this.caps.acquireSocket(userId, exp);
        if (!slot.admitted) {
          return this.refuse(TOO_MANY_CONNECTIONS, 'Too many open connections for this user.');
        }
        if (socket.conn.readyState !== 'open') {
          // The client dropped during the handshake: socket.io discards the socket without a
          // connect or disconnect event, so `handleDisconnect` would never free this slot.
          void this.caps.releaseSocket(userId, slot.id);
          return new Error('Client disconnected during the handshake');
        }
        // Released at disconnect even when admitted while Redis was unusable: its reply may have
        // been lost after the slot was counted, and releasing a slot never counted frees nothing.
        socket.data.capSlot = slot.id;
      }
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
    // Tracked before the await, so a socket that drops while joining is untracked too.
    this.untrackers.set(
      client,
      this.sweeper.track({
        jti: user.jti,
        end: () => {
          this.endSession(client, AuthErrorCode.TOKEN_REVOKED, 'Token has been revoked');
        },
      }),
    );
    this.scheduleExpiry(client, user.exp);
    await client.join(tenantUserRoom(user.tenantId, user.id));
  }

  handleDisconnect(client: NotificationsSocket): void {
    clearTimeout(this.expiryTimers.get(client));
    this.expiryTimers.delete(client);
    this.untrackers.get(client)?.();
    this.untrackers.delete(client);
    const slotId = client.data.capSlot;
    if (slotId !== undefined && client.data.user) {
      client.data.capSlot = undefined;
      void this.caps?.releaseSocket(client.data.user.id, slotId);
    }
  }

  /**
   * One sweep: disconnects this replica's sockets whose access token is on the denylist (logout,
   * tenant switch); each replica sweeps its own sockets, so it works the same in every topology.
   * The sweeper runs it every `WS_REVOCATION_SWEEP_INTERVAL_MS` as the fallback for a revocation
   * announcement this replica missed (the announcement closes the sockets at once). Delegates to
   * the shared `RevocationSweeper` (one EXISTS per distinct token; a denylist error keeps every
   * socket until the next sweep while `WsSessionGuard` still refuses its messages). Resolves the
   * number of sockets disconnected.
   */
  disconnectRevokedSockets(): Promise<number> {
    return this.sweeper.sweep();
  }

  /** Marks a notification read; the return value is the socket.io ack. */
  @SubscribeMessage(NOTIFICATIONS_WS_EVENTS.MARK_READ)
  @RequirePermissions(NotificationsPermission.Read)
  @RateLimit(NOTIFICATIONS_RATE_LIMITS.MARK_READ)
  async markRead(
    @MessageBody({ schema: markReadMessageSchema }) body: MarkReadMessage,
    @CurrentUser() user: AuthUser,
  ): Promise<MarkReadAck> {
    // The (tenant, user) inbox of the token this socket authenticated with.
    await this.notifications.markRead({
      tenantId: user.tenantId,
      userId: user.id,
      notificationId: body.id,
    });
    return { ok: true };
  }

  /** Application-level liveness check, answered with a `pong` event. */
  @SubscribeMessage(NOTIFICATIONS_WS_EVENTS.PING)
  ping(): WsResponse<{ ts: string }> {
    return { event: NOTIFICATIONS_WS_EVENTS.PONG, data: { ts: new Date().toISOString() } };
  }

  /**
   * Emits `notification.created` to every socket of `userId` signed in to `tenantId` (all tabs,
   * all replicas); the same user's sockets in another tenant receive nothing. While maintenance is
   * on it emits nothing and returns: it never throws, because it runs inside the push consumer,
   * where a throw would dead-letter the event.
   */
  pushToUser(tenantId: string, userId: string, notification: NotificationResponse): void {
    if (this.maintenanceOn()) {
      this.logger.debug(`Push ${notification.id} not emitted: maintenance mode`);
      return;
    }
    this.server
      .to(tenantUserRoom(tenantId, userId))
      .emit(NOTIFICATIONS_WS_EVENTS.CREATED, notification);
  }

  /** The app's maintenance switch, read now (`createMaintenanceModeReader`; no `ModuleRef`: off). */
  private maintenanceOn(): boolean {
    this.maintenanceReader ??=
      this.moduleRef === undefined ? () => false : createMaintenanceModeReader(this.moduleRef);
    return this.maintenanceReader();
  }

  /** A 429 handshake refusal, as a problem document in `connect_error` data. */
  private refuse(code: string, detail: string): ExtendedError {
    const problem: ProblemDetails = {
      type: `${DEFAULT_PROBLEM_TYPE_BASE_URL}${code.toLowerCase().replaceAll('_', '-')}`,
      title: 'Too Many Requests',
      status: 429,
      code,
      detail,
    };
    this.logger.debug(`Refused socket handshake: ${code}`);
    return Object.assign(new Error(detail), { data: problem });
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
