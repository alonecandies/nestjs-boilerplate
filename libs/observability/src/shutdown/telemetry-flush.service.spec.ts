import { PinoLogger } from 'nestjs-pino';
import type pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushLogs, TelemetryFlushService } from './telemetry-flush.service.js';

type Writable<T> = { -readonly [K in keyof T]: T[K] };
const pinoLoggerClass = PinoLogger as Writable<typeof PinoLogger>;

describe('flushLogs', () => {
  const originalRoot = PinoLogger.root;

  afterEach(() => {
    pinoLoggerClass.root = originalRoot;
    vi.useRealTimers();
  });

  it('resolves immediately when no pino root logger exists yet', async () => {
    pinoLoggerClass.root = undefined as unknown as pino.Logger;
    await expect(flushLogs()).resolves.toBeUndefined();
  });

  it('waits for pino to drain its buffer', async () => {
    const flush = vi.fn((callback: () => void) => setTimeout(callback, 5));
    pinoLoggerClass.root = { flush } as unknown as pino.Logger;
    await flushLogs();
    expect(flush).toHaveBeenCalledOnce();
  });

  it('gives up after the timeout when the destination is wedged', async () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    pinoLoggerClass.root = { flush } as unknown as pino.Logger;
    const settled = vi.fn();
    const pending = flushLogs(20).then(settled);
    await vi.advanceTimersByTimeAsync(19);
    expect(flush).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled(); // still waiting for the destination
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toHaveBeenCalledOnce(); // gave up exactly at the timeout
  });
});

describe('TelemetryFlushService', () => {
  it('flushes on application shutdown without throwing when telemetry is off', async () => {
    await expect(new TelemetryFlushService().onApplicationShutdown('SIGTERM')).resolves.toBe(
      undefined,
    );
  });
});
