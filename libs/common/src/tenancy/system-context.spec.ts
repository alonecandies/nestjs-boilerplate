import { ClsServiceManager } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';
import { createPrincipal } from './principal.js';
import { getPrincipal, runWithPrincipal, setPrincipal } from './principal-context.js';
import { SystemContext } from './system-context.js';

const USER = '0190f3b2-0000-7000-8000-000000000001';
const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';
const REASON = 'sample.nightly-purge';
const member = createPrincipal({ userId: USER, tenantId: TENANT, roles: ['member'] });
const cls = ClsServiceManager.getClsService();

describe('SystemContext', () => {
  it('is inactive by default, with or without a CLS context', () => {
    expect(SystemContext.isActive()).toBe(false);
    expect(SystemContext.current()).toBeUndefined();
    cls.run(() => {
      expect(SystemContext.isActive()).toBe(false);
      expect(SystemContext.current()).toBeUndefined();
    });
  });

  it('is active inside run, with the reason, and inactive again after run returns', () => {
    const result = SystemContext.run(REASON, () => {
      expect(SystemContext.isActive()).toBe(true);
      expect(SystemContext.current()).toEqual({ reason: REASON });
      return 'done';
    });
    expect(result).toBe('done');
    expect(SystemContext.isActive()).toBe(false);
    expect(SystemContext.current()).toBeUndefined();
  });

  it('works with no active CLS context (a new one is opened)', () => {
    expect(cls.isActive()).toBe(false);
    SystemContext.run(REASON, () => {
      expect(cls.isActive()).toBe(true);
      expect(SystemContext.isActive()).toBe(true);
    });
    expect(cls.isActive()).toBe(false);
  });

  it('returns what fn returns, also a promise, and stays active across awaits', async () => {
    await expect(
      SystemContext.run(REASON, async () => {
        await Promise.resolve();
        return SystemContext.isActive();
      }),
    ).resolves.toBe(true);
  });

  it('clears the principal inside run even when the parent had one; the parent keeps it', () => {
    runWithPrincipal(member, () => {
      SystemContext.run(REASON, () => {
        expect(getPrincipal()).toBeUndefined();
        expect(SystemContext.isActive()).toBe(true);
      });
      expect(getPrincipal()).toBe(member);
      expect(SystemContext.isActive()).toBe(false);
    });
  });

  it('a nested runWithPrincipal ends system status, and run restores it afterwards', () => {
    SystemContext.run(REASON, () => {
      runWithPrincipal(member, () => {
        expect(getPrincipal()).toBe(member);
        expect(SystemContext.isActive()).toBe(false);
        expect(SystemContext.current()).toBeUndefined();
      });
      expect(SystemContext.isActive()).toBe(true);
    });
  });

  it('setPrincipal inside run ends system status for the rest of that context', () => {
    SystemContext.run(REASON, () => {
      setPrincipal(member);
      expect(SystemContext.isActive()).toBe(false);
    });
  });

  it('a nested run takes the inner reason, and the outer one is back afterwards', () => {
    SystemContext.run(REASON, () => {
      SystemContext.run('sample.inner-job', () => {
        expect(SystemContext.current()).toEqual({ reason: 'sample.inner-job' });
      });
      expect(SystemContext.current()).toEqual({ reason: REASON });
    });
  });

  it.each([
    ['an empty string', ''],
    ['no job part', 'sample'],
    ['an empty job', 'sample.'],
    ['whitespace', 'sample. purge'],
    ['a number', 42],
    ['undefined', undefined],
  ])('rejects a reason that is not <domain>.<job> (%s) without running fn', (_label, reason) => {
    let ran = false;
    expect(() =>
      SystemContext.run(reason as string, () => {
        ran = true;
      }),
    ).toThrow(/SystemContext\.run/);
    expect(ran).toBe(false);
  });

  it('the info object cannot be changed from outside', () => {
    SystemContext.run(REASON, () => {
      const info = SystemContext.current();
      expect(Object.isFrozen(info)).toBe(true);
    });
  });
});
