import { Logger } from '@nestjs/common';
import type {
  AccessTokenDenylist,
  AuthUser,
  RevocationSweeper,
  TokenService,
} from '@platform/auth';
import { UnauthenticatedException } from '@platform/common';
import type { ClientIpResolver, ConnectionCaps } from '@platform/redis';
import { find, isString, trim } from 'lodash-es';
import type { GqlWsConnectionContext, GqlWsExtra } from '../context/gql-context.js';

/** Verifies a raw access token and returns the authenticated principal. */
export type SubscriptionAuthenticator = (token: string) => Promise<AuthUser>;

/** Close code sent when the access token of a live subscription socket expires. */
export const WS_CLOSE_TOKEN_EXPIRED = 4401;

/**
 * Close code sent when the access token of a live subscription socket is revoked (logout, tenant
 * switch). The code of `WS_CLOSE_TOKEN_EXPIRED`; the reason is `Access token revoked`.
 */
export const WS_CLOSE_TOKEN_REVOKED = 4401;

/** Connection-param keys accepted for the token, in precedence order (clients differ). */
const TOKEN_PARAMS = ['authorization', 'Authorization', 'token', 'authToken'] as const;

const BEARER = /^Bearer\s+/i;

/**
 * Reads the access token from graphql-ws `connectionParams`. Both
 * `{ authorization: 'Bearer <jwt>' }` and `{ token: '<jwt>' }` are accepted.
 */
export function extractConnectionToken(
  params: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (params === undefined) return undefined;
  const raw = find(
    TOKEN_PARAMS.map((key) => params[key]),
    (value): value is string => isString(value) && trim(value) !== '',
  );
  if (raw === undefined) return undefined;
  const token = trim(raw.replace(BEARER, ''));
  return token === '' ? undefined : token;
}

/**
 * Same checks as the HTTP `JwtStrategy`: signature, issuer, audience and `typ` (TokenService),
 * then the Redis denylist, so a logged-out token can't open a subscription.
 */
export function createSubscriptionAuthenticator(
  tokens: TokenService,
  denylist: AccessTokenDenylist,
): SubscriptionAuthenticator {
  return async (token) => {
    const claims = await tokens.verifyAccessToken(token);
    if (await denylist.isDenied(claims.jti)) {
      throw new UnauthenticatedException('Access token has been revoked');
    }
    return tokens.toAuthUser(claims);
  };
}

export interface GraphqlWsAuthOptions {
  /**
   * Refuse connections without a token (default `true`). Every subscription needs a user, and an
   * anonymous socket is never timed out or rate-limited. Pass `false` only when some subscriptions
   * are public: anonymous sockets are then accepted and each operation's guards decide.
   */
  requireAuth?: boolean;
  /**
   * Tracks each authenticated socket by its token's `jti`, so it is closed (4401 `Access token
   * revoked`) once that token is on the denylist: on the revocation announcement, on the check
   * `track()` makes after registering it (a revocation during the handshake), or at the latest by
   * the sweep. Without it, the denylist is read only at `connection_init`.
   */
  sweeper?: RevocationSweeper;
  /**
   * Connection caps (spec §11): handshakes per client IP, checked before the token is verified,
   * and concurrent sockets per user, a slot taken after it and released in `onClose` by its id.
   * Both fail open when Redis is unusable. Without it, connections are uncapped.
   */
  caps?: Pick<ConnectionCaps, 'admitHandshake' | 'acquireSocket' | 'releaseSocket'>;
  /** Client IP of the upgrade request (follows `TRUST_PROXY`). Default: the socket address. */
  clientIp?: ClientIpResolver;
}

/** `onConnect` / `onClose` handlers for Nest's `subscriptions['graphql-ws']` options. */
export interface GraphqlWsAuthHandlers {
  onConnect(ctx: GqlWsConnectionContext): Promise<boolean>;
  onClose(ctx: GqlWsConnectionContext): void;
}

