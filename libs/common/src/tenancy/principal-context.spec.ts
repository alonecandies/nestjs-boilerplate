import { ClsServiceManager } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';
import { UnauthenticatedException } from '../errors/domain.exception.js';
import { createPrincipal } from './principal.js';
import {
  CLS_PRINCIPAL,
  getPrincipal,
  requirePrincipal,
  runWithPrincipal,
  setPrincipal,
} from './principal-context.js';

const USER = '0190f3b2-0000-7000-8000-000000000001';
const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';
const REQUEST = Symbol('request');
const cls = ClsServiceManager.getClsService();

const errorOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('principal context', () => {
  it('is empty outside a CLS context, and setPrincipal refuses to run there', () => {
    expect(getPrincipal()).toBeUndefined();
    expect(() => requirePrincipal()).toThrow(UnauthenticatedException);
    expect(() => setPrincipal(createPrincipal({ userId: USER, tenantId: null }))).toThrow(
      /active CLS context/,
    );
  });

  it('stores the principal under CLS_PRINCIPAL in the active context', () => {
    const principal = createPrincipal({ userId: USER, tenantId: TENANT, roles: ['member'] });
    cls.run(() => {
      setPrincipal(principal);
      expect(getPrincipal()).toBe(principal);
      expect(requirePrincipal()).toBe(principal);
      expect(cls.get(CLS_PRINCIPAL)).toBe(principal);
    });
  });

  it('answers 401 PRINCIPAL_MISSING inside a context that has none', () => {
    cls.run(() => {
      expect(errorOf(() => requirePrincipal())).toMatchObject({ code: 'PRINCIPAL_MISSING' });
    });
  });

  it('runWithPrincipal scopes the principal to a child context that keeps the parent values', async () => {
    const outer = createPrincipal({ userId: USER, tenantId: null });
    const inner = createPrincipal({ userId: USER, tenantId: TENANT, roles: ['owner'] });
    await cls.run(async () => {
      cls.set(REQUEST, 'r-1');
      setPrincipal(outer);
      const seen = await runWithPrincipal(inner, async () => {
        await Promise.resolve();
        return { principal: getPrincipal(), request: cls.get<string>(REQUEST) };
      });
      expect(seen).toEqual({ principal: inner, request: 'r-1' });
      expect(getPrincipal()).toBe(outer);
    });
  });

  it('runWithPrincipal opens a context when none is active', () => {
    const principal = createPrincipal({ userId: USER, tenantId: TENANT });
    expect(runWithPrincipal(principal, () => getPrincipal())).toBe(principal);
    expect(getPrincipal()).toBeUndefined();
  });
});
