import { AccessTokenDenylist, AuthModule } from '@app/auth';
import { UnauthenticatedException } from '@app/common';
import { AppConfigModule } from '@app/config';
import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeRedisModule } from '../../../test/support/edge-test-app.js';
import { USER_ID } from '../../../test/support/fixtures.js';
import { NotificationsGateway } from './notifications.gateway.js';
import { WsSessionGuard } from './ws-session.guard.js';

const nowSec = (): number => Math.floor(Date.now() / 1_000);

function wsContext(user: unknown, type = 'ws'): ExecutionContext {
  return {
    getType: () => type,
    switchToWs: () => ({ getClient: () => ({ data: { user } }) }),
  } as unknown as ExecutionContext;
}

const userWith = (jti: string) => ({
  id: USER_ID,
  email: 'a@b.io',
  roles: [],
  permissions: [],
  jti,
  exp: nowSec() + 900,
});

describe('WsSessionGuard', () => {
  let denylist: AccessTokenDenylist;
  let guard: WsSessionGuard;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        FakeRedisModule,
        AuthModule.forRootAsync({ globalGuards: false }),
      ],
    }).compile();
    denylist = moduleRef.get(AccessTokenDenylist);
    guard = new WsSessionGuard(denylist);
  });

  it('guards every message of the notifications gateway, before throttling', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, NotificationsGateway)?.[0]).toBe(WsSessionGuard);
  });

  it('lets a live session through', async () => {
    await expect(guard.canActivate(wsContext(userWith('live')))).resolves.toBe(true);
  });

  it('rejects a socket whose token was revoked after the handshake (logout) — TOKEN_REVOKED', async () => {
    await denylist.deny('logged-out', nowSec() + 900);
    const rejection = guard.canActivate(wsContext(userWith('logged-out')));
    await expect(rejection).rejects.toBeInstanceOf(UnauthenticatedException);
    await expect(rejection).rejects.toMatchObject({ code: 'TOKEN_REVOKED' });
  });

  it('leaves other transports and unauthenticated sockets to the global guards', async () => {
    await denylist.deny('http-jti', nowSec() + 900);
    await expect(guard.canActivate(wsContext(userWith('http-jti'), 'http'))).resolves.toBe(true);
    await expect(guard.canActivate(wsContext(undefined))).resolves.toBe(true);
  });
});
