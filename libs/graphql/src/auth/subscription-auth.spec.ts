import type { AccessTokenDenylist, AuthUser, TokenService } from '@app/auth';
import { UnauthenticatedException } from '@app/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GqlWsConnectionContext } from '../context/gql-context.js';
import {
  createGraphqlWsAuthHandlers,
  createSubscriptionAuthenticator,
  extractConnectionToken,
  WS_CLOSE_TOKEN_EXPIRED,
} from './subscription-auth.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: '0199a3c1-7b2e-7cc0-8f1e-2f7c3b4d5e6f',
    email: 'jane@example.com',
    roles: [],
    permissions: [],
    jti: 'jti-1',
    exp: nowSec() + 900,
    ...overrides,
  };
}

type CloseFn = (code?: number, reason?: string) => void;

function wsContext(connectionParams?: Record<string, unknown>) {
  const close = vi.fn<CloseFn>();
  const ctx: GqlWsConnectionContext = { connectionParams, extra: { socket: { close } } };
  return { ...ctx, extra: Object.assign(ctx.extra, { socket: { close } }) };
}

describe('extractConnectionToken', () => {
  it.each([
    [{ authorization: 'Bearer abc.def.ghi' }, 'abc.def.ghi'],
    [{ Authorization: 'bearer   abc' }, 'abc'],
    [{ token: 'abc' }, 'abc'],
    [{ authToken: ' abc ' }, 'abc'],
    [{ authorization: '', token: 'fallback' }, 'fallback'],
  ])('reads %j', (params, expected) => {
    expect(extractConnectionToken(params)).toBe(expected);
  });

  it.each([[undefined], [{}], [{ authorization: 42 }], [{ authorization: 'Bearer ' }]])(
    'returns undefined for %j',
    (params) => {
      expect(extractConnectionToken(params)).toBeUndefined();
    },
  );
});

describe('createSubscriptionAuthenticator', () => {
  const claims = { sub: 'u1', jti: 'jti-1', exp: nowSec() + 900 };

  function deps(denied = false) {
    const tokens = {
      verifyAccessToken: vi.fn(async () => claims),
      toAuthUser: vi.fn(() => user()),
    };
    const denylist = { isDenied: vi.fn(async () => denied) };
    return {
      tokens,
      denylist,
      authenticate: createSubscriptionAuthenticator(
        tokens as unknown as TokenService,
        denylist as unknown as AccessTokenDenylist,
      ),
    };
  }

  it('verifies the token, checks the denylist and maps to AuthUser', async () => {
    const { tokens, denylist, authenticate } = deps();

    await expect(authenticate('jwt')).resolves.toMatchObject({ jti: 'jti-1' });
    expect(tokens.verifyAccessToken).toHaveBeenCalledWith('jwt');
    expect(denylist.isDenied).toHaveBeenCalledWith('jti-1');
    expect(tokens.toAuthUser).toHaveBeenCalledWith(claims);
  });

  it('rejects revoked (logged-out) tokens', async () => {
    const { authenticate } = deps(true);

    await expect(authenticate('jwt')).rejects.toBeInstanceOf(UnauthenticatedException);
  });
});

describe('createGraphqlWsAuthHandlers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a valid token and exposes the user on ctx.extra', async () => {
    const authenticate = vi.fn(async () => user());
    const handlers = createGraphqlWsAuthHandlers(authenticate);
    const ctx = wsContext({ authorization: 'Bearer good' });

    await expect(handlers.onConnect(ctx)).resolves.toBe(true);
    expect(authenticate).toHaveBeenCalledWith('good');
    expect(ctx.extra.user).toMatchObject({ email: 'jane@example.com' });
    handlers.onClose(ctx);
  });

  it('refuses invalid tokens (graphql-ws then closes with 4403)', async () => {
    const handlers = createGraphqlWsAuthHandlers(async () => {
      throw new UnauthenticatedException('jwt expired');
    });
    const ctx = wsContext({ authorization: 'Bearer bad' });

    await expect(handlers.onConnect(ctx)).resolves.toBe(false);
    expect(ctx.extra.user).toBeUndefined();
  });

  it('allows anonymous sockets unless auth is required', async () => {
    const authenticate = vi.fn(async () => user());

    await expect(createGraphqlWsAuthHandlers(authenticate).onConnect(wsContext())).resolves.toBe(
      true,
    );
    await expect(
      createGraphqlWsAuthHandlers(authenticate, { requireAuth: true }).onConnect(wsContext({})),
    ).resolves.toBe(false);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('closes the socket with 4401 when the access token expires', async () => {
    vi.useFakeTimers();
    const handlers = createGraphqlWsAuthHandlers(async () => user({ exp: nowSec() + 60 }));
    const ctx = wsContext({ token: 'good' });

    await handlers.onConnect(ctx);
    vi.advanceTimersByTime(59_000);
    expect(ctx.extra.socket.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(ctx.extra.socket.close).toHaveBeenCalledWith(
      WS_CLOSE_TOKEN_EXPIRED,
      'Access token expired',
    );
  });

  it('cancels the expiry timer when the socket closes first', async () => {
    vi.useFakeTimers();
    const handlers = createGraphqlWsAuthHandlers(async () => user({ exp: nowSec() + 60 }));
    const ctx = wsContext({ token: 'good' });

    await handlers.onConnect(ctx);
    handlers.onClose(ctx);
    vi.advanceTimersByTime(120_000);

    expect(ctx.extra.socket.close).not.toHaveBeenCalled();
  });
});
