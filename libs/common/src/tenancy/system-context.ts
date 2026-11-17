import { ClsServiceManager } from 'nestjs-cls';
import { CLS_PRINCIPAL, getPrincipal } from './principal-context.js';

/** What a system context is for: `'<domain>.<job>'`, carried into logs and metrics. */
export interface SystemContextInfo {
  readonly reason: string;
}

/** CLS key of the system marker (package-internal: only `SystemContext.run` sets it). */
const CLS_SYSTEM_CONTEXT: unique symbol = Symbol('app:system-context');

/** `'<domain>.<job>'`: lower-case words, then one or more dot-separated job parts. */
const SYSTEM_REASON = /^[a-z][a-z0-9-]*(?:\.[A-Za-z0-9][\w-]*)+$/;

const cls = () => ClsServiceManager.getClsService();

/**
 * Principal-less units of work (spec §9, B3-12): crons, CLIs, maintenance consumers, relays. Only
 * a system context may call a `system`-scope method of `SystemDatabase`; it never opens a runtime
 * transaction (the adapter refuses to BEGIN without a principal).
 */
export const SystemContext = Object.freeze({
  /**
   * Runs `fn` in a child CLS context (a new one when none is active) with the system marker set
   * and `CLS_PRINCIPAL` cleared; the parent's principal is intact afterwards.
   * @throws Error when `reason` is not `'<domain>.<job>'` (before `fn` runs)
   */
  run<T>(reason: string, fn: () => T): T {
    if (typeof reason !== 'string' || !SYSTEM_REASON.test(reason)) {
      throw new Error("SystemContext.run: the reason must be '<domain>.<job>'");
    }
    const info: SystemContextInfo = Object.freeze({ reason });
    const store = cls();
    return store.run({ ifNested: 'inherit' }, () => {
      store.set(CLS_PRINCIPAL, undefined);
      store.set(CLS_SYSTEM_CONTEXT, info);
      return fn();
    });
  },

  /** True only when the marker is set and no principal is: a nested runWithPrincipal() ends it. */
  isActive(): boolean {
    return SystemContext.current() !== undefined;
  },

  /** The active system context's info, or undefined when `isActive()` is false. */
  current(): SystemContextInfo | undefined {
    const store = cls();
    if (!store.isActive() || getPrincipal() !== undefined) return undefined;
    return store.get<SystemContextInfo | undefined>(CLS_SYSTEM_CONTEXT);
  },
});
