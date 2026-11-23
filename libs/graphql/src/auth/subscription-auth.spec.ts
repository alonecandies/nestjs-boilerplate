import {
  type AccessTokenDenylist,
  type AuthUser,
  RevocationSweeper,
  type TokenService,
} from '@platform/auth';
import { UnauthenticatedException } from '@platform/common';
import type { SocketSlot } from '@platform/redis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GqlWsConnectionContext } from '../context/gql-context.js';
import {
  createGraphqlWsAuthHandlers,
  createSubscriptionAuthenticator,
  extractConnectionToken,
  WS_CLOSE_TOKEN_EXPIRED,
  WS_CLOSE_TOKEN_REVOKED,
} from './subscription-auth.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: '0199a3c1-7b2e-7cc0-8f1e-2f7c3b4d5e6f',
    email: 'jane@example.com',
    tenantId: '0199a3c1-7b2e-7cc0-8f1e-2f7c3b4d5e70',
    roles: [],
    staff: false,
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

  it('refuses anonymous sockets by default (no expiry timer, no rate limit would apply)', async () => {
    const authenticate = vi.fn(async () => user());
    const handlers = createGraphqlWsAuthHandlers(authenticate);

    await expect(handlers.onConnect(wsContext())).resolves.toBe(false);
    await expect(handlers.onConnect(wsContext({}))).resolves.toBe(false);
    await expect(
      createGraphqlWsAuthHandlers(authenticate, { requireAuth: true }).onConnect(wsContext({})),
    ).resolves.toBe(false);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('accepts anonymous sockets when auth is explicitly optional (requireAuth: false)', async () => {
    const authenticate = vi.fn(async () => user());
    const ctx = wsContext();

    await expect(
      createGraphqlWsAuthHandlers(authenticate, { requireAuth: false }).onConnect(ctx),
    ).resolves.toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
    expect(ctx.extra.user).toBeUndefined();
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

describe('createGraphqlWsAuthHandlers with a revocation sweeper', () => {
  function sweeperWith(denied: Set<string>) {
    const denylist = { enabled: true, isDenied: vi.fn(async (jti: string) => denied.has(jti)) };
    return new RevocationSweeper(denylist, { name: 'graphql-ws', intervalMs: 30_000 });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes a revoked connection with 4401, the code of expiry', () => {
    expect(WS_CLOSE_TOKEN_REVOKED).toBe(4401);
    expect(WS_CLOSE_TOKEN_REVOKED).toBe(WS_CLOSE_TOKEN_EXPIRED);
  });

  it('tracks an accepted connection and untracks it on close', async () => {
    const sweeper = sweeperWith(new Set());
    const handlers = createGraphqlWsAuthHandlers(async () => user(), { sweeper });
    const ctx = wsContext({ token: 'good' });

    await expect(handlers.onConnect(ctx)).resolves.toBe(true);
    expect(sweeper.size).toBe(1);

    handlers.onClose(ctx);
    handlers.onClose(ctx);
    expect(sweeper.size).toBe(0);
  });

  it('closes a connection whose jti is denied on the next sweep, leaving another jti open', async () => {
    const denied = new Set<string>();
    const sweeper = sweeperWith(denied);
    const authenticate = vi.fn(async (token: string) => user({ jti: `jti-${token}` }));
    const handlers = createGraphqlWsAuthHandlers(authenticate, { sweeper });
    const revoked = wsContext({ token: 'a' });
    const live = wsContext({ token: 'b' });
    await handlers.onConnect(revoked);
    await handlers.onConnect(live);

    denied.add('jti-a');
    await expect(sweeper.sweep()).resolves.toBe(1);

    expect(revoked.extra.socket.close).toHaveBeenCalledTimes(1);
    expect(revoked.extra.socket.close).toHaveBeenCalledWith(
      WS_CLOSE_TOKEN_REVOKED,
      'Access token revoked',
    );
    expect(live.extra.socket.close).not.toHaveBeenCalled();
    expect(sweeper.size).toBe(1);
  });

  it('never tracks a refused or an anonymous connection', async () => {
    const sweeper = sweeperWith(new Set());
    const refusing = createGraphqlWsAuthHandlers(
      async () => {
        throw new UnauthenticatedException('Access token has been revoked');
      },
      { sweeper },
    );
    await expect(refusing.onConnect(wsContext({ token: 'bad' }))).resolves.toBe(false);
    await expect(refusing.onConnect(wsContext())).resolves.toBe(false);

    const optional = createGraphqlWsAuthHandlers(async () => user(), {
      requireAuth: false,
      sweeper,
    });
    await expect(optional.onConnect(wsContext())).resolves.toBe(true);

    expect(sweeper.size).toBe(0);
  });

  it('still closes 4401 Access token expired when the token expires', async () => {
    vi.useFakeTimers();
    const sweeper = sweeperWith(new Set());
    const handlers = createGraphqlWsAuthHandlers(async () => user({ exp: nowSec() + 60 }), {
      sweeper,
    });
    const ctx = wsContext({ token: 'good' });

    await handlers.onConnect(ctx);
    vi.advanceTimersByTime(61_000);

    expect(ctx.extra.socket.close).toHaveBeenCalledWith(
      WS_CLOSE_TOKEN_EXPIRED,
      'Access token expired',
    );
  });

  it('neither tracks nor times a socket that closed while its token was being verified', async () => {
    vi.useFakeTimers();
    const sweeper = sweeperWith(new Set(['jti-1']));
    let resolve: (value: AuthUser) => void = () => undefined;
    const handlers = createGraphqlWsAuthHandlers(
      () =>
        new Promise<AuthUser>((done) => {
          resolve = done;
        }),
      { sweeper },
    );
    const ctx = wsContext({ token: 'good' });

    const connecting = handlers.onConnect(ctx);
    handlers.onClose(ctx);
    resolve(user({ exp: nowSec() + 60 }));
    await connecting;

    expect(sweeper.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tracks nothing and throws nothing without a sweeper', async () => {
    const handlers = createGraphqlWsAuthHandlers(async () => user());
    const ctx = wsContext({ token: 'good' });

    await expect(handlers.onConnect(ctx)).resolves.toBe(true);
    expect(() => {
      handlers.onClose(ctx);
    }).not.toThrow();
    expect(ctx.extra.socket.close).not.toHaveBeenCalled();
  });
});

const SLOT: SocketSlot = { admitted: true, id: 'slot-1' };
const REFUSED: SocketSlot = { admitted: false };
/**
 * Admitted while Redis was unusable: to the caller it looks like any admitted slot. Its reply may
 * have been lost after Redis counted it, so it is released all the same.
 */
const FAILED_OPEN: SocketSlot = { admitted: true, id: 'slot-open' };

describe('connection caps (C-9)', () => {
  const jane = user();

  it('refuses the connection past the per-user socket cap, and releases the same slot on close', async () => {
    const caps = {
      admitHandshake: vi.fn(async () => ({ ok: true as const })),
      acquireSocket: vi.fn(async (): Promise<SocketSlot> => REFUSED),
      releaseSocket: vi.fn(async () => undefined),
    };
    const handlers = createGraphqlWsAuthHandlers(async () => jane, { caps });
    await expect(handlers.onConnect(wsContext({ token: 'ok' }))).resolves.toBe(false);
    expect(caps.admitHandshake).toHaveBeenCalledWith(undefined);
    caps.acquireSocket.mockResolvedValue(SLOT);
    const ctx = wsContext({ token: 'ok' });
    await expect(handlers.onConnect(ctx)).resolves.toBe(true);
    // The slot's deadline follows the token's expiry.
    expect(caps.acquireSocket).toHaveBeenLastCalledWith(jane.id, jane.exp);
    handlers.onClose(ctx);
    handlers.onClose(ctx);
    await vi.waitFor(() => expect(caps.releaseSocket).toHaveBeenCalledWith(jane.id, 'slot-1'));
    expect(caps.releaseSocket).toHaveBeenCalledTimes(1);
  });

  it('refuses a connection from an IP over the handshake limit before authenticating', async () => {
    const authenticate = vi.fn(async () => jane);
    const caps = {
      admitHandshake: vi.fn(async () => ({ ok: false as const, retryAfterSeconds: 5 })),
      acquireSocket: vi.fn(async () => SLOT),
      releaseSocket: vi.fn(async () => undefined),
    };
    const handlers = createGraphqlWsAuthHandlers(authenticate, { caps });
    await expect(handlers.onConnect(wsContext({ token: 'ok' }))).resolves.toBe(false);
    expect(authenticate).not.toHaveBeenCalled();
    expect(caps.acquireSocket).not.toHaveBeenCalled();
  });

  it('releases the slot when the socket closes while the cap is being acquired', async () => {
    let grant: (slot: SocketSlot) => void = () => undefined;
    const caps = {
      admitHandshake: vi.fn(async () => ({ ok: true as const })),
      acquireSocket: vi.fn(
        () =>
          new Promise<SocketSlot>((done) => {
            grant = done;
          }),
      ),
      releaseSocket: vi.fn(async () => undefined),
    };
    const handlers = createGraphqlWsAuthHandlers(async () => jane, { caps });
    const ctx = wsContext({ token: 'ok' });
    const connecting = handlers.onConnect(ctx);
    await vi.waitFor(() => expect(caps.acquireSocket).toHaveBeenCalled());
    handlers.onClose(ctx);
    grant(SLOT);
    await expect(connecting).resolves.toBe(false);
    expect(caps.releaseSocket).toHaveBeenCalledTimes(1);
    expect(caps.releaseSocket).toHaveBeenCalledWith(jane.id, 'slot-1');
  });

  it('releases a slot admitted while Redis was unusable, by its id (a lost reply may have counted it)', async () => {
    const caps = {
      admitHandshake: vi.fn(async () => ({ ok: true as const })),
      acquireSocket: vi.fn(async (): Promise<SocketSlot> => FAILED_OPEN),
      releaseSocket: vi.fn(async () => undefined),
    };
    const handlers = createGraphqlWsAuthHandlers(async () => jane, { caps });
    const ctx = wsContext({ token: 'ok' });
    await expect(handlers.onConnect(ctx)).resolves.toBe(true);
    handlers.onClose(ctx);
    expect(caps.releaseSocket).toHaveBeenCalledWith(jane.id, 'slot-open');
    // Closed while a failed-open slot is being taken: released too.
    let grant: (slot: SocketSlot) => void = () => undefined;
    caps.acquireSocket.mockImplementationOnce(
      () =>
        new Promise<SocketSlot>((done) => {
          grant = done;
        }),
    );
    const late = wsContext({ token: 'ok' });
    const connecting = handlers.onConnect(late);
    await vi.waitFor(() => expect(caps.acquireSocket).toHaveBeenCalledTimes(2));
    handlers.onClose(late);
    grant({ admitted: true, id: 'slot-late' });
    await expect(connecting).resolves.toBe(false);
    expect(caps.releaseSocket).toHaveBeenCalledTimes(2);
    expect(caps.releaseSocket).toHaveBeenLastCalledWith(jane.id, 'slot-late');
  });
});