/**
 * Authenticates graphql-ws connections once, at `connection_init`:
 * - Without a token the connection is refused (4403), unless `requireAuth: false`.
 * - With a valid token, the `AuthUser` goes on `ctx.extra.user`. The context function copies it
 *   into `req.user` for every operation, and guards read it there.
 * - An invalid, expired or revoked token returns `false`. graphql-ws then closes with 4403
 *   Forbidden, so a bad client fails fast instead of on each operation.
 * - Tokens are short-lived but sockets are not. The socket is closed (4401) when the token
 *   expires, and the client must reconnect with a fresh token, so pushes stop reaching a session
 *   that is no longer valid.
 * - With `options.sweeper`, the socket is tracked by its `jti` and closed (4401
 *   `Access token revoked`) after that token is revoked: on the announcement, on the check after
 *   tracking, or by the sweep; `onClose` untracks it.
 * - With `options.caps`, a connection over the per-IP handshake budget or the per-user socket cap
 *   returns `false` too, so to the client a cap refusal looks the same as an auth refusal (4403).
 *   `onClose` releases the socket's slot by its id.
 */
export function createGraphqlWsAuthHandlers(
  authenticate: SubscriptionAuthenticator,
  options: GraphqlWsAuthOptions = {},
): GraphqlWsAuthHandlers {
  const logger = new Logger('GraphqlWsAuth');
  const expiryTimers = new WeakMap<GqlWsExtra, NodeJS.Timeout>();
  const untrackers = new WeakMap<GqlWsExtra, () => void>();
  /** The user and slot id of the socket slot (`caps.acquireSocket`) this connection holds. */
  const acquired = new WeakMap<GqlWsExtra, { userId: string; slotId: string }>();
  const resolveIp: ClientIpResolver = options.clientIp ?? ((r) => r?.socket?.remoteAddress);
  // graphql-ws calls onClose even when the socket closes while onConnect is still verifying.
  const closed = new WeakSet<GqlWsExtra>();

  const scheduleExpiry = (extra: GqlWsExtra, expEpochSec: number): void => {
    const socket = extra.socket;
    if (socket === undefined) return;
    const delayMs = Math.max(0, expEpochSec * 1000 - Date.now());
    const timer = setTimeout(() => {
      socket.close(WS_CLOSE_TOKEN_EXPIRED, 'Access token expired');
    }, delayMs);
    timer.unref();
    expiryTimers.set(extra, timer);
  };

  const trackRevocation = (extra: GqlWsExtra, jti: string): void => {
    const socket = extra.socket;
    if (options.sweeper === undefined || socket === undefined) return;
    const untrack = options.sweeper.track({
      jti,
      end: () => {
        socket.close(WS_CLOSE_TOKEN_REVOKED, 'Access token revoked');
      },
    });
    untrackers.set(extra, untrack);
  };

  return {
    async onConnect(ctx) {
      const ip = resolveIp(ctx.extra.request);
      if (options.caps !== undefined && !(await options.caps.admitHandshake(ip)).ok) return false;
      const token = extractConnectionToken(ctx.connectionParams);
      if (token === undefined) return !(options.requireAuth ?? true);
      try {
        const user = await authenticate(token);
        if (closed.has(ctx.extra)) return false;
        if (options.caps !== undefined) {
          const slot = await options.caps.acquireSocket(user.id, user.exp);
          if (!slot.admitted) return false;
          if (closed.has(ctx.extra)) {
            // Closed while acquiring: onClose already ran and could not see the slot.
            void options.caps.releaseSocket(user.id, slot.id);
            return false;
          }
          // Released at close even when admitted while Redis was unusable: its reply may have
          // been lost after the slot was counted, and releasing a slot never counted frees nothing.
          acquired.set(ctx.extra, { userId: user.id, slotId: slot.id });
        }
        ctx.extra.user = user;
        scheduleExpiry(ctx.extra, user.exp);
        trackRevocation(ctx.extra, user.jti);
        return true;
      } catch (error) {
        logger.debug(
          `Rejected graphql-ws connection: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        return false;
      }
    },
    onClose(ctx) {
      closed.add(ctx.extra);
      untrackers.get(ctx.extra)?.();
      untrackers.delete(ctx.extra);
      const timer = expiryTimers.get(ctx.extra);
      if (timer !== undefined) clearTimeout(timer);
      expiryTimers.delete(ctx.extra);
      const slot = acquired.get(ctx.extra);
      acquired.delete(ctx.extra);
      if (slot !== undefined) void options.caps?.releaseSocket(slot.userId, slot.slotId);
    },
  };
}
