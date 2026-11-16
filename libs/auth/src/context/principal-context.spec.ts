import type { CallHandler } from '@nestjs/common';
import { getPrincipal, PLATFORM_TENANT_ID, UnauthenticatedException } from '@platform/common';
import { ClsServiceManager } from 'nestjs-cls';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { executionContext } from '../guards/execution-context.test.js';
import { makeAuthUser } from '../testing/auth-test.utils.js';
import { PrincipalContextInterceptor } from './principal-context.interceptor.js';
import { principalOf, writePrincipal } from './principal-context.js';

const cls = ClsServiceManager.getClsService();
const inContext = <T>(fn: () => T): T => cls.run(fn);

describe('principalOf / writePrincipal', () => {
  it('maps an AuthUser to a frozen principal of its tenant', () => {
    const user = makeAuthUser({ roles: ['admin'], staff: true });
    expect(principalOf(user)).toEqual({
      userId: user.id,
      tenantId: user.tenantId,
      roles: ['admin'],
      staff: true,
    });
    expect(Object.isFrozen(principalOf(user))).toBe(true);
  });

  it('is a no-op outside a CLS context (never opens one)', () => {
    expect(() => writePrincipal(makeAuthUser())).not.toThrow();
    expect(getPrincipal()).toBeUndefined();
  });

  it('writes inside a context; the same user may move tenant; another user is refused (fail closed)', () => {
    inContext(() => {
      const ada = makeAuthUser();
      writePrincipal(ada);
      expect(getPrincipal()).toMatchObject({ userId: ada.id, tenantId: ada.tenantId });
      const moved = { ...ada, tenantId: '0190f3b2-0000-7000-8000-0000000000a2' };
      writePrincipal(moved);
      expect(getPrincipal()?.tenantId).toBe(moved.tenantId);
      expect(() => writePrincipal(makeAuthUser())).toThrow(UnauthenticatedException);
      expect(getPrincipal()?.userId).toBe(ada.id);
    });
  });

  it('refuses a user that cannot be a principal (platform tenant, non-UUID id): 401 INVALID_PRINCIPAL', () => {
    inContext(() => {
      expect(() => writePrincipal(makeAuthUser({ tenantId: PLATFORM_TENANT_ID }))).toThrow(
        UnauthenticatedException,
      );
      expect(() => writePrincipal(makeAuthUser({ id: 'u-1' }))).toThrow(UnauthenticatedException);
    });
  });
});

describe('PrincipalContextInterceptor', () => {
  const interceptor = new PrincipalContextInterceptor();
  const next = (probe: () => unknown): CallHandler => ({ handle: () => of(probe()) });

  it('writes socket.data.user inside the context RequestContextInterceptor opened (ws)', async () => {
    const user = makeAuthUser();
    const seen = await inContext(() =>
      lastValueFrom(
        interceptor.intercept(
          executionContext('ws', { handler: () => undefined, cls: Object }, { data: { user } }),
          next(() => getPrincipal()),
        ),
      ),
    );
    expect(seen).toMatchObject({ userId: user.id, tenantId: user.tenantId });
  });

  it('keeps a principal the guard already wrote; skips rpc; passes through without a user', async () => {
    const first = makeAuthUser();
    await inContext(async () => {
      writePrincipal(first);
      const other = makeAuthUser();
      const seen = await lastValueFrom(
        interceptor.intercept(
          executionContext(
            'http',
            { handler: () => undefined, cls: Object },
            { headers: {}, user: other },
          ),
          next(() => getPrincipal()?.userId),
        ),
      );
      expect(seen).toBe(first.id);
    });
    const rpc = await inContext(() =>
      lastValueFrom(
        interceptor.intercept(
          executionContext(
            'rpc',
            { handler: () => undefined, cls: Object },
            { headers: {}, user: first },
          ),
          next(() => getPrincipal()),
        ),
      ),
    );
    expect(rpc).toBeUndefined();
    const anonymous = await inContext(() =>
      lastValueFrom(
        interceptor.intercept(
          executionContext('http', { handler: () => undefined, cls: Object }, { headers: {} }),
          next(() => getPrincipal()),
        ),
      ),
    );
    expect(anonymous).toBeUndefined();
  });
});
