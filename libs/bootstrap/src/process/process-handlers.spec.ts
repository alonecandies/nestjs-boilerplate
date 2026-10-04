import type { LoggerService } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { armShutdownTimer, installProcessHandlers } from './process-handlers.js';

type Listener = (...args: unknown[]) => void;

describe('installProcessHandlers', () => {
  let logger: { [K in 'log' | 'error' | 'warn' | 'fatal']: ReturnType<typeof vi.fn> };
  let exit: MockInstance<typeof process.exit>;
  let registered: Map<string, Listener>;
  let uninstall: (() => void) | undefined;

  /**
   * The handlers are invoked directly instead of via `process.emit`: emitting a real
   * uncaughtException/unhandledRejection would also trip Vitest's own handlers.
   */
  const handler = (event: string): Listener => {
    const listener = registered.get(event);
    if (listener === undefined) throw new Error(`no ${event} listener`);
    return listener;
  };

  beforeEach(() => {
    logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), fatal: vi.fn() };
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    registered = new Map();
    const on = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      registered.set(String(event), listener as Listener);
      return on(event, listener);
    });
  });

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('logs uncaught exceptions as fatal and exits with 1 after flushing', async () => {
    uninstall = installProcessHandlers(logger as LoggerService);
    const error = new Error('kaboom');
    handler('uncaughtException')(error, 'uncaughtException');

    expect(logger.fatal).toHaveBeenCalledWith(error, 'Process (uncaughtException)');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('treats unhandled rejections the same by default, wrapping non-errors', async () => {
    uninstall = installProcessHandlers(logger as LoggerService);
    handler('unhandledRejection')('just a string');

    const [logged] = logger.fatal.mock.calls[0] as [Error];
    expect(logged).toBeInstanceOf(Error);
    expect(logged.message).toBe('Unhandled rejection: just a string');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('can log unhandled rejections without exiting', () => {
    uninstall = installProcessHandlers(logger as LoggerService, {
      exitOnUnhandledRejection: false,
    });
    handler('unhandledRejection')(new Error('late'));
    expect(logger.error).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it('routes process warnings to the logger', () => {
    uninstall = installProcessHandlers(logger as LoggerService);
    handler('warning')(
      Object.assign(new Error('too many listeners'), { name: 'MaxListenersExceededWarning' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'MaxListenersExceededWarning: too many listeners',
      'Process',
    );
  });

  it('installs once per process and uninstalls cleanly', () => {
    const before = process.listenerCount('uncaughtException');
    uninstall = installProcessHandlers(logger as LoggerService);
    expect(installProcessHandlers(logger as LoggerService)).toBe(uninstall);
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
    uninstall();
    uninstall = undefined;
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });

  it('arms the forced-exit timer on SIGTERM when a shutdown timeout is set', () => {
    const before = process.listenerCount('SIGTERM');
    uninstall = installProcessHandlers(logger as LoggerService, { shutdownTimeoutMs: 1_000 });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
  });
});

describe('armShutdownTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forces exit(1) when graceful shutdown overruns, without keeping the process alive', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };

    const timer = armShutdownTimer(10_000, logger);
    expect(timer.hasRef()).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect(logger.error).toHaveBeenCalledWith('Graceful shutdown exceeded 10000 ms; forcing exit');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
