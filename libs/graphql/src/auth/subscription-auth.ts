import type { AccessTokenDenylist, AuthUser, TokenService } from '@app/auth';
import { UnauthenticatedException } from '@app/common';
import { Logger } from '@nestjs/common';
import { find, isString, trim } from 'lodash-es';
import type { GqlWsConnectionContext, GqlWsExtra } from '../context/gql-context.js';

/** Verifies a raw access token and returns the authenticated principal. */
export type SubscriptionAuthenticator = (token: string) => Promise<AuthUser>;

/** Close code sent when the access token of a live subscription socket expires. */
export const WS_CLOSE_TOKEN_EXPIRED = 4401;

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
  /** Refuse connections without a token (default `false`: resolvers' guards decide per operation). */
  requireAuth?: boolean;
}

/** `onConnect` / `onClose` handlers for Nest's `subscriptions['graphql-ws']` options. */
export interface GraphqlWsAuthHandlers {
  onConnect(ctx: GqlWsConnectionContext): Promise<boolean>;
  onClose(ctx: GqlWsConnectionContext): void;
}

/**
 * Authenticates graphql-ws connections once, at `connection_init`:
 * - With a valid token, the `AuthUser` goes on `ctx.extra.user`. The context function copies it
 *   into `req.user` for every operation, and guards read it there.
 * - An invalid, expired or revoked token returns `false`. graphql-ws then closes with 4403
 *   Forbidden, so a bad client fails fast instead of on each operation.
 * - Tokens are short-lived but sockets are not. The socket is closed (4401) when the token
 *   expires, and the client must reconnect with a fresh token, so pushes stop reaching a session
 *   that is no longer valid.
 */
export function createGraphqlWsAuthHandlers(
  authenticate: SubscriptionAuthenticator,
  options: GraphqlWsAuthOptions = {},
): GraphqlWsAuthHandlers {
  const logger = new Logger('GraphqlWsAuth');
  const expiryTimers = new WeakMap<GqlWsExtra, NodeJS.Timeout>();

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

  return {
    async onConnect(ctx) {
      const token = extractConnectionToken(ctx.connectionParams);
      if (token === undefined) return !options.requireAuth;
      try {
        const user = await authenticate(token);
        ctx.extra.user = user;
        scheduleExpiry(ctx.extra, user.exp);
        return true;
      } catch (error) {
        logger.debug(
          `Rejected graphql-ws connection: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        return false;
      }
    },
    onClose(ctx) {
      const timer = expiryTimers.get(ctx.extra);
      if (timer !== undefined) clearTimeout(timer);
      expiryTimers.delete(ctx.extra);
    },
  };
}
